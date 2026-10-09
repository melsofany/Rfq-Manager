/**
 * AI Assistant — async job queue (P3/P6).
 *
 * A year-long email census, hundreds of attachments, or a large comparison cannot
 * finish inside a WhatsApp reply budget (~150s), and the operator must not be left
 * staring at silence. Such work becomes a tracked JOB: created immediately, run in
 * the background, its progress written to the DB, and the result announced when it
 * completes. A follow-up question can then read the finished job instead of
 * re-running the scan.
 *
 * Deliberately in-process, not a new paid service: the prompt is explicit that a
 * new external dependency (Redis/queue) must not be added without a measured need,
 * and this app is a single Render web service. The queue is therefore a small
 * concurrency-limited runner over the SAME process, with durable job ROWS so
 * progress and results survive a restart even though the runner itself does not.
 * If concurrency ever outgrows one process the runner can be swapped for a real
 * worker without touching the callers — they only know `createJob`/`getJob`.
 */
import { describeLineExtras, normalizeLineExtras } from "./item-filter";
import { db, aiAssistantJobsTable } from "@workspace/db";
import { and, eq, gte, inArray, desc, or, sql } from "drizzle-orm";
import { logger } from "../../shared/logger";
import { isQuotaError } from "./llm";
import {
  buildScanReport,
  describeStopReason,
  scanReportProgress,
  type ScanReport,
} from "./scan-report";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  /**
   * The work finished, but its DELIVERABLE could not be delivered (the PDF
   * upload/send failed). Distinct from `completed` on purpose: the live defect
   * was a job that announced "التقرير وصل" while nothing was ever sent, and the
   * operator cannot tell the two apart unless the state does. Also distinct from
   * `failed` — the SCAN succeeded, so the result is kept and can be re-sent.
   */
  | "delivery_failed";

/**
 * Thrown by a job's `finish` callback when the result was produced but could
 * not be delivered. The runner records `delivery_failed` (keeping the partial
 * result) instead of `completed`, so the operator is told the truth.
 */
export class JobDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobDeliveryError";
  }
}

export interface JobRecord {
  id: number;
  phone: string;
  kind: string;
  status: JobStatus;
  question: string | null;
  params: unknown;
  progress: Record<string, unknown> | null;
  result: unknown;
  error: string | null;
  jobKey: string | null;
  /** How many times this job has been attempted (bounded requeue on quota). */
  attempts: number;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** How many jobs may run at once. Keeps one big scan from starving the webhook. */
const MAX_CONCURRENT_JOBS = Number(process.env.AI_JOB_CONCURRENCY) || 2;

/** In-process set of running jobs (for drain-on-shutdown, as with the handler). */
const running = new Set<Promise<void>>();

function toRecord(r: any): JobRecord {
  return {
    id: Number(r.id),
    phone: String(r.phone),
    kind: String(r.kind),
    status: r.status as JobStatus,
    question: r.question ?? null,
    params: r.params ?? null,
    progress: (r.progress as Record<string, unknown> | null) ?? null,
    result: r.result ?? null,
    error: r.error ?? null,
    jobKey: r.jobKey ?? null,
    attempts: Number(r.attempts ?? 0),
    startedAt: r.startedAt ?? null,
    finishedAt: r.finishedAt ?? null,
  };
}

/**
 * How long a COMPLETED job still answers for an identical request.
 *
 * Live (jobs 395 → 396, 80 seconds apart): the same census was started twice
 * because the dedupe only looked at jobs still running, and the first had
 * finished a moment earlier. Re-scanning the same mailbox minutes later costs
 * the same time and can only disagree with the stored report. Beyond the window
 * a new run is the honest answer, since mail may have arrived since.
 */
export const REUSE_COMPLETED_WINDOW_MS = 30 * 60 * 1000;

/**
 * Find a job for the same key that a new request should join instead of starting
 * a second copy of an expensive scan: a live one (queued/running) at any age, or
 * a completed one that finished within {@link REUSE_COMPLETED_WINDOW_MS}.
 */
export async function findActiveJobByKey(
  jobKey: string,
  now: Date = new Date(),
): Promise<JobRecord | null> {
  const recentSince = new Date(now.getTime() - REUSE_COMPLETED_WINDOW_MS);
  const rows = (await (db as any)
    .select()
    .from(aiAssistantJobsTable)
    .where(
      and(
        eq(aiAssistantJobsTable.jobKey, jobKey),
        or(
          inArray(aiAssistantJobsTable.status, ["queued", "running"]),
          and(
            eq(aiAssistantJobsTable.status, "completed"),
            gte(aiAssistantJobsTable.finishedAt, recentSince),
          ),
        ),
      ),
    )
    .orderBy(desc(aiAssistantJobsTable.id))
    .limit(1)) as any[];
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function getJob(id: number): Promise<JobRecord | null> {
  const rows = (await (db as any)
    .select()
    .from(aiAssistantJobsTable)
    .where(eq(aiAssistantJobsTable.id, id))
    .limit(1)) as any[];
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listJobs(phone: string, limit = 10): Promise<JobRecord[]> {
  const rows = (await (db as any)
    .select()
    .from(aiAssistantJobsTable)
    .where(eq(aiAssistantJobsTable.phone, phone))
    .orderBy(desc(aiAssistantJobsTable.createdAt))
    .limit(limit)) as any[];
  return rows.map(toRecord);
}

/**
 * Ask a background job to stop.
 *
 * The operator must be able to call off a long census — a live transcript had
 * them ask to cancel repeatedly and the agent could only answer that no such
 * capability existed, leaving a job that had already produced a wrong report
 * eating the day's work. This flips the row to `cancelled`; the worker observes
 * it between batches and stops, so the request takes effect within one batch
 * rather than at the end of a 60-batch loop.
 */
export async function cancelJob(id: number): Promise<JobRecord | null> {
  const job = await getJob(id);
  if (!job) return null;
  if (job.status !== "queued" && job.status !== "running") return job;
  await updateJob(id, { status: "cancelled" });
  return { ...job, status: "cancelled", finishedAt: new Date() };
}

export async function updateJob(
  id: number,
  patch: {
    status?: JobStatus;
    progress?: Record<string, unknown>;
    result?: unknown;
    error?: string | null;
    attempts?: number;
  },
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status) {
    set.status = patch.status;
    if (patch.status === "running") set.startedAt = new Date();
    if (
      patch.status === "completed" ||
      patch.status === "failed" ||
      patch.status === "delivery_failed"
    )
      set.finishedAt = new Date();
  }
  if (patch.progress !== undefined) set.progress = patch.progress;
  if (patch.result !== undefined) set.result = patch.result;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.attempts !== undefined) set.attempts = patch.attempts;
  await (db as any).update(aiAssistantJobsTable).set(set).where(eq(aiAssistantJobsTable.id, id));
}

export interface CreateJobOpts {
  phone: string;
  kind: string;
  question?: string;
  params?: unknown;
  /** Idempotency key; when set, an active job with the same key is reused. */
  jobKey?: string;
  /**
   * Drive an EXISTING row instead of inserting a new one.
   *
   * A job interrupted by a restart is resumed by re-running its work against the
   * row that already holds the operator's question and params — inserting a
   * second row would duplicate the job and split its progress. `createJob`
   * therefore skips the insert and the idempotency lookup, and the caller gets
   * the same lifecycle (worker, retries, status transitions) as a fresh job.
   */
  existingJobId?: number;
  /** The work. `report` writes progress/result; throwing marks the job failed. */
  run: (helpers: {
    jobId: number;
    report: (progress: Record<string, unknown>) => Promise<void>;
  }) => Promise<{ result?: unknown } | void>;
}

export interface CreateJobResult {
  job: JobRecord;
  /** True when an existing active job with the same key was reused. */
  reused: boolean;
}

/**
 * A job kind's ability to REBUILD its own work from a stored row.
 *
 * The runner is in-process, so a deploy/recycle kills whatever it was doing. The
 * census keeps a durable cursor (`ai_assistant_scan_sessions`) and the row keeps
 * `params` + `question` — everything needed to continue — but `jobs.ts` cannot
 * know how to read a mailbox: that is the tool layer's job. So each kind
 * REGISTERS a runner and the startup sweep resumes it instead of writing it off.
 *
 * Live (job 349): the process was recycled mid-census with 2,264 messages
 * examined and 448 item rows parsed, and the old sweep discarded all of it —
 * «orphaned by a restart — stale cursor reset» for work whose cursor was already
 * in Postgres.
 */
export interface JobRunner {
  /** Rebuild the work for a stored job. Returns null when it cannot be resumed. */
  resume(job: JobRecord): CreateJobOpts | null;
}

/**
 * The scan counters a resume is judged by.
 *
 * A year-long census takes tens of minutes, so a busy deploy day can interrupt
 * it several times. Charging every resume against a fixed attempt budget would
 * then fail a job that was making real progress the whole way — the budget exists
 * to stop a CRASH LOOP, not to cap how many times the operator's work survives a
 * restart. So a resume that ADVANCED these counters resets the budget; one that
 * advanced nothing (the genuine crash-loop shape) spends it.
 */
const PROGRESS_KEYS = ["opened", "scanned", "lines"] as const;

function progressMarkers(job: JobRecord): Record<string, number> {
  const p = (job.progress ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of PROGRESS_KEYS) out[k] = Number(p[k] ?? 0);
  return out;
}

/** True when the job advanced past the markers recorded at its last resume. */
function advancedSinceResume(job: JobRecord): boolean {
  const p = (job.progress ?? {}) as Record<string, unknown>;
  const baseline = p.resumeBaseline as Record<string, number> | undefined;
  if (!baseline) return false;
  const now = progressMarkers(job);
  return PROGRESS_KEYS.some((k) => now[k] > Number(baseline[k] ?? 0));
}

/**
 * Did this job ever do measurable work?
 *
 * Judged by the SCAN COUNTERS, not by `attempts`: a resumed-but-failed job has
 * a non-zero `attempts` while having read nothing at all, and the failure message
 * used `attempts > 0` as its proxy for progress — so a job that crash-looped
 * sixteen times without opening a message was told «النتائج الجزئية محفوظة
 * ويمكن استئناف الحصر من حيث توقف» about results that do not exist. That is the
 * same class of false claim as a census reporting `complete` over an empty scan.
 */
function hasProgressEvidence(job: JobRecord): boolean {
  if (advancedSinceResume(job)) return true;
  const m = progressMarkers(job);
  return PROGRESS_KEYS.some((k) => m[k] > 0);
}

const jobRunners = new Map<string, JobRunner>();

/** Register a kind's resumable runner (called at module load by the tool layer). */
export function registerJobRunner(kind: string, runner: JobRunner): void {
  jobRunners.set(kind, runner);
}

export function hasJobRunner(kind: string): boolean {
  return jobRunners.has(kind);
}

/**
 * Create AND start a job. Returns as soon as the row exists — the caller (the
 * WhatsApp handler) replies to the operator immediately with the job id.
 */
export async function createJob(opts: CreateJobOpts): Promise<CreateJobResult> {
  // Resuming an interrupted job: drive the EXISTING row. No insert, no
  // idempotency lookup — the row already IS this job.
  if (opts.existingJobId) {
    const existing = await getJob(opts.existingJobId);
    if (!existing) throw new Error(`job ${opts.existingJobId} not found for resume`);
    startJobWorker(existing, opts);
    return { job: existing, reused: true };
  }

  if (opts.jobKey) {
    const existing = await findActiveJobByKey(opts.jobKey);
    if (existing) return { job: existing, reused: true };
  }

  const inserted = (await (db as any)
    .insert(aiAssistantJobsTable)
    .values({
      phone: opts.phone,
      kind: opts.kind,
      status: "queued",
      question: opts.question ?? null,
      params: opts.params ?? null,
      jobKey: opts.jobKey ?? null,
    })
    .returning()) as any[];
  const job = toRecord(inserted[0]);

  startJobWorker(job, opts);

  return { job, reused: false };
}

/**
 * Run a job's work in the background, respecting the concurrency cap. Extracted
 * from `createJob` so a RESUMED job is driven by exactly the same lifecycle as a
 * fresh one — one code path, not two.
 */
function startJobWorker(job: JobRecord, opts: CreateJobOpts): void {
  const task = (async () => {
    // A crude but effective gate: wait while at capacity. Jobs are few and long,
    // so polling beats adding a scheduler dependency.
    while (running.size > MAX_CONCURRENT_JOBS) {
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      await updateJob(job.id, { status: "running" });
      const out = await runWithQuotaRetries(opts, job);
      // A job the operator cancelled while it ran must NOT be flipped back to
      // `completed` — the cancellation is the final word on its status.
      const latest = await getJob(job.id);
      if (latest?.status === "cancelled") {
        logger.info({ jobId: job.id, kind: opts.kind }, "AI assistant: job cancelled by operator");
        return;
      }
      if (latest?.status === "failed") {
        // A quota-requeue gave up: the row already carries the reason.
        return;
      }
      // MERGE, never replace. The artifact is written by `finish` (the rich
      // result: report, scope, topItems, delivery ids) and this line used to
      // overwrite it wholesale with the worker's tiny return value — so every
      // NORMALLY-completed job lost its result, while a crashed one kept it.
      // Live proof: job 210 (orphaned) still held `topItems`/`scope`, jobs
      // 211-213 (completed) held only `{complete,cancelled,messageId}`. The
      // operator's «احتفظ بالنتيجة» requirement was broken on the common path.
      const stored = latest?.result as Record<string, unknown> | null | undefined;
      const returned = out?.result as Record<string, unknown> | null | undefined;
      const merged = stored && returned ? { ...stored, ...returned } : (returned ?? stored ?? null);
      await finalizeJob(job.id, { status: "completed", result: merged });
      logger.info({ jobId: job.id, kind: opts.kind }, "AI assistant: job completed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A delivery failure is NOT a job failure: the scan produced a result that
      // is still stored and re-sendable. Recording it as `completed` is the
      // defect that let the assistant claim a report was sent when it was not.
      const status: JobStatus = err instanceof JobDeliveryError ? "delivery_failed" : "failed";
      // The FINAL write must land even across a database blip — job 350's report
      // was delivered while its row stayed `running` because this write (and the
      // handler's own) failed on a restart.
      await finalizeJob(job.id, { status, error: message }).catch((writeErr) =>
        logger.error(
          { err: writeErr, jobId: job.id, status },
          "AI assistant: could not record the job's final status",
        ),
      );
      logger.warn({ err, jobId: job.id, kind: opts.kind, status }, "AI assistant: job failed");
    }
  })();
  running.add(task);
  void task.finally(() => running.delete(task));
}

/** Resolves when every in-flight job has finished (tests + graceful shutdown). */
export async function pendingAiJobs(): Promise<void> {
  while (running.size > 0) {
    await Promise.allSettled([...running]);
  }
}

/**
 * Write a job's FINAL state, retrying a transient connection failure.
 *
 * Found live on job 350: the census completed and the report WAS delivered
 * (summary text + PDF), then the final `completed` write failed with «the
 * database system is not yet accepting connections» — a blip while the service
 * restarted — and the catch handler's own write failed the same way and was
 * swallowed by `.catch(() => {})`. The row then sat `running` with no worker:
 * the orphan lie in its worst form, because the work is done AND delivered
 * while the status claims it is still in progress.
 *
 * The final write is the one that must land: retry it a few times before
 * giving up, so a seconds-long database recovery does not cost the operator a
 * status they cannot trust.
 */
async function finalizeJob(
  id: number,
  patch: Record<string, unknown>,
  attempts = 3,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await updateJob(id, patch as never);
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      logger.warn(
        { jobId: id, attempt: i + 1, err },
        "AI assistant: final job write failed — retrying",
      );
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

/**
 * How many times a job may be re-queued after a RECOVERABLE failure (an AI
 * quota window, a provider outage). Bounded so a permanently broken job cannot
 * retry forever, and the operator sees "failed" rather than an endless queue.
 */
/**
 * How many attempts an interrupted job may have BEFORE it is written off.
 *
 * The `|| 3` was a silent typo of the intended `?? 3`, so `AI_JOB_MAX_ATTEMPTS=0`
 * — the value that means «never give up», the natural setting on a service that
 * redeploys frequently — read as `3`. Jobs 385-390 live on exactly that budget:
 * every deploy ended their run mid-scan, the sweep spent one attempt per
 * restart, and a census that had already advanced (390 reached 4294 envelopes /
 * 3855 matched / 409 lines) was marked `failed — orphaned by a restart` with
 * 3705 messages still to read. The label was also wrong: the cursor had NOT been
 * reset — it sat intact in `ai_assistant_scan_sessions` and the very next call
 * continued from it.
 */
function maxJobAttempts(): number {
  const raw = process.env.AI_JOB_MAX_ATTEMPTS;
  const n = raw === undefined || raw === "" ? 3 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

/**
 * Absolute ceiling on CONSECUTIVE resumes that made no progress.
 *
 * `AI_JOB_MAX_ATTEMPTS=0` means «no limit» so a frequently-redeploying service
 * does not write off a long census that is genuinely advancing. But an unlimited
 * budget also removes the only thing that stopped a job which CANNOT advance:
 * live, job 392 was resumed on every restart (attempts 1 → 16), each run OOMing
 * the instance before its first batch boundary, so the service crash-looped with
 * no operator-visible end. A job that proves progress resets its counter to 1, so
 * this ceiling only ever bites the genuine crash-loop shape. `0` disables it
 * explicitly; the default is finite on purpose.
 */
function resumeHardCap(): number {
  const raw = process.env.AI_JOB_RESUME_MAX_ATTEMPTS;
  const n = raw === undefined || raw === "" ? 10 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

/**
 * Ceiling on the DELIVERY half of a job (producing + sending the report).
 *
 * Found live on job 350: the census finished `complete: true` with 334 messages
 * and 853 items, then sat `running` for over 20 minutes because the WhatsApp
 * send never returned. A job stuck in `finish` is indistinguishable to the
 * operator from one that never ran — the same «promises work that never happens»
 * defect as an orphaned row, only later. Bounding it turns a hang into a
 * `delivery_failed` row that still carries the artifact.
 */
function jobDeliveryTimeoutMs(): number {
  return Number(process.env.AI_JOB_DELIVERY_TIMEOUT_MS) || 90_000;
}

/** Backoff before re-running a requeued job — long enough for a quota to clear. */
function jobRetryDelayMs(): number {
  return Number(process.env.AI_JOB_RETRY_DELAY_MS) || 60_000;
}

/**
 * True when a job failure is worth RETRYING rather than reporting.
 *
 * The distinction is the whole point of the quota work: a census that walked
 * 300 of 480 POs and then hit the day's model quota has done real, DURABLE work
 * (the scan session and cursor are persisted), so failing it discards a result
 * that another provider or a later minute would finish. A malformed request or a
 * code defect is NOT retried — retrying it just multiplies the failure.
 */
export function isRetryableJobError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof JobDeliveryError) return false;
  return (
    isQuotaError(err) ||
    /529|overloaded|capacity|rate limit|too many requests|timeout|timed out|ECONNRESET|ETIMEDOUT/i.test(
      message,
    )
  );
}

/**
 * Run the job body, re-queueing on a recoverable failure.
 *
 * A requeue is recorded on the ROW (`attempts` + `error`) before the retry, so
 * an operator watching the dashboard sees why it is running again instead of a
 * job that silently restarts. When the attempts are spent the failure is
 * reported normally — a retry loop must not hide a real problem.
 */
async function runWithQuotaRetries(
  opts: CreateJobOpts,
  job: JobRecord,
): Promise<{ result?: unknown } | void> {
  const limit = maxJobAttempts();
  let attempts = job.attempts ?? 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await opts.run({
        jobId: job.id,
        report: async (progress) => {
          // Progress is ADVISORY state; the census is the work. A failed
          // progress write once discarded a scan that had already read 300
          // messages and parsed 907 items (job 247 live: a transient
          // `Failed query: update "ai_assistant_jobs"…` that the raw SQL
          // reproduces fine afterwards). Losing a dashboard heartbeat must never
          // destroy minutes of work — only the work itself decides the job's
          // fate. The failure is still logged, so a persistent fault is visible
          // instead of silent.
          await updateJob(job.id, { progress }).catch((err) => {
            logger.warn(
              { jobId: job.id, kind: opts.kind, err },
              "AI assistant: could not record job progress (continuing)",
            );
          });
        },
      });
    } catch (err) {
      if (!isRetryableJobError(err) || attempts + 1 >= limit) throw err;
      attempts += 1;
      const message = err instanceof Error ? err.message : String(err);
      await updateJob(job.id, { attempts, error: message }).catch(() => {});
      logger.warn(
        { jobId: job.id, kind: opts.kind, attempt: attempts, limit, err },
        "AI assistant: job hit a recoverable failure — re-queueing",
      );
      await new Promise((r) => setTimeout(r, jobRetryDelayMs()));
      // The row may have been cancelled while we backed off.
      const latest = await getJob(job.id);
      if (latest?.status === "cancelled") {
        throw err;
      }
      await updateJob(job.id, { status: "running", error: null }).catch(() => {});
    }
  }
}

/**
 * A job row can outlive the process that was running it.
 *
 * The runner is in-process (deliberately — no queue dependency), so a deploy,
 * crash or Render recycle leaves any `running` row claiming to work forever:
 * nothing observes the cancel, nothing writes the result, and the operator waits
 * for a report that cannot arrive — the `running` row is a silent lie.
 *
 * Worse, `findActiveJobByKey` treats `queued`/`running` as active, so re-issuing
 * the SAME request RESUMES the orphan and promises progress that never happens.
 *
 * Called once at startup, BEFORE the webhook serves traffic.
 *
 * A stale row does not have to be written off: a census keeps a durable cursor
 * and the row keeps its `params`, so when its kind has a registered runner the
 * work is CONTINUED from where it stopped. Resuming is charged against the same
 * `attempts` budget as a quota requeue, so a crash-looping job still ends
 * `failed` instead of restarting forever.
 */
export async function markOrphanedJobs(): Promise<number> {
  // The grace must exceed the LONGEST batch, or a job that is genuinely working
  // is swept as an orphan. It was a fixed 90s while the background batch is
  // `AI_CENSUS_JOB_BATCH_MS` (120s), so every long batch raced its own sweep.
  const grace = Math.max(90_000, censusJobBatchMs() + 30_000);
  const cutoff = new Date(Date.now() - grace);
  const stale = and(
    eq(aiAssistantJobsTable.status, "running"),
    sql`${aiAssistantJobsTable.updatedAt} < ${cutoff.toISOString()}`,
  );
  const orphans = (await (db as any)
    .select()
    .from(aiAssistantJobsTable)
    .where(stale)
    .limit(500)) as any[];
  if (orphans.length === 0) return 0;

  const resumable: Array<{ job: JobRecord; opts: CreateJobOpts; attempts: number }> = [];
  const dead: number[] = [];
  for (const row of orphans) {
    const job = toRecord(row);
    const runner = jobRunners.get(job.kind);
    const opts = runner?.resume(job) ?? null;
    // A resume that ADVANCED the scan counters proved it is working, so its
    // budget restarts — otherwise a long census killed by several deploys would
    // fail while making progress the whole way. One that advanced nothing is the
    // crash-loop shape and spends the budget.
    const attempts = advancedSinceResume(job) ? 1 : (job.attempts ?? 0) + 1;
    // Only a job that can PROVE it has work left is resumed: no registered
    // runner, unreadable params, or an exhausted attempt budget all mean the row
    // must stop claiming to run.
    //
    // `maxJobAttempts() === 0` means «no limit» — a service that redeploys often
    // interrupts long censuses by design, and the cursor makes each restart a
    // continuation. A crash-loop is still bounded by the census being unable to
    // advance: `attempts` is only reset to 1 when progress was proven.
    //
    // The unlimited budget is ALSO bounded by `resumeHardCap()`, because a job
    // that cannot even reach its first checkpoint never resets its counter — live,
    // job 392 was resumed 16 times in a row, each attempt OOMing the instance
    // before any progress, and the crash loop had no end the operator could see.
    // The hard cap only ever bites that shape, since real progress resets to 1.
    const attemptLimit = maxJobAttempts();
    const hardCap = resumeHardCap();
    const withinLimit = attemptLimit === 0 ? true : attempts <= attemptLimit;
    const withinHardCap = hardCap === 0 ? true : attempts <= hardCap;
    if (opts && withinLimit && withinHardCap) {
      resumable.push({ job, opts, attempts });
    } else {
      dead.push(job.id);
    }
  }

  if (dead.length) {
    // The message must describe what happened. It used to say «stale cursor
    // reset» while the cursor was intact in `ai_assistant_scan_sessions` and the
    // next call continued from it — the operator read «ضاع المؤشر» about a
    // census that had lost nothing. And a job that PROGRESSED is not dropped
    // silently (that is what left 390 at 3%): its counters are named so the
    // operator can see the work is resumable rather than gone.
    const PARTIAL = "النتائج الجزئية محفوظة ويمكن استئناف الحصر من حيث توقف";
    for (const job of orphans.filter((o) => dead.includes(o.id))) {
      const advanced = hasProgressEvidence(job);
      const p = (job.progress ?? {}) as Record<string, unknown>;
      const reached = Number(p.scanned ?? 0);
      const error = advanced
        ? `توقف العامل مع إعادة تشغيل الخدمة بعد ` +
          `${reached > 0 ? `فحص ${reached} رسالة — ` : ""}${PARTIAL}.`
        : "توقف العامل مع إعادة تشغيل الخدمة قبل أن يبدأ الحصر — أعد المحاولة.";
      await (db as any)
        .update(aiAssistantJobsTable)
        .set({ status: "failed", error })
        .where(
          and(eq(aiAssistantJobsTable.id, job.id), eq(aiAssistantJobsTable.status, "running")),
        );
    }
  }

  for (const { job, opts, attempts } of resumable) {
    // Record the resume AND the markers it will be judged by next time, so a job
    // that keeps dying without progress cannot loop forever across restarts.
    const baseline = progressMarkers(job);
    const progress = {
      ...((job.progress ?? {}) as Record<string, unknown>),
      resumeBaseline: baseline,
    };
    await updateJob(job.id, {
      attempts,
      progress,
      error: "resumed after a restart (continues from the saved cursor)",
    }).catch(() => {});
    logger.warn(
      { jobId: job.id, kind: job.kind, attempts, baseline },
      "AI assistant: resuming a job interrupted by a restart",
    );
    startJobWorker({ ...job, attempts, progress }, { ...opts, existingJobId: job.id });
  }

  logger.warn(
    { resumed: resumable.length, failed: dead.length },
    "AI assistant: orphan sweep — resumed what it could, failed the rest",
  );
  return orphans.length;
}

export async function countJobsByStatus(): Promise<Record<string, number>> {
  const rows = (await (db as any)
    .select({
      status: aiAssistantJobsTable.status,
      n: sql<number>`count(*)::int`,
    })
    .from(aiAssistantJobsTable)
    .groupBy(aiAssistantJobsTable.status)) as any[];
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.status)] = Number(r.n);
  return out;
}

/**
 * Run an item census to completion in the BACKGROUND, writing progress after
 * every batch, and announce the result.
 *
 * Why a job and not a tool call: the scan is resumable precisely because a year
 * of mail cannot be read inside one reply budget, but a resumable tool still
 * makes the OPERATOR drive the resumption («أعد النداء») — they must sit in the
 * chat issuing the same request until the cursor reaches the end, and each of
 * those calls spends the model's scarce daily quota. A job removes the operator
 * from the loop: the worker walks the cursor to the end in one go, the progress
 * is visible on the dashboard, and the finished report arrives on WhatsApp.
 */
export interface CensusJobArgs {
  from?: string;
  subject?: string;
  query?: string;
  sinceDate?: string;
  beforeDate?: string;
  mailbox: string;
  limit?: number;
  /** Which document kind the ranking is about (`po` default, `rfq`, `all`). */
  docKind?: "po" | "rfq" | "all";
  /**
   * A part / brand / Line Item filter applied to the PARSED rows.
   *
   * Required for «البند ده اتطلب كام مرة وكميته الإجمالية؟»: the occurrence count
   * and the summed quantity are only true once EVERY matched document has been
   * opened and filtered — a partial count is a different number, presented as the
   * answer. Live, the operator asked exactly this about the MAICO EZQ 20/4 fan and
   * got five consecutive timeouts, because `contains` was a filter the background
   * path could not carry and the interactive scan could not finish.
   */
  contains?: string;
  /** Exact quantity the matching line must carry (see `item-filter.ts`). */
  qty?: number;
  /** Words that must ALL appear in the matching line. */
  terms?: string[];
}

export async function startCensusJob(opts: {
  phone: string;
  question: string;
  args: CensusJobArgs;
  /**
   * Called by the worker to produce the final WhatsApp payload. MUST return the
   * delivery evidence (the WhatsApp message id) so the job records that the
   * report was actually sent — and MUST throw `JobDeliveryError` when it was
   * produced but not delivered, so the job ends `delivery_failed` rather than
   * claiming success.
   */
  finish: (result: {
    phone: string;
    jobId: number;
    session: unknown;
    /**
     * The run's report — the same ten answers the worker records on the job.
     * Passed IN rather than rebuilt here so the summary text, the PDF and the
     * stored artifact can never disagree with the progress the operator watched.
     */
    report: ScanReport;
    /** Writes the artifact/result onto the job row as it becomes known. */
    save: (patch: { result?: unknown; error?: string | null }) => Promise<void>;
  }) => Promise<{ messageId: string | null } | void>;
  /** Per-batch scan deadline; the worker keeps looping until the census ends. */
  runBatch: (deadline: number) => Promise<{ session: any }>;
  /**
   * Drive an existing row (a census resumed after a restart) instead of creating
   * a new one. Passed straight through to `createJob`.
   */
  existingJobId?: number;
}): Promise<CreateJobResult> {
  // The dedup key lives on `censusJobOpts` (the shared builder), so it applies to
  // every caller — including the model's `start_census_job` tool path, which
  // never reaches this function.
  return createJob({ ...censusJobOpts(opts), existingJobId: opts.existingJobId });
}

/**
 * The census job's options — the ONE place its work is defined.
 *
 * Split out of `startCensusJob` so a job resumed after a restart can run the
 * SAME body against its EXISTING row (`censusJobOpts(...).run({ jobId, report })`)
 * instead of going through `createJob`, which would start a second worker on the
 * same row.
 */
export function censusJobOpts(opts: Parameters<typeof startCensusJob>[0]): CreateJobOpts {
  return {
    phone: opts.phone,
    kind: "email_census",
    question: opts.question,
    params: opts.args,
    /**
     * The dedup key belongs HERE, on the ONE builder every creation path uses.
     *
     * Found live (jobs 351/352): the key was built inside `startCensusJob`, but
     * that function is never called in production — the model's `start_census_job`
     * tool goes `launchCensusJob -> buildCensusJobOpts -> censusJobOpts`, which
     * went straight to `createJob` with NO key. So `job_key` was null on every
     * model-started census, the idempotency lookup never ran, and two identical
     * questions started two full scans of the same mailbox.
     *
     * The guard's own test called `startCensusJob`, so it passed while the live
     * path stayed unguarded — a capability tested on a path that does not run.
     * Keeping the key on the shared builder is what makes it apply to ALL callers.
     */
    jobKey: `census:${opts.args.mailbox}:${opts.args.from ?? ""}:${opts.args.subject ?? ""}:${
      opts.args.query ?? ""
    }:${opts.args.sinceDate ?? ""}:${opts.args.beforeDate ?? ""}:${opts.args.docKind ?? ""}:${
      opts.args.contains ?? ""
    }${
      // Only when a filter is set, so existing keys (and the dedupe of jobs already
      // queued) are unchanged. A different quantity IS a different census.
      opts.args.qty || opts.args.terms?.length
        ? `:${opts.args.qty ?? ""}:${(opts.args.terms ?? []).join("|")}`
        : ""
    }`,
    run: (helpers) => runCensusWork(opts, helpers),
  };
}

/**
 * The census work, extracted from `startCensusJob` so a fresh job and a job
 * RESUMED after a restart run the SAME body. The body reads its state from the
 * persisted scan session, so a resume continues from its cursor rather than
 * re-reading the mailbox.
 */
async function runCensusWork(
  opts: Parameters<typeof startCensusJob>[0],
  { jobId, report }: { jobId: number; report: (p: Record<string, unknown>) => Promise<void> },
): Promise<{ result?: unknown } | void> {
  let session: any;
  const startedAt = Date.now();

  /**
   * Build the job's report from the CURRENT session.
   *
   * Defined once so the per-batch progress and the final artifact can never
   * disagree: they are the same ten answers over the same counters, and a
   * field added here reaches both. `deadline` is a parameter because the
   * per-batch view is measured against that batch's clock while the final
   * artifact has none left to show.
   */
  const reportFor = (deadline: number | null, cancelled: boolean): ScanReport =>
    buildScanReport({
      query: describeCensusSearch(opts.args, opts.question),
      matched: session?.census?.matched ?? 0,
      examined: session?.census?.scope?.scanned ?? session?.examinedEnvelopes ?? 0,
      opened: session?.coverage?.messages ?? 0,
      pdfs: session?.coverage?.attachments ?? 0,
      results: session?.coverage?.lines ?? 0,
      pages: session?.coverage?.pages ?? 0,
      unreadable: session?.coverage?.unreadable ?? 0,
      remaining: session?.remaining ?? 0,
      reachedEnd: Boolean(session?.complete),
      truncatedReason: session?.attachmentCoverage?.truncatedReason ?? null,
      startedAt: Number(session?.startedAt ?? startedAt),
      now: Date.now(),
      deadline,
      cancelled,
    });

  // Bounded rounds: `runBatch` always opens at least one window, so progress
  // is guaranteed, but the cap stops a pathological source (a window that
  // never advances) from looping forever in the background.
  //
  // The windows are counted PER CENSUS, not per worker run. A restart used to
  // restart the count, so a job interrupted by several deploys was cut off after
  // only a few windows in TOTAL — live, job 390 reached 3% of a year (4294 of
  // 7999 envelopes) and was then written off with 3705 messages still unread
  // while its cursor sat intact. Measuring the budget from the beginning is what
  // makes an interruption cost time instead of the whole census.
  const maxBatches = censusJobMaxBatches();
  const batchesDone = Number(session?.batches ?? 0);
  const remainingBatches = remainingCensusBatches(batchesDone);
  // The wall-clock ceiling exists to contain a pathological source, not to cap
  // legitimate work: a year census at ~460ms/message needs hours, and the cursor
  // checkpoints between windows so long runs stay safe. `AI_CENSUS_JOB_MAX_MS=0`
  // disables the ceiling for an operator who wants the census to finish.
  const jobDeadline = censusJobMaxMs() > 0 ? startedAt + censusJobMaxMs() : Infinity;
  let cancelled = false;
  let windowsRun = 0;
  for (let i = 0; i < remainingBatches; i++) {
    // Honour a cancellation between batches: the operator called the job off,
    // so stop and do NOT announce a report for a census they abandoned.
    const current = await getJob(jobId);
    if (current?.status === "cancelled") {
      cancelled = true;
      break;
    }
    if (Date.now() >= jobDeadline) {
      logger.warn(
        { jobId, batchesDone: batchesDone + windowsRun, maxBatches, maxMs: censusJobMaxMs() },
        "AI assistant: census job hit its wall-clock ceiling",
      );
      break;
    }
    const deadline = Date.now() + censusJobBatchMs();
    const out = await opts.runBatch(deadline);
    windowsRun += 1;
    session = out.session;
    // Land the cursor on disk BEFORE the next window. The per-chunk heartbeat is
    // fire-and-forget, so a deploy kills the process with the mirror still
    // holding an older (or contentless) session — live, job 390 read 4294
    // envelopes and left nothing resumable behind. An awaited write at the batch
    // boundary is what makes «استئناف من حيث توقف» true rather than claimed.
    try {
      const { persistScanSessionNow, scanCacheKey } = await import("./email");
      const batchKey = scanCacheKey("items", opts.args as unknown as Record<string, unknown>);
      await persistScanSessionNow(batchKey, session);
    } catch {
      // A persistence failure must not stop the census.
    }
    // ONE report per batch, built from the run's own counters — the operator
    // asks the same ten questions of every job, and answers computed here
    // cannot be omitted by a call site the way `pages` was.
    await report(scanReportProgress(reportFor(deadline, false)));
    if (session?.complete) break;
    // A census with nothing to open makes no further progress: looping would
    // re-read the same empty mailbox until the batch cap. Either the search
    // term matched nothing or the mailbox could not be read, and BOTH are
    // reported by `finish` from the examined count — so stop and let it say
    // which. Without this, a wrong filter made the job spin for ~10 minutes.
    if ((session?.census?.matched ?? 0) === 0) break;
  }
  let messageId: string | null = null;
  // A cancellation or an exhausted first window can leave `session` unset. A
  // job that reports nothing is the «silent lie» the operator complained
  // about, so load the persisted session if there is one — otherwise the
  // report says 0 for a census that may have read thousands.
  if (!session) {
    try {
      const { loadPersistedScanSession, scanCacheKey } = await import("./email");
      const key = scanCacheKey("items", opts.args as unknown as Record<string, unknown>);
      session = await loadPersistedScanSession(key);
    } catch (err) {
      logger.warn({ jobId, err }, "AI assistant: could not load persisted session for report");
    }
  }
  const finalReport = reportFor(null, cancelled);
  if (!cancelled) {
    // Bound the delivery half. A send that never returns must not leave the row
    // `running` forever (job 350 sat 20+ minutes after a complete census).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const out = await Promise.race([
      opts.finish({
        phone: opts.phone,
        jobId,
        session,
        report: finalReport,
        // MERGE the artifact, never replace it.
        //
        // `finish` calls `save` TWICE — once with the full artifact (report,
        // scope, topItems) and once at the end with the delivery ids — and a
        // plain `updateJob` replaced the whole column, so the second call threw
        // the first one away. Live proof on the production rows: the job killed
        // mid-flight (210) still held `topItems` and `scope`, while every job
        // that completed NORMALLY (211-213) kept only
        // `{complete, cancelled, messageId}`. The operator's «احتفظ بالنتيجة»
        // requirement was broken on the common path, and nothing failed loudly
        // because the job still reported success.
        save: async (patch) => {
          if (patch.result === undefined) return updateJob(jobId, patch);
          const current = await getJob(jobId);
          const previous = (current?.result ?? {}) as Record<string, unknown>;
          return updateJob(jobId, {
            ...patch,
            result: { ...previous, ...(patch.result as Record<string, unknown>) },
          });
        },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new JobDeliveryError(`انتهت مهلة إرسال تقرير الحصر (${jobDeliveryTimeoutMs()}ms)`),
            ),
          jobDeliveryTimeoutMs(),
        );
      }),
    ]).finally(() => clearTimeout(timer));
    messageId = out?.messageId ?? null;
  }
  return {
    result: {
      complete: finalReport.complete,
      cancelled,
      // Proof of delivery: the WhatsApp message id. `null` means the report
      // was NOT delivered, so the assistant must not claim it was.
      messageId,
      // The same ten answers, on the artifact, so a follow-up `job_status`
      // reads them instead of recomputing (or inventing) them.
      report: finalReport,
    },
  };
}

/** Per-batch scan budget for background jobs. Longer than the interactive one:
 *  nobody is waiting on a chat reply, so each round can do real work.
 *
 * Raised 60s -> 120s with the concurrent fetch and the 5,000-message window: a
 * background round can now genuinely read a large slice, and the batch cap is
 * what stops a pathological source, not the clock. */
function censusJobBatchMs(): number {
  return Number(process.env.AI_CENSUS_JOB_BATCH_MS) || 120_000;
}

/**
 * Windows of mail ONE census may open, counted across every restart.
 *
 * Read as an integer so `0`/an empty value cannot silently mean something else,
 * and stored on the session (`batches`) so a resumed job continues spending the
 * same budget instead of receiving a fresh one.
 */
export function censusJobMaxBatches(): number {
  const raw = process.env.AI_CENSUS_JOB_MAX_BATCHES;
  const n = raw === undefined || raw === "" ? 120 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 120;
}

/**
 * How many windows a RUNNING worker may still open.
 *
 * Extracted so the rule is testable without a mailbox: the budget belongs to the
 * CENSUS, not to the worker run. Live, job 390 was written off at 3% because
 * every restart received a fresh 120-window allowance while the census had
 * barely started — measuring from the census's own `batches` is what makes an
 * interruption cost time instead of the whole scan.
 */
export function remainingCensusBatches(batchesDone: number): number {
  return Math.max(0, censusJobMaxBatches() - Math.max(0, Number(batchesDone) || 0));
}

/**
 * Wall-clock ceiling for one census (default 4h). `0` disables it.
 *
 * A census of a large mailbox is measured in hours, not minutes: this exists to
 * contain a pathological source, not to truncate legitimate work. The cursor is
 * checkpointed between windows, so a run that stops here is resumable.
 */
function censusJobMaxMs(): number {
  const raw = process.env.AI_CENSUS_JOB_MAX_MS;
  if (raw === undefined || raw === "") return 4 * 60 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 4 * 60 * 60 * 1000;
}

/**
 * What a census was asked to find, in words — the operator's first question
 * («ماذا بحث؟») and the one piece of the report no counter can supply.
 *
 * Built from the args rather than the chat text, so the answer names the filters
 * the scan actually ran with (sender, subject, dates, mailbox) instead of
 * paraphrasing the request. Returns "" when nothing narrowed the scan, so a
 * caller can fall back to the operator's own words rather than printing a
 * meaningless «كل الرسائل» as if it were a search term.
 */
export function describeCensusQuery(args: CensusJobArgs | Record<string, any>): string {
  const a = (args ?? {}) as Record<string, any>;
  const bits: string[] = [];
  if (a.from) bits.push(`من ${String(a.from)}`);
  if (a.subject) bits.push(`موضوع «${String(a.subject)}»`);
  if (a.query) bits.push(`نص «${String(a.query)}»`);
  // The part / brand filter is the defining constraint of a targeted census
  // («البند ده اتطلب كام مرة؟»), so the report must name it — otherwise the ten
  // answers describe a search the operator cannot recognise as their own.
  if (a.contains) bits.push(`بند «${String(a.contains)}»`);
  {
    const extras = describeLineExtras(normalizeLineExtras(a));
    if (extras) bits.push(extras);
  }
  if (a.sinceDate) bits.push(`من تاريخ ${String(a.sinceDate)}`);
  if (a.beforeDate) bits.push(`حتى ${String(a.beforeDate)}`);
  if (a.mailbox) bits.push(`صندوق: ${String(a.mailbox)}`);
  if (a.docKind === "rfq") bits.push("طلبات التسعير");
  else if (a.docKind === "po") bits.push("أوامر الشراء");
  return bits.join(" · ");
}

/** The search filters when they narrowed anything, else the operator's words. */
export function describeCensusSearch(args: CensusJobArgs | Record<string, any>, question?: string) {
  const filters = describeCensusQuery(args);
  if (filters) return filters;
  const q = (question ?? "").trim();
  return q || "كل الرسائل";
}

/** A human-readable Arabic progress line for a running job. */
export function describeJob(job: JobRecord): string {
  const labels: Record<JobStatus, string> = {
    queued: "في الانتظار",
    running: "قيد التنفيذ",
    completed: "اكتملت",
    failed: "فشلت",
    delivery_failed: "فشل الإرسال",
    cancelled: "أُلغيت",
  };
  const p = (job.progress ?? {}) as Record<string, any>;
  const bits: string[] = [];
  const push = (label: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== 0) bits.push(`${label}: ${v}`);
  };
  // The ten answers, when the progress carries them. Old rows recorded only five
  // (`scanned`/`matched`/`attachments`/`items`/`percent`), so each field is
  // emitted only when present — a row written before this change must not read
  // as a scan that found nothing.
  push("البحث عن", p.query);
  push("مطابق", p.matched);
  push("فُحص", p.examined ?? p.scanned);
  push("فُتح", p.opened);
  push("ملفات", p.pdfs ?? p.attachments);
  push("صفحات", p.pages);
  push("نتائج", p.results ?? p.items);
  if (p.elapsedSeconds != null) bits.push(`مضى: ${p.elapsedSeconds} ث`);
  if (p.remainingSeconds != null) bits.push(`متبقٍ: ${p.remainingSeconds} ث`);
  if (p.percent != null) bits.push(`النسبة: ${p.percent}%`);
  if (p.complete === true) bits.push("مكتمل ✅");
  else if (p.complete === false) bits.push(`جزئي — بقي ${p.remaining ?? "?"} رسالة ⚠️`);
  if (p.stopReasonLabel) bits.push(`التوقف: ${p.stopReasonLabel}`);
  return `المهمة #${job.id} (${labels[job.status]})${bits.length ? " — " + bits.join(" · ") : ""}`;
}

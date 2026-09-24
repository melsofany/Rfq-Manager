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
import { db, aiAssistantJobsTable } from "@workspace/db";
import { and, eq, inArray, desc, sql } from "drizzle-orm";
import { logger } from "../../shared/logger";
import { isQuotaError } from "./llm";

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
 * Find an existing non-terminal job for the same key, so re-issuing an identical
 * request RESUMES it instead of starting a second copy of the same expensive scan.
 */
export async function findActiveJobByKey(jobKey: string): Promise<JobRecord | null> {
  const rows = (await (db as any)
    .select()
    .from(aiAssistantJobsTable)
    .where(
      and(
        eq(aiAssistantJobsTable.jobKey, jobKey),
        inArray(aiAssistantJobsTable.status, ["queued", "running"]),
      ),
    )
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
 * Create AND start a job. Returns as soon as the row exists — the caller (the
 * WhatsApp handler) replies to the operator immediately with the job id.
 */
export async function createJob(opts: CreateJobOpts): Promise<CreateJobResult> {
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

  // Start in the background, respecting the concurrency cap. The promise is
  // tracked so tests/shutdown can drain it.
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
      await updateJob(job.id, { status: "completed", result: out?.result ?? null });
      logger.info({ jobId: job.id, kind: opts.kind }, "AI assistant: job completed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A delivery failure is NOT a job failure: the scan produced a result that
      // is still stored and re-sendable. Recording it as `completed` is the
      // defect that let the assistant claim a report was sent when it was not.
      const status: JobStatus = err instanceof JobDeliveryError ? "delivery_failed" : "failed";
      await updateJob(job.id, { status, error: message }).catch(() => {});
      logger.warn({ err, jobId: job.id, kind: opts.kind, status }, "AI assistant: job failed");
    }
  })();
  running.add(task);
  void task.finally(() => running.delete(task));

  return { job, reused: false };
}

/** Resolves when every in-flight job has finished (tests + graceful shutdown). */
export async function pendingAiJobs(): Promise<void> {
  while (running.size > 0) {
    await Promise.allSettled([...running]);
  }
}

/**
 * How many times a job may be re-queued after a RECOVERABLE failure (an AI
 * quota window, a provider outage). Bounded so a permanently broken job cannot
 * retry forever, and the operator sees "failed" rather than an endless queue.
 */
function maxJobAttempts(): number {
  return Number(process.env.AI_JOB_MAX_ATTEMPTS) || 3;
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
          await updateJob(job.id, { progress });
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
 * Called once at startup, BEFORE the webhook serves traffic: a resumed census
 * still has its persisted scan cursor, so re-running it continues from where it
 * stopped rather than re-reading everything.
 */
export async function markOrphanedJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - 90_000); // grace > one batch (45s)
  const orphans = (await (db as any)
    .select()
    .from(aiAssistantJobsTable)
    .where(
      and(
        eq(aiAssistantJobsTable.status, "running"),
        sql`${aiAssistantJobsTable.updatedAt} < ${cutoff.toISOString()}`,
      ),
    )
    .limit(500)) as any[];
  if (orphans.length === 0) return 0;
  await (db as any)
    .update(aiAssistantJobsTable)
    .set({ status: "failed", error: "orphaned by a restart — stale cursor reset" })
    .where(
      and(
        eq(aiAssistantJobsTable.status, "running"),
        sql`${aiAssistantJobsTable.updatedAt} < ${cutoff.toISOString()}`,
      ),
    );
  logger.warn({ count: orphans.length }, "AI assistant: marked orphaned jobs as failed");
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
    /** Writes the artifact/result onto the job row as it becomes known. */
    save: (patch: { result?: unknown; error?: string | null }) => Promise<void>;
  }) => Promise<{ messageId: string | null } | void>;
  /** Per-batch scan deadline; the worker keeps looping until the census ends. */
  runBatch: (deadline: number) => Promise<{ session: any }>;
}): Promise<CreateJobResult> {
  const jobKey = `census:${opts.args.mailbox}:${opts.args.from ?? ""}:${opts.args.subject ?? ""}:${
    opts.args.query ?? ""
  }:${opts.args.sinceDate ?? ""}:${opts.args.beforeDate ?? ""}`;

  return createJob({
    phone: opts.phone,
    kind: "email_census",
    question: opts.question,
    params: opts.args,
    jobKey,
    run: async ({ jobId, report }) => {
      let session: any;
      // A bounded number of rounds: `runBatch` always opens at least one window,
      // so progress is guaranteed, but the cap stops a pathological source (a
      // window that never advances) from looping forever in the background.
      const MAX_BATCHES = Number(process.env.AI_CENSUS_JOB_MAX_BATCHES) || 60;
      let cancelled = false;
      for (let i = 0; i < MAX_BATCHES; i++) {
        // Honour a cancellation between batches: the operator called the job off,
        // so stop and do NOT announce a report for a census they abandoned.
        const current = await getJob(jobId);
        if (current?.status === "cancelled") {
          cancelled = true;
          break;
        }
        const deadline = Date.now() + censusJobBatchMs();
        const out = await opts.runBatch(deadline);
        session = out.session;
        const cov = session?.coverage ?? {};
        const matched = session?.census?.matched ?? 0;
        const scanned = cov.messages ?? 0;
        await report({
          scanned,
          matched,
          attachments: cov.attachments ?? 0,
          items: cov.lines ?? 0,
          // Pages actually rendered, plus the documents whose text could not be
          // read — the operator's progress questions, answered from the run
          // rather than estimated.
          pages: cov.pages ?? 0,
          poDocuments: cov.poDocuments ?? 0,
          rfqDocuments: cov.rfqDocuments ?? 0,
          unreadable: cov.unreadable ?? 0,
          percent: matched > 0 ? Math.min(100, Math.round((scanned / matched) * 100)) : 100,
        });
        if (session?.complete) break;
      }
      let messageId: string | null = null;
      if (!cancelled) {
        const out = await opts.finish({
          phone: opts.phone,
          jobId,
          session,
          save: (patch) => updateJob(jobId, patch),
        });
        messageId = out?.messageId ?? null;
      }
      return {
        result: {
          complete: Boolean(session?.complete) && !cancelled,
          cancelled,
          // Proof of delivery: the WhatsApp message id. `null` means the report
          // was NOT delivered, so the assistant must not claim it was.
          messageId,
        },
      };
    },
  });
}

/** Per-batch scan budget for background jobs. Longer than the interactive one:
 *  nobody is waiting on a chat reply, so each round can do real work. */
function censusJobBatchMs(): number {
  return Number(process.env.AI_CENSUS_JOB_BATCH_MS) || 60_000;
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
  const p = job.progress ?? {};
  const bits: string[] = [];
  const push = (label: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== 0) bits.push(`${label}: ${v}`);
  };
  push("تم فحص", p.scanned);
  push("مطابق", p.matched);
  push("مرفقات", p.attachments);
  push("بنود", p.items);
  push("صفحات", p.pages);
  push("تعذّر قراءتها", p.unreadable);
  push("نسبة التقدم", p.percent != null ? `${p.percent}%` : undefined);
  return `المهمة #${job.id} (${labels[job.status]})${bits.length ? " — " + bits.join(" · ") : ""}`;
}

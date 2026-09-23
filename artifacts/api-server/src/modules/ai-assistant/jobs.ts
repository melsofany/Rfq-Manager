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

/* eslint-disable @typescript-eslint/no-explicit-any */

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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

export async function updateJob(
  id: number,
  patch: {
    status?: JobStatus;
    progress?: Record<string, unknown>;
    result?: unknown;
    error?: string | null;
  },
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status) {
    set.status = patch.status;
    if (patch.status === "running") set.startedAt = new Date();
    if (patch.status === "completed" || patch.status === "failed") set.finishedAt = new Date();
  }
  if (patch.progress !== undefined) set.progress = patch.progress;
  if (patch.result !== undefined) set.result = patch.result;
  if (patch.error !== undefined) set.error = patch.error;
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
      const out = await opts.run({
        jobId: job.id,
        report: async (progress) => {
          await updateJob(job.id, { progress });
        },
      });
      await updateJob(job.id, { status: "completed", result: out?.result ?? null });
      logger.info({ jobId: job.id, kind: opts.kind }, "AI assistant: job completed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updateJob(job.id, { status: "failed", error: message }).catch(() => {});
      logger.warn({ err, jobId: job.id, kind: opts.kind }, "AI assistant: job failed");
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
  /** Called by the worker to produce the final WhatsApp payload. */
  finish: (result: { phone: string; jobId: number; session: unknown }) => Promise<void>;
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
      for (let i = 0; i < MAX_BATCHES; i++) {
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
          percent: matched > 0 ? Math.min(100, Math.round((scanned / matched) * 100)) : 100,
        });
        if (session?.complete) break;
      }
      await opts.finish({ phone: opts.phone, jobId, session });
      return { result: { complete: Boolean(session?.complete) } };
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
  push("نسبة التقدم", p.percent != null ? `${p.percent}%` : undefined);
  return `المهمة #${job.id} (${labels[job.status]})${bits.length ? " — " + bits.join(" · ") : ""}`;
}

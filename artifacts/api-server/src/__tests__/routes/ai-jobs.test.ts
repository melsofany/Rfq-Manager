/**
 * Async job queue (P3/P6).
 *
 * A year-long scan cannot finish inside a WhatsApp reply budget, so it becomes a
 * tracked job whose progress is durable. These tests pin the behaviours the
 * operator depends on: the caller returns immediately, progress is written, a
 * failure marks the job failed (never leaves it "running" forever), and an
 * identical re-issued job RESUMES rather than starting a second expensive scan.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const jobsT = {
  _: "ai_jobs",
  id: "id",
  phone: "phone",
  kind: "kind",
  status: "status",
  jobKey: "jobKey",
  createdAt: "createdAt",
};

let rows: any[] = [];
let nextId = 1;

vi.mock("@workspace/db", () => ({
  db: {
    insert: () => ({
      values: (v: any) => ({
        returning: () => {
          const row = { id: nextId++, ...v };
          rows.push(row);
          return Promise.resolve([row]);
        },
      }),
    }),
    update: () => ({
      set: (v: any) => ({
        where: (w: any) => {
          const id = w?.__eq?.[1];
          const row = rows.find((r) => r.id === id);
          if (row) Object.assign(row, v);
          return Promise.resolve([row]);
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: (w: any) => ({
          orderBy: () => ({
            limit: (n: number) =>
              Promise.resolve(
                rows
                  .filter((r) => r.phone === w?.__eq?.[1])
                  .slice(0, n)
                  .map((r) => ({ ...r })),
              ),
          }),
          limit: () => {
            // Either an id lookup (eq) or the active-job-by-key lookup (and).
            if (w?.__and) {
              const key = w.__and.find((x: any) => x.__eq?.[0] === jobsT.jobKey)?.__eq?.[1];
              const statuses =
                w.__and.find((x: any) => x.__in?.[0] === jobsT.status)?.__in?.[1] ?? [];
              return Promise.resolve(
                rows
                  .filter((r) => r.jobKey === key && statuses.includes(r.status))
                  .slice(0, 1)
                  .map((r) => ({ ...r })),
              );
            }
            const id = w?.__eq?.[1];
            return Promise.resolve(
              rows
                .filter((r) => r.id === id)
                .slice(0, 1)
                .map((r) => ({ ...r })),
            );
          },
        }),
        groupBy: () => Promise.resolve([]),
      }),
    }),
  },
  aiAssistantJobsTable: jobsT,
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: any, val: any) => ({ __eq: [col, val] }),
  and: (...args: any[]) => ({ __and: args }),
  inArray: (col: any, val: any) => ({ __in: [col, val] }),
  desc: (col: any) => ({ __desc: col }),
  sql: Object.assign((..._a: unknown[]) => ({ sql: true }), { join: () => ({}) }),
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  createJob,
  getJob,
  listJobs,
  cancelJob,
  describeJob,
  pendingAiJobs,
  startCensusJob,
  JobDeliveryError,
} = await import("../../modules/ai-assistant/jobs");

describe("async jobs", () => {
  beforeEach(() => {
    rows = [];
    nextId = 1;
  });

  it("returns a job id immediately and runs the work in the background", async () => {
    let ran = false;
    const { job, reused } = await createJob({
      phone: "2010",
      kind: "email_census",
      question: "اعمل حصر",
      run: async () => {
        ran = true;
        return { result: { total: 3710 } };
      },
    });
    expect(reused).toBe(false);
    expect(job.id).toBeGreaterThan(0);
    await pendingAiJobs();
    expect(ran).toBe(true);
    const done = await getJob(job.id);
    expect(done?.status).toBe("completed");
    expect(done?.result).toEqual({ total: 3710 });
  });

  it("writes progress while it runs", async () => {
    const { job } = await createJob({
      phone: "2010",
      kind: "email_items",
      run: async ({ report }) => {
        await report({ scanned: 100, matched: 42 });
      },
    });
    await pendingAiJobs();
    const done = await getJob(job.id);
    expect(done?.progress).toEqual({ scanned: 100, matched: 42 });
  });

  it("REQUEUES a job that hit a quota window instead of failing it", async () => {
    // The operator's reported failure: 300 of 480 POs read, then the day's model
    // quota ran out. The scan cursor is persisted, so the work is not lost — the
    // job must continue rather than be reported as failed.
    process.env.AI_JOB_RETRY_DELAY_MS = "1";
    const { AiError } = await import("../../modules/ai-assistant/llm");
    let calls = 0;
    const { job } = await createJob({
      phone: "2010",
      kind: "email_census",
      run: async () => {
        calls += 1;
        if (calls === 1) throw new AiError("429 quota exceeded (PerDay)", 429);
        return { result: { complete: true } };
      },
    });
    await pendingAiJobs();
    const done = await getJob(job.id);
    expect(calls).toBe(2);
    expect(done?.status).toBe("completed");
    expect(done?.attempts).toBe(1);
  });

  it("gives up (failed) once the requeue attempts are spent, never looping forever", async () => {
    process.env.AI_JOB_RETRY_DELAY_MS = "1";
    process.env.AI_JOB_MAX_ATTEMPTS = "2";
    const { AiError } = await import("../../modules/ai-assistant/llm");
    let calls = 0;
    const { job } = await createJob({
      phone: "2010",
      kind: "email_census",
      run: async () => {
        calls += 1;
        throw new AiError("429 quota exceeded (PerDay)", 429);
      },
    });
    await pendingAiJobs();
    const done = await getJob(job.id);
    expect(calls).toBe(2); // bounded by AI_JOB_MAX_ATTEMPTS
    expect(done?.status).toBe("failed");
    delete process.env.AI_JOB_MAX_ATTEMPTS;
    delete process.env.AI_JOB_RETRY_DELAY_MS;
  });

  it("marks a job failed (never leaves it running) when the work throws", async () => {
    const { job } = await createJob({
      phone: "2010",
      kind: "email_census",
      run: async () => {
        throw new Error("IMAP not configured");
      },
    });
    await pendingAiJobs();
    const done = await getJob(job.id);
    expect(done?.status).toBe("failed");
    expect(done?.error).toContain("IMAP");
  });

  it("RESUMES an active job with the same key instead of starting a second scan", async () => {
    const started = createJob({
      phone: "2010",
      kind: "email_census",
      jobKey: "census:2026:EDC",
      run: async () => {
        await new Promise((r) => setTimeout(r, 20));
      },
    });
    // Give the first job a moment to reach a non-terminal state.
    await new Promise((r) => setTimeout(r, 5));
    const second = await createJob({
      phone: "2010",
      kind: "email_census",
      jobKey: "census:2026:EDC",
      run: async () => {
        throw new Error("must not run a second time");
      },
    });
    expect(second.reused).toBe(true);
    const first = await started;
    expect(second.job.id).toBe(first.job.id);
    await pendingAiJobs();
    // Only one row was ever created.
    expect(rows.filter((r) => r.jobKey === "census:2026:EDC")).toHaveLength(1);
  });

  it("lists a phone's jobs newest-first", async () => {
    await createJob({ phone: "2010", kind: "a", run: async () => {} });
    await createJob({ phone: "2010", kind: "b", run: async () => {} });
    await createJob({ phone: "2099", kind: "other", run: async () => {} });
    await pendingAiJobs();
    const mine = await listJobs("2010");
    expect(mine).toHaveLength(2);
    expect(mine.every((j) => j.phone === "2010")).toBe(true);
  });

  it("describes progress in Arabic for the operator", () => {
    const line = describeJob({
      id: 7,
      phone: "2010",
      kind: "email_census",
      status: "running",
      question: null,
      params: null,
      progress: { scanned: 1842, matched: 318, percent: 61 },
      result: null,
      error: null,
      jobKey: null,
      attempts: 0,
      startedAt: null,
      finishedAt: null,
    });
    expect(line).toContain("#7");
    expect(line).toContain("1842");
    expect(line).toContain("61%");
  });

  it("startCensusJob walks batches to completion, reports progress, and finishes once", async () => {
    let batches = 0;
    let finished = 0;
    const sessionFor = (batch: number) => ({
      census: { matched: 4 },
      coverage: { messages: batch, attachments: batch, lines: batch * 3 },
      items: [{ description: `x${batch}` }],
      complete: batch >= 4,
    });

    const { job } = await startCensusJob({
      phone: "2010",
      question: "حصر كل البريد",
      args: { mailbox: "*" },
      runBatch: async () => {
        batches += 1;
        return { session: sessionFor(batches) };
      },
      finish: async () => {
        finished += 1;
      },
    });
    expect(job.id).toBeGreaterThan(0);
    await pendingAiJobs();
    // 4 batches for a 4-message census, then stop — never an infinite loop.
    expect(batches).toBe(4);
    expect(finished).toBe(1);
    const done = await getJob(job.id);
    expect(done?.status).toBe("completed");
    expect(done?.progress?.percent).toBe(100);
  });

  it("cancelJob stops a running job and the worker does not announce a report", async () => {
    // The operator asked to call a long census off and the agent previously could
    // only answer that no such capability existed. Cancelling must take effect
    // DURING the run (between batches), leave the status `cancelled` rather than
    // flipping it to `completed`, and send no report.
    let batches = 0;
    let finished = 0;
    const { job } = await startCensusJob({
      phone: "2010",
      question: "حصر طويل",
      args: { mailbox: "*" },
      runBatch: async () => {
        batches += 1;
        if (batches === 1) await cancelJob(job.id);
        return {
          session: {
            census: { matched: 10 },
            coverage: { messages: 1 },
            items: [],
            complete: false,
          },
        };
      },
      finish: async () => {
        finished += 1;
      },
    });
    await pendingAiJobs();
    const done = await getJob(job.id);
    expect(done?.status).toBe("cancelled");
    expect(finished).toBe(0);
    // Stopped early — it did not walk all 60 batches of an abandoned census.
    expect(batches).toBe(1);
  });

  it("does not report a completed job as cancelled, and returns null for an unknown id", async () => {
    expect(await cancelJob(999)).toBeNull();
    const { job } = await createJob({
      phone: "2010",
      kind: "x",
      run: async () => ({ result: { ok: true } }),
    });
    await pendingAiJobs();
    const again = await cancelJob(job.id);
    expect(again?.status).toBe("completed");
  });

  it("startCensusJob RESUMES an identical active census instead of double-scanning", async () => {
    const slow = startCensusJob({
      phone: "2010",
      question: "حصر",
      args: { mailbox: "info@", sinceDate: "2026-01-01" },
      runBatch: async () => {
        await new Promise((r) => setTimeout(r, 25));
        return { session: { census: { matched: 1 }, coverage: {}, items: [], complete: false } };
      },
      finish: async () => {},
    });
    await new Promise((r) => setTimeout(r, 5));
    const again = await startCensusJob({
      phone: "2010",
      question: "حصر",
      args: { mailbox: "info@", sinceDate: "2026-01-01" },
      runBatch: async () => {
        throw new Error("must not start a second census");
      },
      finish: async () => {},
    });
    expect(again.reused).toBe(true);
    const first = await slow;
    expect(again.job.id).toBe(first.job.id);
    await pendingAiJobs();
  });

  it("ends delivery_failed — NOT completed — when the report cannot be sent", async () => {
    // The live defect: the job announced «تم إرسال التقرير» while nothing ever
    // arrived, and the operator had no way to tell. A delivery failure is its own
    // terminal state so the claim is impossible.
    const { job } = await createJob({
      phone: "2010",
      kind: "email_census",
      run: async () => {
        throw new JobDeliveryError("تعذّر إرسال التقرير");
      },
    });
    await pendingAiJobs();
    const done = await getJob(job.id);
    expect(done?.status).toBe("delivery_failed");
    expect(done?.error).toContain("تعذّر إرسال التقرير");
    expect(done?.status).not.toBe("completed");
  });

  it("records the delivery proof (messageId) returned by finish", async () => {
    const { job } = await startCensusJob({
      phone: "2010",
      question: "حصر",
      args: { mailbox: "*" },
      runBatch: async () => ({
        session: { census: { matched: 1 }, coverage: { messages: 1 }, items: [], complete: true },
      }),
      finish: async () => ({ messageId: "wamid.ABC" }),
    });
    expect(job.id).toBeGreaterThan(0);
    await pendingAiJobs();
    const done = await getJob((await listJobs("2010", 1))[0].id);
    expect((done?.result as any)?.messageId).toBe("wamid.ABC");
    expect(done?.status).toBe("completed");
  });

  it("keeps the artifact on the job row even when delivery fails", async () => {
    // «النتيجة محفوظة ويمكن إعادة إرسالها» — the whole point of the fix. The
    // result written via `save` must survive the thrown delivery error.
    await startCensusJob({
      phone: "2010",
      question: "حصر",
      args: { mailbox: "*" },
      runBatch: async () => ({
        session: {
          census: { matched: 5 },
          coverage: { messages: 5, pages: 12, lines: 9 },
          items: [],
          complete: true,
        },
      }),
      finish: async ({ save }) => {
        await save({
          result: { matched: 5, pages: 12, lines: 9, topItems: [{ description: "X" }] },
        });
        throw new JobDeliveryError("failed to send");
      },
    });
    await pendingAiJobs();
    const done = await getJob((await listJobs("2010", 1))[0].id);
    expect(done?.status).toBe("delivery_failed");
    // The artifact is intact despite the delivery failure.
    expect((done?.result as any)?.pages).toBe(12);
    expect((done?.result as any)?.topItems).toHaveLength(1);
  });
});

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
// كيف يُمثَّل انقطاع عابر في الكتابة النهائية (إعادة تشغيل الخدمة): كم مرة
// يفشل تحديث الحالة النهائية قبل أن ينجح.
let failFinalWriteTimes = 0;

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
          if (w?.__and) {
            // The orphan sweep's `failed` update is scoped with `inArray(id, …)`,
            // so only the ids it decided are unresumable may be marked.
            const ids = w.__and.find((x: any) => x.__in?.[0] === jobsT.id)?.__in?.[1];
            for (const r of rows) {
              if (r.status !== "running") continue;
              if (ids && !ids.includes(r.id)) continue;
              Object.assign(r, v);
            }
            return Promise.resolve(rows);
          }
          const id = w?.__eq?.[1];
          if (failFinalWriteTimes > 0 && (v?.status === "completed" || v?.status === "failed")) {
            failFinalWriteTimes -= 1;
            return Promise.reject(
              new Error("the database system is not yet accepting connections"),
            );
          }
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
              // The orphan sweep selects stale `running` rows and does NOT filter
              // by jobKey — distinguish it from the active-by-key lookup.
              const byKey = w.__and.some((x: any) => x.__eq?.[0] === jobsT.jobKey);
              if (!byKey) {
                const stale = rows.filter(
                  (r) =>
                    r.status === "running" &&
                    (!r.updatedAt || r.updatedAt.getTime() < Date.now() - 60_000),
                );
                return Promise.resolve(stale.map((r) => ({ ...r })));
              }
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
  markOrphanedJobs,
  registerJobRunner,
  hasJobRunner,
} = await import("../../modules/ai-assistant/jobs");

describe("async jobs", () => {
  beforeEach(() => {
    failFinalWriteTimes = 0;
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

  it("keeps the WORK when only the progress write fails", async () => {
    // Live evidence (job 247): the census had scanned 300 messages and parsed
    // 907 items, then a transient `Failed query: update "ai_assistant_jobs"…`
    // on a progress heartbeat marked the whole job `failed` and DISCARDED the
    // result. Progress is advisory state; a dashboard write must never destroy
    // minutes of work. Replaying the same update against the real database
    // succeeds, which is what identifies this as transient rather than a schema
    // problem.
    const dbMod = await import("@workspace/db");
    const db: any = (dbMod as any).db;
    const originalUpdate = db.update;
    let failedProgressWrites = 0;
    db.update = () => ({
      set: (v: any) => ({
        where: (w: any) => {
          // Fail ONLY a progress heartbeat — never the status/result write, and
          // only the first time, exactly like a transient DB blip. `w` must be
          // forwarded or the underlying mock cannot find the row.
          if (v && "progress" in v && failedProgressWrites === 0) {
            failedProgressWrites += 1;
            return Promise.reject(new Error('Failed query: update "ai_assistant_jobs"'));
          }
          return originalUpdate().set(v).where(w);
        },
      }),
    });
    try {
      const { job } = await createJob({
        phone: "2010",
        kind: "email_items",
        run: async ({ report }) => {
          await report({ scanned: 300, matched: 3650, items: 907 });
          return { result: { items: 907 } };
        },
      });
      await pendingAiJobs();
      const done = await getJob(job.id);
      expect(failedProgressWrites).toBe(1);
      expect(done?.status).toBe("completed");
      expect(done?.result).toEqual({ items: 907 });
    } finally {
      db.update = originalUpdate;
    }
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

  it("retries the FINAL status write so a transient DB blip cannot strand a delivered job", async () => {
    // Live (job 350): the census completed AND the report was delivered (text +
    // PDF), then the final `completed` write failed with «the database system is
    // not yet accepting connections» during a restart — and the catch handler's
    // own write failed identically. The row sat `running` with no worker while
    // the work was done and delivered. The final write must survive the blip.
    let finished = 0;
    const { job } = await startCensusJob({
      phone: "2010",
      question: "حصر مع انقطاع في الكتابة",
      args: { mailbox: "*" },
      runBatch: async () => ({
        session: {
          census: { matched: 1, scope: { scanned: 1 } },
          coverage: { messages: 1 },
          items: [],
          complete: true,
        },
      }),
      finish: async () => {
        finished += 1;
        return { messageId: "wamid.test" };
      },
    });
    // Fail the final write twice: the retry must still land it.
    failFinalWriteTimes = 2;
    await pendingAiJobs();
    expect(finished).toBe(1);
    const done = await getJob(job.id);
    expect(done?.status).toBe("completed");
  });

  it("bounds the DELIVERY so a hung send cannot leave the job running forever", async () => {
    // Live (job 350): the census completed with 334 messages and 853 items, then
    // sat `running` for 20+ minutes because the WhatsApp send never returned.
    // A job stuck in `finish` is indistinguishable from one that never ran.
    const prev = process.env.AI_JOB_DELIVERY_TIMEOUT_MS;
    process.env.AI_JOB_DELIVERY_TIMEOUT_MS = "40";
    try {
      const { job } = await startCensusJob({
        phone: "2010",
        question: "حصر بمهلة تسليم",
        args: { mailbox: "*" },
        runBatch: async () => ({
          session: {
            census: { matched: 1, scope: { scanned: 1 } },
            coverage: { messages: 1 },
            items: [],
            complete: true,
          },
        }),
        // Never resolves — the hung-send shape.
        finish: () => new Promise(() => {}),
      });
      await pendingAiJobs();
      const done = await getJob(job.id);
      expect(done?.status).toBe("delivery_failed");
      expect(String(done?.error)).toContain("مهلة إرسال");
    } finally {
      if (prev === undefined) delete process.env.AI_JOB_DELIVERY_TIMEOUT_MS;
      else process.env.AI_JOB_DELIVERY_TIMEOUT_MS = prev;
    }
  });

  it("stops a census whose filter matched nothing instead of re-reading an empty ask 120×", async () => {
    // Live: a wrong search term matched 0 messages and the job span the whole
    // batch cap (~10 minutes) re-reading the same empty mailbox, then reported
    // «100%» because `matched === 0` was treated as "nothing left to do".
    let batches = 0;
    let finished = 0;
    const { job } = await startCensusJob({
      phone: "2010",
      question: "حصر بفلتر لا يطابق شيئًا",
      args: { mailbox: "*" },
      runBatch: async () => {
        batches += 1;
        return {
          session: {
            census: { matched: 0, scope: { scanned: 3978 } },
            coverage: { messages: 0 },
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
    expect(batches).toBe(1); // one batch, not the 120-batch cap
    expect(finished).toBe(1);
    const done = await getJob(job.id);
    expect(done?.status).toBe("completed");
    // «100%» over an empty ask is the claim that read as a finished census.
    expect(done?.progress?.percent).toBe(0);
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

describe("orphaned jobs (a restart must not leave a job promising work forever)", () => {
  beforeEach(() => {
    rows = [];
    nextId = 1;
  });

  it("fails a stale `running` job whose worker died, so a re-issue starts fresh", async () => {
    // Live evidence: job #38 sat `running` for 6 hours with progress=null after a
    // deploy killed its worker. `findActiveJobByKey` counts `running` as active,
    // so an identical re-issue RESUMED it and promised progress that could never
    // happen — the "silence" failure again, this time invisible.
    rows.push({
      id: 38,
      phone: "2010",
      kind: "email_census",
      status: "running",
      jobKey: "census:*:EDC::::",
      updatedAt: new Date(Date.now() - 6 * 3600_000),
    });
    const n = await markOrphanedJobs();
    expect(n).toBe(1);
    expect(rows[0].status).toBe("failed");
  });

  it("RESUMES a stale job whose kind has a registered runner, instead of failing it", async () => {
    // Live (job 349): the process was recycled mid-census with 2,264 messages
    // examined and 448 item rows parsed. The old sweep marked it `failed` —
    // «orphaned by a restart — stale cursor reset» — discarding work whose
    // cursor was already persisted. A resumable kind must CONTINUE, not die.
    rows.push({
      id: 349,
      phone: "2010",
      kind: "email_census",
      status: "running",
      attempts: 0,
      params: { mailbox: "info@cortoba-supplies.com", contains: "EZQ 20/4" },
      question: "حصر بنود البريد",
      jobKey: "census:info@cortoba-supplies.com::::::all:EZQ 20/4",
      updatedAt: new Date(Date.now() - 6 * 3600_000),
    });
    let resumed = 0;
    registerJobRunner("email_census", {
      resume: (job) => ({
        phone: job.phone,
        kind: job.kind,
        question: job.question ?? "q",
        params: job.params,
        run: async () => {
          resumed += 1;
          return { result: { complete: true } };
        },
      }),
    });
    expect(hasJobRunner("email_census")).toBe(true);

    const n = await markOrphanedJobs();
    expect(n).toBe(1);
    // The row is NOT failed: it keeps working, from its saved cursor.
    expect(rows[0].status).not.toBe("failed");
    await pendingAiJobs();
    expect(resumed).toBe(1);
    // The resume is charged against the attempt budget, so a job that keeps
    // dying cannot restart forever.
    expect(rows[0].attempts).toBe(1);
  });

  it("RESETS the budget when a resumed job made real progress", async () => {
    // A year-long census takes tens of minutes, so a busy deploy day can kill it
    // several times. Charging every resume against a fixed budget would fail a
    // job that advanced the whole way — the budget exists to stop a crash LOOP,
    // not to cap how often the operator's work survives a restart.
    rows.push({
      id: 350,
      phone: "2010",
      kind: "email_census",
      status: "running",
      attempts: 3, // the budget is spent …
      params: { mailbox: "info@x.com" },
      // … but the job advanced past the markers set at its last resume.
      progress: {
        opened: 900,
        scanned: 2200,
        resumeBaseline: { opened: 400, scanned: 1000, lines: 0 },
      },
      updatedAt: new Date(Date.now() - 6 * 3600_000),
    });
    let resumed = 0;
    registerJobRunner("email_census", {
      resume: (job) => ({
        phone: job.phone,
        kind: job.kind,
        question: job.question ?? "q",
        params: job.params,
        run: async () => {
          resumed += 1;
          return undefined;
        },
      }),
    });
    await markOrphanedJobs();
    expect(rows[0].status).not.toBe("failed");
    await pendingAiJobs();
    expect(resumed).toBe(1);
    expect(rows[0].attempts).toBe(1);
  });

  it("still FAILS a stale job whose kind has no runner (no silent `running` lie)", async () => {
    rows.push({
      id: 99,
      phone: "2010",
      kind: "some_other_kind",
      status: "running",
      attempts: 0,
      params: {},
      updatedAt: new Date(Date.now() - 6 * 3600_000),
    });
    expect(await markOrphanedJobs()).toBe(1);
    expect(rows[0].status).toBe("failed");
    expect(String(rows[0].error)).toContain("orphaned by a restart");
  });

  it("does NOT resume a job that has spent its attempt budget", async () => {
    // A crash-looping job must end `failed`, not restart forever.
    rows.push({
      id: 77,
      phone: "2010",
      kind: "email_census",
      status: "running",
      attempts: 3,
      params: { mailbox: "info@x.com" },
      updatedAt: new Date(Date.now() - 6 * 3600_000),
    });
    registerJobRunner("email_census", {
      resume: (job) => ({
        phone: job.phone,
        kind: job.kind,
        question: job.question ?? "q",
        params: job.params,
        run: async () => undefined,
      }),
    });
    await markOrphanedJobs();
    expect(rows[0].status).toBe("failed");
  });

  it("leaves a RECENTLY-started running job alone (it is genuinely working)", async () => {
    rows.push({
      id: 41,
      phone: "2010",
      kind: "email_census",
      status: "running",
      jobKey: "census:live",
      updatedAt: new Date(),
    });
    expect(await markOrphanedJobs()).toBe(0);
    expect(rows[0].status).toBe("running");
  });

  it("KEEPS the rich artifact when finish saves twice (the completed-job data loss)", async () => {
    // Live evidence from the production rows: the job killed mid-flight (210)
    // still held `topItems`/`scope`, while every job that completed NORMALLY
    // (211-213) kept only `{complete, cancelled, messageId}`. `finish` calls
    // `save` twice — once with the full artifact and once with the delivery ids
    // at the end — and a plain `updateJob` replaced the whole column, so the
    // second call destroyed the first. The operator's «احتفظ بالنتيجة» was broken
    // on the common path and nothing failed, because the job still said success.
    const { job } = await startCensusJob({
      phone: "2010",
      question: "حصر EDC",
      args: { mailbox: "*", subject: "EDC PO No" },
      runBatch: async () => ({
        session: {
          census: { matched: 1, scope: { scanned: 10 } },
          coverage: { messages: 1, attachments: 1, lines: 3, pages: 2 },
          items: [],
          complete: true,
        },
      }),
      finish: async ({ report, save }) => {
        // First save: the artifact the operator must be able to retrieve later.
        await save({
          result: {
            report,
            scope: "النطاق: كل الرسائل المطابقة (1).",
            topItems: [{ description: "بند محفوظ" }],
          },
        });
        // Second save: the delivery evidence, as the real finish does at the end.
        await save({ result: { textMessageId: "wamid.X", pdfMessageId: "wamid.Y" } });
        return { messageId: "wamid.Y" };
      },
    });
    await pendingAiJobs();
    const done = await getJob(job.id);
    const r = done?.result as Record<string, any>;
    // The artifact survived the second save…
    expect(Array.isArray(r.topItems)).toBe(true);
    expect(r.scope).toContain("كل الرسائل المطابقة");
    // …and the delivery evidence was added alongside it, not instead of it.
    expect(r.pdfMessageId).toBe("wamid.Y");
    // The report the operator is shown is the run's own measurement.
    expect(r.report?.complete).toBe(true);
    expect(r.report?.percent).toBe(100);
  });

  it("records all ten answers on the job progress, not just five", async () => {
    const { job } = await startCensusJob({
      phone: "2010",
      question: "حصر EDC",
      args: { mailbox: "*", subject: "EDC PO No" },
      runBatch: async () => ({
        session: {
          census: { matched: 10, scope: { scanned: 4399 } },
          coverage: { messages: 4, attachments: 3, lines: 12, pages: 7, unreadable: 0 },
          items: [],
          remaining: 6,
          complete: false,
        },
      }),
      finish: async () => {},
    });
    await pendingAiJobs();
    const p = (await getJob(job.id))?.progress as Record<string, unknown>;
    // What was searched, and what it found / examined / opened / extracted.
    expect(String(p.query)).toContain("EDC PO No");
    expect(p.matched).toBe(10);
    expect(p.examined).toBe(4399);
    expect(p.opened).toBe(4);
    expect(p.pdfs).toBe(3);
    expect(p.results).toBe(12);
    // How long it took, and how much is left to do.
    expect(typeof p.elapsedSeconds).toBe("number");
    expect(p.remaining).toBe(6);
    // Whether it finished, and — since it did not — why it stopped.
    expect(p.complete).toBe(false);
    expect(p.stopReason).toBe("time");
    expect(String(p.stopReasonLabel)).toContain("الوقت");
    // And it never claims 100% for a partial scan.
    expect(p.percent).not.toBe(100);
  });

  it("renders the ten answers into the job's human summary", () => {
    const summary = describeJob({
      id: 7,
      phone: "2010",
      kind: "email_census",
      status: "running",
      question: "q",
      params: null,
      progress: {
        query: "من EDC",
        matched: 480,
        examined: 3704,
        opened: 381,
        pdfs: 332,
        results: 853,
        elapsedSeconds: 89,
        remainingSeconds: 31,
        remaining: 99,
        complete: false,
        percent: 79,
        stopReasonLabel: "انتهت ميزانية الوقت المخصصة للمسح",
      },
      result: null,
      error: null,
      jobKey: null,
      attempts: 0,
      startedAt: null,
      finishedAt: null,
    } as any);
    expect(summary).toContain("البحث عن: من EDC");
    expect(summary).toContain("فُحص: 3704");
    expect(summary).toContain("فُتح: 381");
    expect(summary).toContain("مضى: 89 ث");
    expect(summary).toContain("متبقٍ: 31 ث");
    expect(summary).toContain("جزئي");
    expect(summary).toContain("انتهت ميزانية الوقت");
  });
});

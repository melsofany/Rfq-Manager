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

const { createJob, getJob, listJobs, describeJob, pendingAiJobs } =
  await import("../../modules/ai-assistant/jobs");

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
      startedAt: null,
      finishedAt: null,
    });
    expect(line).toContain("#7");
    expect(line).toContain("1842");
    expect(line).toContain("61%");
  });
});

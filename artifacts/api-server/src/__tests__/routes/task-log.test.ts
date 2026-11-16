import { it, expect, describe, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The operator asked for a full record of every task: plan, steps, tools,
 * results, errors and cost. `metrics.ts` keeps its history in memory, so a
 * restart loses it — this log must be durable, and a logging failure must never
 * fail the task.
 */
vi.mock("@workspace/db", () => {
  const values = vi.fn(async () => []);
  return {
    db: { insert: () => ({ values }) },
    aiAssistantTaskLogTable: { __table: "ai_assistant_task_log" },
    __values: values,
  };
});

describe("task log", () => {
  it("flattens a task record into an auditable row", async () => {
    const { toTaskLogRow } = await import("../../modules/ai-assistant/task-log");
    const { newTaskRecord, planFor, advancePlan } =
      await import("../../modules/ai-assistant/task-plan");
    const task = newTaskRecord("أسعار السلك", planFor("اجمع الأسعار وقارنها وابعت تقرير"));
    advancePlan(task, 1, ["8 عروض"], []);
    advancePlan(task, 2, [], ["503"]);
    task.modelCalls = 4;
    task.toolCalls = 7;
    task.outcome = "completed";
    task.finishedAt = new Date(Date.parse(task.startedAt) + 5000).toISOString();

    const row = toTaskLogRow(task, "201000000000", ["search_database", "search_database"], []);
    expect(row.phone).toBe("201000000000");
    expect(row.modelCalls).toBe(4);
    expect(row.toolCalls).toBe(7);
    expect(row.durationMs).toBe(5000);
    // Tools are deduped: the operator wants WHICH tools, not a call list.
    expect(row.toolsUsed).toEqual(["search_database"]);
    expect(row.plan).toHaveLength(2);
    expect(row.steps).toEqual([
      { index: 1, attempts: 1, errors: [] },
      { index: 2, attempts: 1, errors: ["503"] },
    ]);
  });

  it("never throws when the write fails — bookkeeping must not break an answer", async () => {
    vi.resetModules();
    vi.doMock("@workspace/db", () => {
      throw new Error("database is down");
    });
    const { persistTaskLog } = await import("../../modules/ai-assistant/task-log");
    const ok = await persistTaskLog({
      phone: "p",
      goal: "g",
      outcome: "completed",
      plan: [],
      steps: [],
      toolsUsed: [],
      modelCalls: 0,
      toolCalls: 0,
      errors: [],
      durationMs: 0,
      createdAt: new Date().toISOString(),
    });
    expect(ok).toBe(false);
  });

  it("GUARD: the DDL creates the table the code inserts into", () => {
    // A CREATE TABLE IF NOT EXISTS is a NO-OP on an existing table, so the DDL
    // is the only thing that makes the column set real on production.
    const ddl = readFileSync("src/shared/init-db.ts", "utf8");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS ai_assistant_task_log");
    for (const col of ["tools_used", "model_calls", "tool_calls", "duration_ms"]) {
      expect(ddl, col).toContain(col);
    }
    // Its own statement: a sibling failure must not roll the CREATE back.
    const block = ddl.slice(ddl.indexOf("ai_assistant_task_log") - 200);
    expect(block.slice(0, 400)).toContain("await client.query");
  });
});

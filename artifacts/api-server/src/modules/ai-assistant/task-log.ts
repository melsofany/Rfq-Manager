/**
 * A DURABLE record of every task the agent ran.
 *
 * `metrics.ts` keeps its history in memory, so a restart loses it — and the
 * operator's requirement is an auditable log of the plan, the steps, the tools
 * used, the results, the errors and the cost. An in-memory ring buffer answers
 * «what happened just now» but not «what did it do yesterday», which is the
 * question that matters when a figure is challenged.
 *
 * Writes are best-effort: a logging failure must never fail the task the
 * operator is waiting on, and the log is written AFTER the answer is produced.
 * Lazy `@workspace/db` import so the module stays testable without a database.
 */

import { logger } from "../../shared/logger";
import type { TaskRecord } from "./task-plan";

export interface TaskLogRow {
  phone: string;
  goal: string;
  outcome: string;
  plan: unknown;
  steps: unknown;
  toolsUsed: string[];
  modelCalls: number;
  toolCalls: number;
  errors: string[];
  durationMs: number;
  createdAt: string;
}

/** Flatten a TaskRecord into the row the operator reads. */
export function toTaskLogRow(
  task: TaskRecord,
  phone: string,
  toolsUsed: string[],
  errors: string[],
): TaskLogRow {
  const started = Date.parse(task.startedAt);
  const ended = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
  return {
    phone,
    goal: task.goal,
    outcome: task.outcome,
    plan: task.plan.steps.map((s) => ({ index: s.index, text: s.text, status: s.status })),
    steps: task.attempts.map((a) => ({
      index: a.index,
      attempts: a.attempts,
      errors: a.errors,
    })),
    toolsUsed: [...new Set(toolsUsed)],
    modelCalls: task.modelCalls,
    toolCalls: task.toolCalls,
    errors,
    durationMs: Number.isFinite(started) && ended >= started ? ended - started : 0,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Persist the task. Never throws: a logging failure is recorded and swallowed,
 * because the alternative — failing an answer that already succeeded — turns
 * bookkeeping into an outage.
 */
export async function persistTaskLog(row: TaskLogRow): Promise<boolean> {
  try {
    const { db } = await import("@workspace/db");
    const { aiAssistantTaskLogTable } = await import("@workspace/db");
    await db.insert(aiAssistantTaskLogTable).values({
      phone: row.phone,
      goal: row.goal,
      outcome: row.outcome,
      plan: row.plan as never,
      steps: row.steps as never,
      toolsUsed: row.toolsUsed as never,
      modelCalls: row.modelCalls,
      toolCalls: row.toolCalls,
      errors: row.errors as never,
      durationMs: row.durationMs,
      createdAt: row.createdAt,
    });
    return true;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "AI assistant: task log write failed (best-effort)",
    );
    return false;
  }
}

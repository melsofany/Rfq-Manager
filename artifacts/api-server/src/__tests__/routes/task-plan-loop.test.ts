import { it, expect, describe } from "vitest";
import {
  planFor,
  newTaskRecord,
  advancePlan,
  reviewStep,
  isTransientFailure,
  renderTaskRecord,
  MAX_STEP_ATTEMPTS,
  type StepAttempt,
} from "../../modules/ai-assistant/task-plan";

/**
 * The OpenManus PlanningFlow discipline, with the review step OpenManus lacks:
 * its `_mark_step_completed` trusts the executor's claim, so a step that FAILED
 * advances the plan on a false premise. Here a step is done only when it
 * produced evidence and no unrecovered error.
 */
describe("plan → execute → review → retry", () => {
  it("marks a step done only when it produced evidence", () => {
    expect(reviewStep({ index: 1, evidence: ["42 rows"], errors: [], attempts: 1 }).done).toBe(
      true,
    );
    // An empty result is NOT success — the `filter(Boolean)` lesson.
    const empty = reviewStep({ index: 1, evidence: [], errors: [], attempts: 1 });
    expect(empty.done).toBe(false);
    expect(empty.retry).toBe(true);
  });

  it("retries a transient failure and gives up on a permanent one", () => {
    const transient = reviewStep({
      index: 1,
      evidence: [],
      errors: ["503 overloaded"],
      attempts: 1,
    });
    expect(transient.retry).toBe(true);
    expect(transient.note).toContain("مؤقت");

    const permanent = reviewStep({
      index: 1,
      evidence: [],
      errors: ["عمود غير موجود"],
      attempts: 1,
    });
    expect(permanent.retry).toBe(false);
    expect(permanent.done).toBe(false);
  });

  it("stops retrying a transient failure after the attempt ceiling", () => {
    const spent = reviewStep({
      index: 1,
      evidence: [],
      errors: ["timeout"],
      attempts: MAX_STEP_ATTEMPTS,
    });
    expect(spent.retry).toBe(false);
    expect(spent.done).toBe(false);
  });

  it("classifies failures the way the operator experiences them", () => {
    expect(isTransientFailure(["429 rate limit"])).toBe(true);
    expect(isTransientFailure(["حصة الموديلات"])).toBe(true);
    expect(isTransientFailure(["المورد غير موجود"])).toBe(false);
  });

  it("advances the plan on success and blocks it on a permanent failure", () => {
    const task = newTaskRecord("حصر", planFor("حصر وقارن وابعت تقرير"));

    expect(advancePlan(task, 1, ["120 صف"], []).done).toBe(true);
    expect(task.plan.steps[0].status).toBe("done");

    const blocked = advancePlan(task, 2, [], ["عمود غير موجود"]);
    expect(blocked.blocked).toBe(true);
    expect(task.plan.steps[1].status).toBe("blocked");
    expect(task.plan.blockedReason).toContain("غير قابل للإصلاح");
  });

  it("counts attempts per step and renders the record the operator asked for", () => {
    const task = newTaskRecord("أسعار", planFor("اجمع الأسعار وقارنها"));
    advancePlan(task, 1, [], ["503"]);
    advancePlan(task, 1, ["8 عروض"], []);
    task.modelCalls = 3;
    task.toolCalls = 5;

    const a: StepAttempt | undefined = task.attempts.find((x) => x.index === 1);
    expect(a?.attempts).toBe(2);
    expect(task.plan.steps[0].status).toBe("done");

    const rec = renderTaskRecord(task);
    expect(rec).toContain("نداءات النموذج: 3");
    expect(rec).toContain("استدعاءات الأدوات: 5");
    expect(rec).toContain("(2 محاولة)");
  });
});

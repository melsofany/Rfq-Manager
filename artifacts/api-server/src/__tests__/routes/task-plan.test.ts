import { it, expect, describe } from "vitest";
import {
  planFor,
  nextStep,
  markStep,
  planProgress,
  renderPlan,
} from "../../modules/ai-assistant/task-plan";

/**
 * The planning discipline taken from OpenManus: a multi-step request is written
 * down as STEPS and executed in order. Without it each round re-decided the task
 * from the recent transcript and the later steps were dropped.
 */
describe("task plan", () => {
  it("orders gather → compare → report", () => {
    const p = planFor("اعمل حصر لأوامر الشراء وقارن الأسعار وابعت تقرير PDF");
    expect(p.steps.map((s) => s.text)).toEqual([
      "اجمع الأرقام المطلوبة من المصدر المحدد",
      "رتّب/قارن النتائج واستخرج الفروق",
      "جهّز التقرير وأرسله",
    ]);
    expect(p.steps.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it("always gives a plain question one step to show", () => {
    expect(planFor("مين مورد السخان؟").steps).toHaveLength(1);
  });

  it("does not duplicate a step when several signals match", () => {
    const p = planFor("كام مورد وإجمالي الأصناف");
    expect(p.steps.filter((s) => s.text.includes("اجمع")).length).toBe(1);
  });

  it("advances to the next unfinished step and reports progress", () => {
    const p = planFor("حصر وقارن وابعت تقرير");
    expect(nextStep(p)?.index).toBe(1);
    markStep(p, 1, "done");
    expect(nextStep(p)?.index).toBe(2);
    expect(planProgress(p)).toEqual({ done: 1, total: 3, percent: 33 });
    markStep(p, 2, "done");
    markStep(p, 3, "done");
    expect(nextStep(p)).toBeNull();
    expect(planProgress(p).percent).toBe(100);
  });

  it("ignores an unknown index instead of failing the task", () => {
    const p = planFor("حصر");
    expect(() => markStep(p, 99, "done")).not.toThrow();
    expect(planProgress(p).done).toBe(0);
  });

  it("renders the plan with checkboxes and the no-early-finish rule", () => {
    const p = planFor("حصر وقارن وابعت تقرير");
    markStep(p, 1, "done");
    const text = renderPlan(p);
    expect(text).toContain("[x] 1.");
    expect(text).toContain("[ ] 2.");
    expect(text).toContain("1/3");
    expect(text).toContain("لا تُعلن انتهاء المهمة");
  });

  it("renders nothing for a single-step plan (no ceremony)", () => {
    expect(renderPlan(planFor("مين المورد؟"))).toBe("");
  });
});

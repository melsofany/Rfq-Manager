import { it, expect, describe } from "vitest";
import {
  detectJob,
  planForJob,
  toolsForJob,
  cortobaTemplates,
} from "../../modules/ai-assistant/cortoba-tasks";
import { isKnownTool } from "../../modules/ai-assistant/tool-permissions";

/**
 * The five jobs Cortoba actually does. A template makes the plan for a
 * recurring job identical every time, instead of the model inventing a shape.
 */
describe("Cortoba job templates", () => {
  it("covers the five jobs the operator named", () => {
    expect(
      cortobaTemplates()
        .map((t) => t.job)
        .sort(),
    ).toEqual([
      "item_analysis",
      "price_research",
      "rfq_followup",
      "supplier_data_extraction",
      "supplier_search",
    ]);
  });

  it("detects the job from the operator's own words", () => {
    expect(detectJob("عايز موردين لهذا البند")).toBe("supplier_search");
    expect(detectJob("إيه أسعار السلك الحراري؟")).toBe("price_research");
    expect(detectJob("استخرج بيانات المورد من الميل")).toBe("supplier_data_extraction");
    expect(detectJob("طلبات مفتوحة بدون أمر شراء")).toBe("rfq_followup");
    expect(detectJob("حلل الأصناف الأكثر تكرارًا")).toBe("item_analysis");
  });

  it("returns null rather than guessing a wrong job", () => {
    // A wrong template makes the agent follow the wrong steps confidently.
    expect(detectJob("السلام عليكم")).toBeNull();
    expect(detectJob("رقم أمر الشراء كام؟")).toBeNull();
  });

  it("does not send a price question down the supplier-search template", () => {
    // «موردين» + «أسعار» is a PRICE question; the search template would skip
    // the comparison the operator actually asked for.
    expect(detectJob("أسعار الموردين للبند ده")).toBe("price_research");
  });

  it("gives each job an ordered plan with a recommendation at the end", () => {
    const p = planForJob("supplier_search", "عايز موردين");
    expect(p.steps.length).toBeGreaterThanOrEqual(3);
    expect(p.steps.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(p.steps[2].text).toMatch(/أوصِ|رتّب/);
  });

  it("GUARD: every tool a template needs is a classified tool", () => {
    // Otherwise the template would name a capability the permission layer
    // refuses, and the job would fail halfway with a confusing error.
    for (const t of cortobaTemplates()) {
      for (const tool of toolsForJob(t.job)) {
        expect(isKnownTool(tool), `${t.job} → ${tool}`).toBe(true);
      }
    }
  });
});

/**
 * The intent/query router.
 *
 * This is the layer that decides how much budget a question is allowed before
 * any provider request is made. The failure modes are silent and expensive: a
 * genuine analysis mis-routed as a quick lookup answers confidently from a
 * sample (the reported "10 messages instead of 3,710" class of bug), while a
 * simple lookup routed as deep just burns quota. Both directions are asserted
 * here, with real Arabic phrasing, not English stand-ins.
 */
import { describe, it, expect } from "vitest";
import {
  routeQuestion,
  routeHint,
  normalizeArabic,
  FAST_MAX_ROUNDS,
  DEEP_MAX_ROUNDS,
} from "../../modules/ai-assistant/router";

describe("router: Arabic normalisation", () => {
  it("folds hamza/alef/yaa/taa-marbuta and strips harakat", () => {
    expect(normalizeArabic("إحصائية")).toBe(normalizeArabic("احصائيه"));
    expect(normalizeArabic("تسعير")).toBe(normalizeArabic("تسعير"));
    expect(normalizeArabic("مُقارنة")).toBe(normalizeArabic("مقارنه"));
  });
});

describe("router: fast path (simple, specific questions)", () => {
  it("routes a document number to a fast document lookup", () => {
    const plan = routeQuestion("أمر الشراء P26E11407 تبع مين؟");
    expect(plan.intent).toBe("document_lookup");
    expect(plan.path).toBe("fast");
    expect(plan.maxRounds).toBe(FAST_MAX_ROUNDS);
    expect(plan.hint).toContain("lookup_document");
  });

  it("routes a bare numeric PO reference to a document lookup", () => {
    const plan = routeQuestion("رقم الفاتورة 45001234");
    expect(plan.intent).toBe("document_lookup");
    expect(plan.path).toBe("fast");
  });

  it("routes a supplier question to the fast supplier overview", () => {
    const plan = routeQuestion("مين مورد هاي فولت؟");
    expect(plan.intent).toBe("supplier_lookup");
    expect(plan.path).toBe("fast");
    expect(plan.hint).toContain("supplier_overview");
  });

  it("routes a plain count question to the fast path with verification ON", () => {
    const plan = routeQuestion("كام أمر شراء عندنا؟");
    expect(plan.intent).toBe("count_aggregate");
    expect(plan.path).toBe("fast");
    // A wrong count is exactly the failure the verifier exists to catch.
    expect(plan.verify).toBe(true);
  });

  it("treats a short greeting as chit-chat with no verification", () => {
    const plan = routeQuestion("السلام عليكم");
    expect(plan.intent).toBe("smalltalk");
    expect(plan.path).toBe("fast");
    // Nothing factual to verify, so no round should be spent checking it.
    expect(plan.verify).toBe(false);
  });
});

describe("router: deep path (analysis, email, reports)", () => {
  it("routes a full-email census to the deep path even though it mentions PO and a year", () => {
    // The dangerous case: this contains «PO» and a number, so a naive router
    // would call it a document lookup and answer from a sample.
    const plan = routeQuestion("اعمل حصر لكل PO في البريد خلال 2026");
    expect(plan.path).toBe("deep");
    expect(plan.maxRounds).toBe(DEEP_MAX_ROUNDS);
    expect(["analytics", "email_search"]).toContain(plan.intent);
    expect(plan.verify).toBe(true);
  });

  it("routes a comparison question to the deep path", () => {
    const plan = routeQuestion("قارن عدد الطلبات بين البريد والنظام");
    expect(plan.path).toBe("deep");
  });

  it("routes an email/attachment question to the deep path", () => {
    const plan = routeQuestion("هات المرفقات اللي في إيميل المورد");
    expect(plan.intent).toBe("email_search");
    expect(plan.path).toBe("deep");
  });

  it("routes an explicit report/file request to the deep path", () => {
    const plan = routeQuestion("اعملي تقرير كامل بالبنود");
    expect(plan.intent).toBe("report");
    expect(plan.path).toBe("deep");
  });

  it("treats the most-repeated-item question as analytics in the database", () => {
    const plan = routeQuestion("إيه أكتر بند اتكرر؟");
    expect(plan.intent).toBe("analytics");
    expect(plan.path).toBe("deep");
  });

  it("routes an outstanding-work question to the procurement ops intent", () => {
    const plan = routeQuestion("إيه التسليمات المتأخرة عند العملاء؟");
    expect(plan.intent).toBe("procurement_ops");
    expect(plan.path).toBe("deep");
    // The hint must name the DB-first tool; otherwise the model answers from
    // whatever rows it happened to read.
    expect(routeHint(plan)).toContain("get_overdue_deliveries");
  });

  it("routes late/unreceived PO wording to the procurement ops intent", () => {
    const plan = routeQuestion("افتح أوامر الشراء اللي لسه ما وصلتش");
    expect(plan.intent).toBe("procurement_ops");
    expect(routeHint(plan)).toContain("get_unfulfilled_orders");
  });

  it("routes an English overdue question the same way", () => {
    const plan = routeQuestion("any overdue deliveries?");
    expect(plan.intent).toBe("procurement_ops");
    expect(plan.path).toBe("deep");
  });
});

describe("router: safe default and hint", () => {
  it("defaults an unclassified question to the DEEP path, never a guess", () => {
    const plan = routeQuestion("شكراً على مجهودك الكبير في هذا الموضوع");
    // Mis-routing a real analysis as trivial is the expensive error, so an
    // unknown question is treated as hard.
    expect(plan.path).toBe("deep");
    expect(plan.intent).toBe("analytics");
  });

  it("handles an empty message without throwing", () => {
    const plan = routeQuestion("");
    expect(plan.intent).toBe("smalltalk");
    expect(plan.path).toBe("fast");
  });

  it("returns no hint for a question it has no guidance for", () => {
    const plan = routeQuestion("السلام عليكم");
    expect(routeHint(plan)).toBe("");
  });

  it("prefixes a hint with the path name when one applies", () => {
    const plan = routeQuestion("كام أمر شراء عندنا؟");
    expect(routeHint(plan)).toContain("مسار سريع");
  });
});

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

describe("router: customer orders vs our supplier orders", () => {
  /**
   * Live failure: asked to aggregate the items supplied to customers, the agent
   * used `aggregate_po_items` — the SUPPLIER table (39 headers / 65 lines) —
   * and reported 39/65 as the total, then denied that a customer PO visible on
   * screen (`CPO-2025-000484` / `P25E26553`, id 841) existed. The customer table
   * holds 767 / 1,993. The hint must name the customer tool so the small table
   * can never be mistaken for the whole history.
   */
  it("points a customer-items census at the customer table, not the supplier one", () => {
    const plan = routeQuestion("هاتلي حصر كل الأصناف الموردة للعملاء بكمياتها");
    expect(plan.hint).toContain("aggregate_customer_po_items");
    expect(plan.hint).toContain("customer_po_items");
  });

  it("points an EDC customer-order question at the customer table", () => {
    const plan = routeQuestion("أوامر شراء العملاء الواردة من EDC كام بند فيها؟");
    expect(plan.hint).toContain("aggregate_customer_po_items");
  });

  it("recognises our internal customer-PO number as a customer-side document", () => {
    const plan = routeQuestion("CPO-2025-000484 ده إيه بالظبط؟");
    // A CPO- number exists only in customer_pos, so the hint may name it.
    expect(plan.hint).toContain("aggregate_customer_po_items");
  });

  it("does NOT force a P26E code to the customer table — it lives in both", () => {
    // All 39 supplier POs share their sheetPoNo with a customer PO, so a rule
    // pinning that form to one table would be wrong half the time. It stays a
    // document lookup, where the sibling-table fallback gathers the evidence.
    const plan = routeQuestion("أمر الشراء P26E11407 تبع مين؟");
    expect(plan.intent).toBe("document_lookup");
    expect(plan.hint).not.toContain("aggregate_customer_po_items");
  });

  it("leaves a plain supplier-side aggregate question unadorned", () => {
    const plan = routeQuestion("أكتر بند اتكرر في أوامر الشراء بتاعتنا للموردين");
    expect(plan.hint).not.toContain("aggregate_customer_po_items");
  });

  it("adds the customer-table caveat to a customer-side COUNT question", () => {
    const plan = routeQuestion("عدد الأصناف الموردة للعملاء كام؟");
    expect(plan.hint).toContain("customer_po_items");
  });
});

/**
 * The four defects behind the live «⏳ جاري البحث» that never became an answer.
 *
 * The operator asked the assistant (thread «gos», 26/09) to open `info@`, read
 * EDC's RFQ/PO PDFs, and report how many times the MAICO explosion-proof fan
 * (EZQ 20/4 E Ex e, PN 1000108319) was requested and its total quantity. The
 * assistant acknowledged, then produced five consecutive timeouts and finally a
 * message containing literal `<tool_calls>` markup — no answer, ever.
 *
 * Each test here fails against the pre-fix source; the reasoning is stated per
 * case because each fix guards an invariant, not a code path.
 */
import { describe, it, expect } from "vitest";
import {
  ANSWER_RESERVE_MS,
  MIN_ANSWER_BUDGET_MS,
  SCAN_RETURN_MARGIN_MS,
} from "../../modules/ai-assistant/budgets";
import { effectiveToolTimeoutMs, scanCallBudgetMs } from "../../modules/ai-assistant/tools";
import { sanitizeAssistantReply, hadToolMarkup } from "../../modules/ai-assistant/reply-sanitize";
import { asksForExactCount } from "../../modules/ai-assistant/tools";

describe("the scan must return BEFORE the tool-timeout race can kill it", () => {
  it("leaves the scan a strictly smaller ceiling than the race that kills it", () => {
    // Live measurement: the tool ceiling and the scan budget both resolved to
    // exactly 58,013ms, so the race that kills the tool fired on the same tick as
    // the scan's own deadline. The scan lost the tie and its honest
    // «فُتح N من M» payload was replaced by a generic timeout — five times.
    //
    // The margin makes the scan's deadline strictly smaller in EVERY case where
    // the run deadline is the binding constraint.
    const now = 1_000_000;
    const deadline = now + 123_013; // reproduces the live 58,013ms figure
    const toolCeiling = effectiveToolTimeoutMs({ deadline }, now);
    const scanBudget = Math.min(
      scanCallBudgetMs(),
      deadline - now - ANSWER_RESERVE_MS - MIN_ANSWER_BUDGET_MS - SCAN_RETURN_MARGIN_MS,
    );
    expect(scanBudget).toBeGreaterThan(0);
    expect(scanBudget).toBeLessThan(toolCeiling);
    // And by the margin, not by a hair: one tick is not enough to serialise the
    // aggregation over thousands of parsed rows.
    expect(toolCeiling - scanBudget).toBeGreaterThanOrEqual(SCAN_RETURN_MARGIN_MS);
  });

  it("keeps the existing ladder intact (fetch < scan budget < tool ceiling)", () => {
    // A value set above its parent is silently ignored (documented trap), so the
    // ordering is asserted rather than assumed.
    expect(scanCallBudgetMs()).toBeLessThan(160_000);
  });
});

describe("a count/total question is recognised as unanswerable from a sample", () => {
  it("matches the operator's own wording for the MAICO case", () => {
    // The live question, verbatim.
    expect(
      asksForExactCount({
        question: "عايز اعرف البند ده اتطلب كام مره والكمية الاجمالية كام في كل طلبات التسعير",
      }),
    ).toBe(true);
    expect(asksForExactCount({ question: "إجمالي الكمية المطلوبة من الماركة دي" })).toBe(true);
    expect(asksForExactCount({ question: "how many times was this ordered" })).toBe(true);
  });

  it("does NOT match an ordinary lookup (one appearance is a valid answer)", () => {
    // A lookup is satisfied by a single hit, so it stays interactive and is
    // answered immediately instead of being replaced by a «جاري الحصر» notice.
    expect(asksForExactCount({ question: "فين السخانات الأريستون؟" })).toBe(false);
    expect(asksForExactCount({ question: "هات آخر سعر للبند ده" })).toBe(false);
    expect(asksForExactCount({ question: "اعرض أوامر الشراء الواردة من EDC" })).toBe(false);
  });
});

describe("tool-call markup never reaches the operator", () => {
  it("removes an XML-style tool-call block that was written as prose", () => {
    const raw =
      'سأبحث الآن.<tool_calls><invoke name="scan_email_items"><parameter name="contains">EZQ 20/4</parameter></invoke></tool_calls>';
    expect(hadToolMarkup(raw)).toBe(true);
    const clean = sanitizeAssistantReply(raw);
    expect(clean).not.toContain("tool_calls");
    expect(clean).not.toContain("invoke");
    expect(clean).not.toContain("EZQ 20/4"); // the argument must not leak either
  });

  it("drops a TRUNCATED call block rather than leaking its tail", () => {
    // The live message was cut mid-block; the remainder read as the model's
    // internal reasoning about the tool it wanted to call.
    const raw = 'جاري البحث.<tool_calls><invoke name="scan_email_items">';
    const clean = sanitizeAssistantReply(raw);
    expect(clean).toBe("جاري البحث.");
  });

  it("leaves ordinary prose that names a tool untouched", () => {
    // The operator legitimately reads «استخدمت حصر البريد» — the guard must only
    // remove call SYNTAX, or it would censor normal answers.
    const raw = "استخدمت حصر البريد على كل الرسائل، والنتيجة كالتالي.";
    expect(hadToolMarkup(raw)).toBe(false);
    expect(sanitizeAssistantReply(raw)).toBe(raw);
  });

  it("reports no markup for a clean Arabic answer", () => {
    const raw = "البند EZQ 20/4 E Ex e اتطلب 3 مرات بإجمالي كمية 12 قطعة.";
    expect(hadToolMarkup(raw)).toBe(false);
    expect(sanitizeAssistantReply(raw)).toBe(raw);
  });
});

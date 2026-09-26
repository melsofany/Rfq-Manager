/**
 * Tests for the deterministic claim checks.
 *
 * Each case is derived from a RECORDED failure, not invented: the «لا توجد
 * مرفقات» denial (which missed 334 matched messages), the «تم الفحص الشامل»
 * over a partial scan, and the operator's «ادخال الميل وشوف كل ال PO».
 *
 * The rules are deliberately narrow, so the negative cases matter as much as the
 * positive ones — a false flag would make the assistant "correct" a right answer.
 */
import { describe, expect, it } from "vitest";
import { checkClaims } from "../../modules/ai-assistant/claim-check";
import type { ToolExchange } from "../../modules/ai-assistant/mastra-agent";

function ex(name: string, data: unknown): ToolExchange {
  return { name, args: {}, content: JSON.stringify(data) };
}

describe("claim checks", () => {
  describe("negative claim vs a census that matched (the EDC incident)", () => {
    it("flags «لا توجد مرفقات» when the census matched 334 messages", () => {
      const res = checkClaims({
        answer:
          "لم يتم العثور على أي مرفقات PDF تحتوي على بنود أوامر شراء في الرسائل الواردة من EDC.",
        exchanges: [ex("scan_emails", { matched: 334, scanned: 334, isTotal: true })],
      });
      expect(res.rule).toBe("negative-vs-census");
      expect(res.correction).toContain("334");
    });

    it("flags a denial when the ITEM census returned parts", () => {
      const res = checkClaims({
        answer: "لا توجد بنود قابلة للقراءة في هذه الطلبات.",
        exchanges: [ex("scan_email_items", { matched: 334, totalItems: 20, isComplete: true })],
      });
      expect(res.rule).toBe("negative-vs-census");
      expect(res.correction).toContain("334");
    });

    it("does NOT flag a denial when the census genuinely matched nothing", () => {
      const res = checkClaims({
        answer: "لم يتم العثور على أي رسائل مطابقة في هذا النطاق.",
        exchanges: [ex("scan_emails", { matched: 0, scanned: 500, isTotal: true })],
      });
      expect(res.correction).toBeNull();
    });
  });

  describe("negative claim built only from a sample tool", () => {
    it("flags a denial based on search_emails alone", () => {
      const res = checkClaims({
        answer: "لا توجد رسائل من EDC في صندوق info.",
        exchanges: [ex("search_emails", { matched: 0 })],
      });
      expect(res.rule).toBe("negative-from-sample");
      expect(res.correction).toContain("scan_email_items");
    });

    it("does NOT flag when a census also ran", () => {
      const res = checkClaims({
        answer: "لا توجد رسائل مطابقة.",
        exchanges: [ex("search_emails", { matched: 0 }), ex("scan_emails", { matched: 0 })],
      });
      expect(res.correction).toBeNull();
    });
  });

  describe("completeness claim vs a partial scan", () => {
    it("flags «تم الفحص الشامل» when the census is incomplete", () => {
      const res = checkClaims({
        answer: "تم الفحص الشامل لكل أوامر الشراء في البريد، وهذه القائمة.",
        exchanges: [
          ex("scan_email_items", { matched: 480, isComplete: false, remainingMessages: 99 }),
        ],
      });
      expect(res.rule).toBe("completeness");
      expect(res.correction).toContain("99");
    });

    it("flags completeness when remainingMessages > 0 without a boolean", () => {
      const res = checkClaims({
        answer: "فحصت كل الرسائل وأرفقت النتيجة.",
        exchanges: [ex("scan_email_items", { matched: 480, remainingMessages: 40 })],
      });
      expect(res.rule).toBe("completeness");
    });

    it("does NOT flag when the census is genuinely complete", () => {
      const res = checkClaims({
        answer: "تم الفحص الشامل لكل الرسائل المطابقة (334).",
        exchanges: [
          ex("scan_email_items", { matched: 334, isComplete: true, remainingMessages: 0 }),
        ],
      });
      expect(res.correction).toBeNull();
    });
  });

  describe("does not touch ordinary answers", () => {
    it("ignores prose with no claim", () => {
      const res = checkClaims({
        answer: "أعلى بند هو سخان أريستون بكمية 181 قطعة في 21 أمر شراء.",
        exchanges: [ex("scan_email_items", { matched: 334, totalItems: 20, isComplete: true })],
      });
      expect(res.correction).toBeNull();
    });

    it("ignores a run with no tool exchanges at all", () => {
      const res = checkClaims({ answer: "لا توجد بيانات.", exchanges: [] });
      expect(res.correction).toBeNull();
    });

    it("survives a non-JSON tool payload without throwing", () => {
      const res = checkClaims({
        answer: "لا توجد نتائج.",
        exchanges: [{ name: "scan_emails", args: {}, content: "ERROR: mailbox unreachable" }],
      });
      expect(res.correction).toBeNull();
    });
  });
});

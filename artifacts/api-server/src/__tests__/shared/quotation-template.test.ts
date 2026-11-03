import { describe, it, expect } from "vitest";
import {
  QUOTATION_OFFER_BODY,
  QUOTATION_OFFER_FOOTER,
  COMPANY_PHONE_DISPLAY,
  normalizeIntlPhone,
} from "../../modules/communications/service";

/**
 * The operator approved this wording explicitly, so it is a REQUIREMENT, not
 * copy that can drift. Meta does NOT allow an approved template's body to be
 * edited, so a wording regression here is only recoverable by publishing a NEW
 * template — cheaper to catch in a test.
 *
 * The message must read as a formal offer from the company, name the quotation
 * number and the validity date, and end on a sentence (never a variable, which
 * Meta rejects).
 */
describe("quotation_offer_ar template body", () => {
  it("opens with the formal salutation and offers the quotation in the operator's words", () => {
    expect(QUOTATION_OFFER_BODY.startsWith("السيد/{{1}}")).toBe(true);
    expect(QUOTATION_OFFER_BODY).toContain("يسر شركة قرطبة للتوريدات أن تقدم لسيادتكم عرض سعر");
    expect(QUOTATION_OFFER_BODY).toContain("عرض سعر رقم {{2}}، صالح حتى {{3}}");
  });

  it("uses exactly four body parameters in order", () => {
    const params = QUOTATION_OFFER_BODY.match(/\{\{\d+\}\}/g);
    expect(params).toEqual(["{{1}}", "{{2}}", "{{3}}", "{{4}}"]);
  });

  it("does not start or end with a variable (Meta rejects that)", () => {
    expect(QUOTATION_OFFER_BODY.trim().startsWith("{{")).toBe(false);
    expect(QUOTATION_OFFER_BODY.trim().endsWith("}}")).toBe(false);
  });

  it("never lets a variable sit in the trailing punctuation run (Meta rejects that)", () => {
    // Live rejection: `error_subcode 2388299` — «يجب ألا تكون المتغيرات في بداية
    // القالب أو نهايته». A trailing full stop does NOT satisfy Meta: the earlier
    // wording ended «… على {{4}}.» and was refused. The body must close on real
    // words, so strip trailing punctuation/whitespace and require no variable.
    const tail = QUOTATION_OFFER_BODY.replace(/[\s.,!؟?،؛;:]+$/u, "");
    expect(/\{\{\d+\}\}$/.test(tail)).toBe(false);
  });

  it("keeps the body within Meta's 1024-character limit", () => {
    expect(QUOTATION_OFFER_BODY.length).toBeLessThanOrEqual(1024);
  });

  it("names the contact number and closes on the closing sentence", () => {
    expect(QUOTATION_OFFER_BODY).toContain("يُرجى التواصل معنا على {{4}}");
    expect(QUOTATION_OFFER_BODY.trim().endsWith("ونأمل أن تنال رضاكم.")).toBe(true);
  });

  it("carries the company address in the footer", () => {
    expect(QUOTATION_OFFER_FOOTER).toContain("قرطبة للتوريدات");
    expect(QUOTATION_OFFER_FOOTER).toContain("مرسي مطروح");
  });

  it("keeps the footer within Meta's 60-character limit", () => {
    // Live rejection: `error_subcode 2388040` — «لا يمكن أن يحتوي حقل Footer على
    // أكثر من 60 حرفًا». The full postal address is 73 chars, so the footer must
    // stay short or the whole template is refused.
    expect(QUOTATION_OFFER_FOOTER.length).toBeLessThanOrEqual(60);
  });

  it("shows the published contact number as the {{4}} parameter value", () => {
    expect(COMPANY_PHONE_DISPLAY).toBe("432-972-587");
  });
});

/**
 * Meta rejects a template's call button when its number is not in international
 * form — live: `(#192) Param components[3]['buttons'][0]['phone_number'] is not
 * a valid phone number` for the document number 432-972-587. The button must
 * therefore carry a real dialable number, or be omitted.
 */
describe("quotation call-button number", () => {
  it("accepts an international number and normalises it", () => {
    expect(normalizeIntlPhone("+201234567890")).toBe("+201234567890");
    expect(normalizeIntlPhone("00201234567890")).toBe("+201234567890");
    expect(normalizeIntlPhone("+20 123 456 7890")).toBe("+201234567890");
  });

  it("rejects the document display number that Meta refused", () => {
    // No international marker -> never treated as dialable, whatever its length.
    expect(normalizeIntlPhone(COMPANY_PHONE_DISPLAY)).toBe("");
    expect(normalizeIntlPhone("201234567890")).toBe("");
    expect(normalizeIntlPhone("")).toBe("");
    expect(normalizeIntlPhone("123")).toBe("");
    expect(normalizeIntlPhone("+1234567890123456")).toBe("");
  });
});

import { describe, it, expect } from "vitest";
import {
  QUOTATION_OFFER_BODY,
  QUOTATION_OFFER_FOOTER,
  COMPANY_PHONE_DISPLAY,
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

  it("names the contact number as the last thing the customer reads", () => {
    expect(QUOTATION_OFFER_BODY).toContain("يُرجى التواصل معنا على {{4}}");
    expect(QUOTATION_OFFER_BODY.trim().endsWith(".")).toBe(true);
  });

  it("carries the company address in the footer", () => {
    expect(QUOTATION_OFFER_FOOTER).toContain("قرطبة للتوريدات");
    expect(QUOTATION_OFFER_FOOTER).toContain("مرسي مطروح");
  });

  it("shows the published contact number as the {{4}} parameter value", () => {
    expect(COMPANY_PHONE_DISPLAY).toBe("432-972-587");
  });
});

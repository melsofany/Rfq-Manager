import { describe, it, expect } from "vitest";
import {
  SUPPLIER_REGISTRATION_BODY,
  SUPPLIER_REGISTRATION_MISMATCH_BODY,
} from "../../modules/communications/service";

/**
 * The operator specified this wording explicitly, so it is a REQUIREMENT, not
 * copy that can drift. The message must:
 *   - open with «يسرنا بأن نبلغكم…» (it announces a purchase order was issued);
 *   - close with «حتى يتسنى لنا سداد مستحقاتكم المالية» (the supplier's reason to
 *     comply — he gets paid);
 *   - carry the responsibility notice and the double-entry instruction;
 *   - keep the URL button that opens the one-time link.
 *
 * Meta does NOT allow an approved template's body to be edited, so a wording
 * regression here is only recoverable by publishing a NEW template — cheaper to
 * catch in a test.
 */
describe("supplier_registration_ar template body", () => {
  it("opens with the required greeting and closes with the payment reason", () => {
    expect(SUPPLIER_REGISTRATION_BODY.startsWith("يسرنا بأن نبلغكم")).toBe(true);
    expect(SUPPLIER_REGISTRATION_BODY).toContain("حتى يتسنى لنا سداد مستحقاتكم المالية");
    // The closing must be the LAST thing the supplier reads, not buried mid-body.
    const tail = SUPPLIER_REGISTRATION_BODY.slice(-60);
    expect(tail).toContain("حتى يتسنى لنا سداد مستحقاتكم المالية");
  });

  it("announces a purchase order, names the fields, and demands the double entry", () => {
    expect(SUPPLIER_REGISTRATION_BODY).toContain("تم إصدار {{1}} لصالحكم");
    expect(SUPPLIER_REGISTRATION_BODY).toContain("المورد: {{2}}");
    expect(SUPPLIER_REGISTRATION_BODY).toContain("البيانات المطلوبة");
    expect(SUPPLIER_REGISTRATION_BODY).toContain("مرتين متطابقتين");
    expect(SUPPLIER_REGISTRATION_BODY).toContain("الرابط صالح حتى: {{4}}");
  });

  it("keeps the responsibility notice", () => {
    // WhatsApp templates carry no colour, so the notice is the only signal.
    expect(SUPPLIER_REGISTRATION_BODY).toContain(
      "مسؤولية صحة البيانات المدخلة تقع على عاتق المورد",
    );
  });

  it("uses exactly four body parameters in order", () => {
    const params = SUPPLIER_REGISTRATION_BODY.match(/\{\{\d+\}\}/g);
    expect(params).toEqual(["{{1}}", "{{2}}", "{{3}}", "{{4}}"]);
  });

  it("names the URL button the supplier taps", () => {
    expect(SUPPLIER_REGISTRATION_BODY).toContain("زر «إدخال البيانات»");
  });
});

describe("supplier_registration_mismatch_ar template body", () => {
  it("says nothing was recorded and asks for a careful re-entry", () => {
    expect(SUPPLIER_REGISTRATION_MISMATCH_BODY).toContain("غير مطابقة");
    expect(SUPPLIER_REGISTRATION_MISMATCH_BODY).toContain("لم يتم تسجيلها");
    expect(SUPPLIER_REGISTRATION_MISMATCH_BODY).toContain("مرتين متطابقتين");
  });

  it("still closes on the payment reason, so a refusal is not a dead end", () => {
    expect(SUPPLIER_REGISTRATION_MISMATCH_BODY).toContain("حتى يتسنى لنا سداد مستحقاتكم المالية");
  });
});

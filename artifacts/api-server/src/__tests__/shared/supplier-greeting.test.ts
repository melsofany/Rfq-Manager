import { describe, it, expect } from "vitest";
import {
  GREETING_REASON_LABEL,
  GREETING_TIER_LABEL,
  SUPPLIER_GREETING_BODY_PRELIMINARY,
  SUPPLIER_GREETING_BODY_REGISTERED,
  greetingChannels,
  greetingClosing,
  greetingOpener,
  greetingReasonFor,
  greetingTier,
  normalizeContactEmail,
  normalizeContactPhone,
  renderGreetingBody,
  shouldGreet,
} from "../../shared/supplier-greeting";

/** A supplier with everything needed to be paid. */
const COMPLETE = {
  name: "شركة النور للتوريدات",
  contactPerson: "أحمد محمد",
  commercialRegister: "123456",
  taxRegistration: "432972587",
  bankName: "البنك التجاري الدولي",
  bankAccountHolder: "شركة النور للتوريدات",
  bankAccountNumber: "1234567890",
  iban: null,
  swiftCode: "CIBEEGCX",
  bankBranch: "فرع مرسي مطروح",
};

/** The same supplier, but we cannot pay him yet. */
const INCOMPLETE = {
  ...COMPLETE,
  commercialRegister: null,
  taxRegistration: null,
  bankAccountNumber: null,
};

describe("greetingTier — registered vs preliminary", () => {
  it("calls a payable supplier «مورد مسجَّل»", () => {
    expect(greetingTier(COMPLETE)).toBe("registered");
    expect(GREETING_TIER_LABEL.registered).toBe("مورد مسجَّل");
  });

  it("calls a supplier we cannot pay «مورد مبدئي»", () => {
    expect(greetingTier(INCOMPLETE)).toBe("preliminary");
    expect(GREETING_TIER_LABEL.preliminary).toBe("مورد مبدئي");
  });

  it("accepts an IBAN in place of an account number, as the PO gate does", () => {
    // The two decisions must agree: a supplier the PO gate would accept must not
    // be greeted as preliminary. This is the defect the shared rule prevents.
    const ibanOnly = {
      ...COMPLETE,
      bankAccountNumber: null,
      iban: "EG380019000500000000263180002",
    };
    expect(greetingTier(ibanOnly)).toBe("registered");
  });

  it("treats a whitespace-only field as missing, not as filled", () => {
    expect(greetingTier({ ...COMPLETE, bankName: "   " })).toBe("preliminary");
  });
});

describe("greetingReasonFor — first contact and contact changes", () => {
  it("greets a supplier we have never addressed", () => {
    expect(greetingReasonFor(null, { phone: "201000000000", email: "a@b.com" })).toBe(
      "new_supplier",
    );
    expect(GREETING_REASON_LABEL.new_supplier).toBe("أول تعامل مع المورد");
  });

  it("does not greet again when nothing changed", () => {
    const prev = { phone: "201000000000", email: "a@b.com" };
    expect(greetingReasonFor(prev, { phone: "201000000000", email: "a@b.com" })).toBeNull();
    expect(shouldGreet(prev, { phone: "201000000000", email: "a@b.com" })).toBe(false);
  });

  it("greets on a phone change, ignoring formatting differences", () => {
    // The stored form is «+20 100 000 0000» and the new one is digits-only —
    // the SAME number, so this must NOT be treated as a change.
    const prev = { phone: "+20 100 000 0000", email: "a@b.com" };
    expect(greetingReasonFor(prev, { phone: "201000000000", email: "a@b.com" })).toBeNull();
    // A genuinely different number is a change.
    expect(greetingReasonFor(prev, { phone: "201111111111", email: "a@b.com" })).toBe(
      "phone_changed",
    );
  });

  it("greets on an email change, ignoring case and surrounding spaces", () => {
    const prev = { phone: "201000000000", email: "A@B.com " };
    expect(greetingReasonFor(prev, { phone: "201000000000", email: "a@b.com" })).toBeNull();
    expect(greetingReasonFor(prev, { phone: "201000000000", email: "new@b.com" })).toBe(
      "email_changed",
    );
  });

  it("reports both when phone and email changed together", () => {
    const prev = { phone: "201000000000", email: "a@b.com" };
    expect(greetingReasonFor(prev, { phone: "201111111111", email: "c@d.com" })).toBe(
      "phone_and_email",
    );
  });

  it("does not treat a supplier who never had an email as changing it every time", () => {
    // The regression this guards: `prev.email === null` and `current.email === null`
    // are EQUAL. A naive `!==` on raw values passes, but a comparison that
    // normalises null to "" and "" to something else would re-welcome him on
    // every single send.
    const prev = { phone: "201000000000", email: null };
    expect(greetingReasonFor(prev, { phone: "201000000000", email: null })).toBeNull();
    expect(greetingReasonFor(prev, { phone: "201000000000", email: "" })).toBeNull();
  });

  it("normalises the contact forms used for comparison", () => {
    expect(normalizeContactPhone("+20 (100) 000-0000")).toBe("201000000000");
    expect(normalizeContactPhone(null)).toBe("");
    expect(normalizeContactEmail("  A@B.COM ")).toBe("a@b.com");
    expect(normalizeContactEmail(undefined)).toBe("");
  });
});

describe("greetingChannels — which channel carries the welcome", () => {
  const both = { phone: "201000000000", email: "a@b.com" };

  it("uses every channel we hold for a first contact", () => {
    expect(greetingChannels("new_supplier", both)).toEqual({ whatsapp: true, email: true });
  });

  it("carries a phone-change welcome on WhatsApp ONLY", () => {
    // Re-welcoming on the unchanged email would repeat the introduction in a
    // thread the supplier never left.
    expect(greetingChannels("phone_changed", both)).toEqual({ whatsapp: true, email: false });
  });

  it("carries an email-change welcome on email ONLY", () => {
    expect(greetingChannels("email_changed", both)).toEqual({ whatsapp: false, email: true });
  });

  it("carries a both-changed welcome on both", () => {
    expect(greetingChannels("phone_and_email", both)).toEqual({ whatsapp: true, email: true });
  });

  it("never selects a channel we hold no value for", () => {
    expect(greetingChannels("new_supplier", { phone: null, email: null })).toEqual({
      whatsapp: false,
      email: false,
    });
    // A supplier with no phone must not be retried on WhatsApp forever.
    expect(greetingChannels("phone_changed", { phone: null, email: "a@b.com" })).toEqual({
      whatsapp: false,
      email: false,
    });
  });

  it("shouldGreet is false when no channel is reachable", () => {
    expect(shouldGreet(null, { phone: null, email: null })).toBe(false);
    expect(shouldGreet(null, { phone: "201000000000", email: null })).toBe(true);
  });
});

describe("greeting wording", () => {
  it("introduces the company only to a preliminary supplier", () => {
    expect(greetingOpener("registered")).toBe("مرحبًا {{1}}،");
    expect(greetingOpener("preliminary")).toBe("مرحبًا بكم في قرطبة للتوريدات {{1}}،");
  });

  it("congratulates the registered supplier on completing his data", () => {
    const body = SUPPLIER_GREETING_BODY_REGISTERED;
    expect(body).toContain("تم تسجيلكم لدينا");
    expect(body).toContain("ونبارك لكم");
  });

  it("welcomes the preliminary supplier and asks him to complete his data", () => {
    const body = SUPPLIER_GREETING_BODY_PRELIMINARY;
    expect(body).toContain("ترحيبكم وتسجيلكم مبدئيًا");
    expect(body).toContain("استكمال بيانات التسجيل");
  });

  it("states the company's ambition to grow the business with him", () => {
    expect(SUPPLIER_GREETING_BODY_REGISTERED).toContain("نطمح إلى تعزيز العمل معكم");
    expect(SUPPLIER_GREETING_BODY_PRELIMINARY).toContain("نطمح إلى تعزيز العمل معكم");
  });

  it("names the guide as covering BOTH channels, and what it explains", () => {
    // The operator asked for the guide to explain pricing via WhatsApp and email
    // — a body that omits a channel sends the supplier to the wrong one.
    for (const body of [SUPPLIER_GREETING_BODY_REGISTERED, SUPPLIER_GREETING_BODY_PRELIMINARY]) {
      expect(body).toContain("دليل التسعير");
      expect(body).toContain("واتساب");
      expect(body).toContain("البريد الإلكتروني");
    }
  });

  it("never promises an attachment it does not carry", () => {
    // The false-claim class: a body saying «بالمستند المرفق» on a message with no
    // document header is a promise the supplier will not see fulfilled.
    const withGuide = renderGreetingBody("registered", true);
    const withoutGuide = renderGreetingBody("registered", false);
    expect(withGuide).toContain("بالمستند المرفق");
    expect(withoutGuide).not.toContain("بالمستند المرفق");
    expect(withoutGuide).toContain("فريق المشتريات");
  });

  it("uses exactly two body parameters in order, as the template declares", () => {
    for (const body of [SUPPLIER_GREETING_BODY_REGISTERED, SUPPLIER_GREETING_BODY_PRELIMINARY]) {
      expect(body.match(/\{\{\d+\}\}/g)).toEqual(["{{1}}", "{{2}}"]);
    }
  });

  it("does not end the body on a parameter — Meta rejects that (2388299)", () => {
    for (const body of [SUPPLIER_GREETING_BODY_REGISTERED, SUPPLIER_GREETING_BODY_PRELIMINARY]) {
      const tail = body.trim().slice(-2);
      expect(tail).not.toMatch(/\}\}$/);
    }
  });

  it("keeps the tier label as the placeholder the send fills in", () => {
    // The send passes GREETING_TIER_LABEL[tier] as {{2}}, so the sentence must
    // actually place {{2}} where the label belongs.
    expect(greetingTierSentenceProbe("registered")).toContain("{{2}}");
    expect(greetingClosing("registered", true)).toContain("نطمح");
  });
});

/** Local probe: the tier sentence is not exported directly, so read it off the body. */
function greetingTierSentenceProbe(tier: "registered" | "preliminary"): string {
  return renderGreetingBody(tier, true);
}

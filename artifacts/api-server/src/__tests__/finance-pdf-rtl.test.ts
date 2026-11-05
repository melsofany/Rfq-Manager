import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PDFDocument from "pdfkit";
import { rtl, rtlLabelValue } from "../modules/finance/rtl-text";
import {
  generateSupplierStatementPdf,
  type SupplierStatementOptions,
} from "../modules/finance/supplier-statement-pdf";
import {
  generatePaymentOrderPdf,
  type PaymentOrderOptions,
} from "../modules/finance/payment-order-pdf";

// pdfkit draws a string strictly left-to-right and shapes each word on its own,
// so a multi-word Arabic phrase must have its WORD ORDER reversed exactly once.
// Reversing twice restores the logical order — that is how «إجمالي المستحق»
// reached a supplier as «المستحق: إجمالي» — and not reversing at all leaves
// «البنك التجاري الدولي» reading «الدولي التجاري البنك».

const bank = {
  bankName: "البنك التجاري الدولي",
  bankAccountHolder: "كابيتال جروب",
  bankAccountNumber: "1234567890",
  iban: "EG380019000500000001234567890",
  swiftCode: "NBEGEGCX",
  bankBranch: "فرع مرسي مطروح",
};

const statement: SupplierStatementOptions = {
  statementNo: "STM-2026-000001",
  generatedAt: "2026-11-03T10:00:00.000Z",
  supplierName: "كابيتال جروب",
  bank,
  rows: [
    {
      internalPoNo: "PO-2026-000005",
      sheetPoNo: "P26E11407",
      selectedAt: "2026-10-01T00:00:00.000Z",
      dueAmount: 17500,
      paidAmount: 5000,
      remainingAmount: 12500,
      status: "partial",
    },
  ],
  totals: { due: 17500, paid: 5000, remaining: 12500 },
  preparedBy: "سارة أحمد",
};

const paymentOrder: PaymentOrderOptions = {
  paymentNo: "PAY-2026-000001",
  paymentDate: "2026-11-03",
  supplierName: "كابيتال جروب",
  internalPoNo: "PO-2026-000005",
  sheetPoNo: "P26E11407",
  bank,
  amount: 12500,
  poTotal: 17500,
  paidBefore: 5000,
  remainingAfter: 0,
  method: "تحويل بنكي",
  reference: "TRF-8891",
  notes: "يُسدد خلال أسبوع",
  preparedBy: "سارة أحمد",
};

/** Every string pdfkit was actually asked to draw. */
let drawn: string[] = [];
const originalText = (PDFDocument.prototype as unknown as { text: unknown }).text;

beforeEach(() => {
  drawn = [];
  (PDFDocument.prototype as unknown as Record<string, unknown>).text = function (
    this: unknown,
    text: unknown,
    ...rest: unknown[]
  ) {
    if (typeof text === "string") drawn.push(text);
    return (originalText as (...a: unknown[]) => unknown).call(this, text, ...rest);
  };
});

afterEach(() => {
  (PDFDocument.prototype as unknown as Record<string, unknown>).text = originalText;
});

const contains = (s: string) => drawn.some((d) => d.includes(s));

describe("Arabic word order in the printable finance documents", () => {
  describe("rtl() — the one rule", () => {
    it("reverses a multi-word Arabic phrase exactly once", () => {
      expect(rtl("البنك التجاري الدولي")).toBe("الدولي التجاري البنك");
      expect(rtl("كابيتال جروب")).toBe("جروب كابيتال");
      expect(rtl("فرع مرسي مطروح")).toBe("مطروح مرسي فرع");
    });

    it("leaves Latin-only, numeric and single-word text alone", () => {
      expect(rtl("NBEGEGCX")).toBe("NBEGEGCX");
      expect(rtl("1234567890")).toBe("1234567890");
      expect(rtl("EG380019000500000001234567890")).toBe("EG380019000500000001234567890");
      expect(rtl("البنك")).toBe("البنك");
    });

    it("handles empty and nullish input", () => {
      expect(rtl("")).toBe("");
      expect(rtl(null)).toBe("");
      expect(rtl(undefined)).toBe("");
      expect(rtl("   ")).toBe("");
    });

    it("puts the value beside its label, with the label rightmost", () => {
      const cell = rtlLabelValue("إجمالي المستحق:", "17,500.00");
      const words = cell.split(" ");
      expect(words[0]).toBe("17,500.00");
      expect(words[words.length - 1]).toBe("إجمالي");
    });

    it("keeps a Latin value attached to its Arabic label", () => {
      expect(rtlLabelValue("رقم:", "STM-2026-000001")).toBe("STM-2026-000001 رقم:");
      expect(rtlLabelValue("المرجع:", "TRF-8891")).toBe("TRF-8891 المرجع:");
    });

    it("reversing TWICE cancels out — the composition that swapped the totals", () => {
      const doubled = rtl(`${rtl("إجمالي المستحق:")} 17,500.00`);
      // the label's words come back in LOGICAL order → reader sees «المستحق: إجمالي»
      expect(doubled).toBe("17,500.00 إجمالي المستحق:");
      // composing first and reversing once is the correct form
      expect(rtlLabelValue("إجمالي المستحق:", "17,500.00")).not.toBe(doubled);
    });
  });

  describe("supplier statement (كشف حساب مورد)", () => {
    it("lays the supplier name out RTL", async () => {
      await generateSupplierStatementPdf(statement);
      expect(contains(rtl("كابيتال جروب"))).toBe(true);
      expect(contains("كابيتال جروب")).toBe(false);
    });

    it("lays every bank value out RTL — an Arabic bank name is not Latin", async () => {
      await generateSupplierStatementPdf(statement);
      // The bank name/branch are Arabic and MUST be reversed; the account
      // number, IBAN and SWIFT have no Arabic words and pass through unchanged.
      expect(contains(rtl("البنك التجاري الدولي"))).toBe(true);
      expect(contains("البنك التجاري الدولي")).toBe(false);
      expect(contains(rtl("فرع مرسي مطروح"))).toBe(true);
      expect(contains("فرع مرسي مطروح")).toBe(false);
      expect(contains("1234567890")).toBe(true);
      expect(contains("EG380019000500000001234567890")).toBe(true);
      expect(contains("NBEGEGCX")).toBe(true);
    });

    it("composes the totals label with its amount and reverses the RESULT once", async () => {
      await generateSupplierStatementPdf(statement);
      const due = rtlLabelValue("إجمالي المستحق:", "17,500.00");
      expect(contains(due)).toBe(true);
      // the double-reversed form must never be drawn
      expect(contains(rtl(`17,500.00 ${rtl("إجمالي المستحق:")}`))).toBe(false);
    });
  });

  describe("payment order (أمر دفع)", () => {
    it("lays the bank values and the supplier name out RTL", async () => {
      await generatePaymentOrderPdf(paymentOrder);
      expect(contains(rtl("البنك التجاري الدولي"))).toBe(true);
      expect(contains("البنك التجاري الدولي")).toBe(false);
      expect(contains(rtl("كابيتال جروب"))).toBe(true);
    });

    it("keeps the amount with its currency and the notes with their label", async () => {
      await generatePaymentOrderPdf(paymentOrder);
      expect(contains(rtl("12,500.00 ج.م"))).toBe(true);
      expect(contains(rtlLabelValue("ملاحظات:", "يُسدد خلال أسبوع"))).toBe(true);
      expect(contains(rtlLabelValue("المرجع:", "TRF-8891"))).toBe(true);
    });
  });
});

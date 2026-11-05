import { describe, it, expect } from "vitest";
import {
  generatePaymentOrderPdf,
  amountInArabicWords,
  type PaymentOrderOptions,
} from "../modules/finance/payment-order-pdf";
import {
  generateSupplierStatementPdf,
  statementColumnWidths,
  type SupplierStatementOptions,
} from "../modules/finance/supplier-statement-pdf";

const bank = {
  bankName: "البنك الأهلي المصري",
  bankAccountHolder: "شركة الأمل للتوريدات",
  bankAccountNumber: "1234567890",
  iban: "EG380019000500000001234567890",
  swiftCode: "NBEGEGCX",
  bankBranch: "مرسي مطروح",
};

const order: PaymentOrderOptions = {
  paymentNo: "PAY-2026-000123",
  paymentDate: "2026-11-03",
  supplierName: "شركة الأمل للتوريدات",
  internalPoNo: "PO-2026-000005",
  sheetPoNo: "P26E11407",
  bank,
  amount: 12500,
  poTotal: 17500,
  paidBefore: 5000,
  remainingAfter: 0,
  method: "تحويل بنكي",
  reference: "TRF-8891",
  notes: null,
  preparedBy: "سارة أحمد",
};

describe("payment order PDF (أمر دفع)", () => {
  it("renders a real PDF with the Arabic font embedded", async () => {
    const pdf = await generatePaymentOrderPdf(order);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2000);
    // /FontFile2 proves the Amiri subset is EMBEDDED — without it the Arabic
    // glyphs fall back to a font the bank's viewer does not have.
    expect(pdf.toString("latin1")).toContain("/FontFile2");
  });

  it("renders a partial payment and a payment with no bank details", async () => {
    const partial = await generatePaymentOrderPdf({ ...order, remainingAfter: 5000 });
    expect(partial.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const noBank = await generatePaymentOrderPdf({
      ...order,
      bank: { bankName: null, bankAccountHolder: null, bankAccountNumber: null, iban: null },
    });
    expect(noBank.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders with no purchase-order reference and no preparer", async () => {
    const pdf = await generatePaymentOrderPdf({
      ...order,
      internalPoNo: null,
      sheetPoNo: null,
      preparedBy: null,
    });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("amount in Arabic words", () => {
  it("writes a whole amount in words", () => {
    expect(amountInArabicWords(12500)).toContain("اثنا عشر");
    expect(amountInArabicWords(12500)).toContain("خمسمائة");
    expect(amountInArabicWords(12500)).toContain("لا غير");
  });

  it("handles the scales and small numbers", () => {
    expect(amountInArabicWords(0)).toContain("صفر");
    expect(amountInArabicWords(1000)).toContain("ألف");
    expect(amountInArabicWords(2000)).toContain("ألفان");
    expect(amountInArabicWords(1_000_000)).toContain("مليون");
    expect(amountInArabicWords(15)).toContain("خمسة عشر");
    expect(amountInArabicWords(21)).toContain("واحد وعشرون");
  });

  it("includes piastres when the amount has a fraction", () => {
    const words = amountInArabicWords(1200.5);
    expect(words).toContain("قرشًا");
    // The fraction must be stated SEPARATELY, not folded into the pounds.
    expect(words).toContain("ألف ومائتان");
    expect(words).toContain("وخمسون قرشًا");
    expect(words).toContain("جنيهًا مصريًا لا غير");
  });

  it("omits the piastres clause for a whole amount", () => {
    expect(amountInArabicWords(1200)).not.toContain("قرشًا");
  });

  it("never drops the currency or the closing phrase", () => {
    for (const v of [1, 99, 1500, 987654.25]) {
      const w = amountInArabicWords(v);
      expect(w).toMatch(/^فقط /);
      expect(w).toContain("جنيهًا مصريًا لا غير");
    }
  });
});

describe("supplier statement PDF (كشف حساب مورد)", () => {
  const stmt: SupplierStatementOptions = {
    statementNo: "STM-2026-000007",
    generatedAt: "2026-11-03T10:00:00.000Z",
    supplierName: "شركة الأمل للتوريدات",
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
      {
        internalPoNo: "PO-2026-000011",
        sheetPoNo: "P26E11502",
        selectedAt: "2026-10-12T00:00:00.000Z",
        dueAmount: 4000,
        paidAmount: 0,
        remainingAmount: 4000,
        status: "unpaid",
      },
    ],
    totals: { due: 21500, paid: 5000, remaining: 16500 },
    preparedBy: "سارة أحمد",
  };

  it("renders a real PDF with the Arabic font embedded", async () => {
    const pdf = await generateSupplierStatementPdf(stmt);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("/FontFile2");
  });

  it("renders an empty statement (nothing outstanding) without throwing", async () => {
    const pdf = await generateSupplierStatementPdf({
      ...stmt,
      rows: [],
      totals: { due: 0, paid: 0, remaining: 0 },
    });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("keeps a two-row statement on ONE page", async () => {
    // The footer is drawn at `page.height - 54`; a bottom margin larger than
    // that pushes it outside the content area and pdfkit silently appends a
    // blank page per draw. A short statement must stay one page.
    const pdf = await generateSupplierStatementPdf(stmt);
    const pages = (pdf.toString("latin1").match(/\/Type \/Page(?![s])/g) ?? []).length;
    expect(pages).toBe(1);
  });

  it("sizes the columns so the last one cannot be clipped", () => {
    // A4 at 36pt margins ⇒ 523pt of usable width.
    const w = statementColumnWidths(523);
    const sum = w.po + w.sheet + w.date + w.due + w.paid + w.remaining;
    expect(sum).toBe(523);
    // «12,500.00» must fit; the unaccounted-for column rendered «12,5».
    expect(w.remaining).toBeGreaterThanOrEqual(70);
    expect(w.po).toBeGreaterThan(80);
  });

  it("paginates a long statement and stamps every page", async () => {
    // 90 rows overflow one A4 page, so the continuation page must exist and
    // carry the header/footer again — an unattributed page is not filable.
    const rows = Array.from({ length: 90 }, (_, i) => ({
      internalPoNo: `PO-2026-${String(i + 1).padStart(6, "0")}`,
      sheetPoNo: `P26E${11000 + i}`,
      selectedAt: "2026-10-01T00:00:00.000Z",
      dueAmount: 1000,
      paidAmount: 0,
      remainingAmount: 1000,
      status: "unpaid",
    }));
    const pdf = await generateSupplierStatementPdf({
      ...stmt,
      rows,
      totals: { due: 90000, paid: 0, remaining: 90000 },
    });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // More than one page ⇒ the document object tree carries several /Page
    // entries (pdfkit writes a /Kids array).
    const text = pdf.toString("latin1");
    expect(text).toContain("/Type /Page");
    expect((text.match(/\/Type \/Page[^s]/g) ?? []).length).toBeGreaterThan(1);
  });
});

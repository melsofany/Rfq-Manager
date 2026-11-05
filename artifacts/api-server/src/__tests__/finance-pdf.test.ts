import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
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
import { rtlColumnX, rtlSlotX } from "../modules/finance/pdf-layout";

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

// ─── RTL geometry ───────────────────────────────────────────────────────────
// The documents are Arabic: the first logical column must sit at the RIGHT
// edge and each following one step leftwards. Laid out from the left margin
// instead, the table reads mirrored — «أمر الشراء» (the order number, which
// identifies the row) ends up on the left where «المتبقي» belongs.
describe("RTL column geometry", () => {
  it("places logical column 0 at the RIGHT edge", () => {
    const widths = [100, 80, 60];
    const left = 36;
    const total = widths.reduce((a, b) => a + b, 0);
    // column 0 starts where the block ends, minus its own width
    expect(rtlColumnX(widths, 0, left)).toBe(left + total - widths[0]);
    // the last column starts at the left margin
    expect(rtlColumnX(widths, 2, left)).toBe(left);
  });

  it("keeps every column inside the block and in strictly decreasing X", () => {
    const widths = [80, 70, 90, 60, 55, 65];
    const left = 36;
    const total = widths.reduce((a, b) => a + b, 0);
    const xs = widths.map((_, i) => rtlColumnX(widths, i, left));
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(left);
      expect(x).toBeLessThanOrEqual(left + total);
    }
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThan(xs[i - 1]);
    // columns tile the block with no gap and no overlap
    const right = rtlColumnX(widths, 0, left) + widths[0];
    expect(right).toBe(left + total);
    for (let i = 0; i < widths.length - 1; i++) {
      expect(xs[i + 1] + widths[i + 1]).toBeCloseTo(xs[i], 5);
    }
  });

  it("places equal-width slot 0 at the RIGHT edge", () => {
    const left = 36;
    const total = 300;
    expect(rtlSlotX(0, 3, left, total)).toBeCloseTo(left + total - total / 3, 5);
    expect(rtlSlotX(2, 3, left, total)).toBeCloseTo(left, 5);
    // and the slots tile the full width
    const xs = [0, 1, 2].map((i) => rtlSlotX(i, 3, left, total));
    expect(Math.min(...xs)).toBeCloseTo(left, 5);
    expect(Math.max(...xs) + total / 3).toBeCloseTo(left + total, 5);
  });
});

// ─── the layouts must USE the RTL geometry ──────────────────────────────────
// The helper above is only worth having if the documents call it. A column laid
// out as `M + cols.po` sits on the LEFT, which is the mirror image of Arabic
// reading order — that is the regression these guards pin.
describe("finance documents lay their columns out right-to-left", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

  it("the supplier statement positions its table through the RTL helper", () => {
    const src = read("../modules/finance/supplier-statement-pdf.ts");
    expect(src).toContain("rtlColumnX(colWArr");
    expect(src).toContain("rtlSlotX(i, 3, M, CW)");
    // the mirrored form must be gone
    expect(src).not.toContain("M + cols.po,");
    expect(src).not.toContain("M + cols.po + cols.sheet,");
  });

  it("the payment order positions its slots through the RTL helper", () => {
    const src = read("../modules/finance/payment-order-pdf.ts");
    expect(src).toContain("rtlSlotX(i, ctxRows.length, M, CW)");
    expect(src).toContain("rtlSlotX(i, sigCols.length, M, CW)");
    expect(src).not.toContain("M + (CW / 3) * i");
  });

  it("anchors each label at the RIGHT edge with its value beside it", () => {
    // The label/value pairing is what reads as RTL: the label sits against the
    // right edge and its value immediately to the left. A value pinned to the
    // left margin instead reads as an unrelated column.
    const pay = read("../modules/finance/payment-order-pdf.ts");
    expect(pay).toContain("M + CW - LABEL_W");
    expect(pay).not.toContain('width: CW / 2, align: "left"');

    const stmt = read("../modules/finance/supplier-statement-pdf.ts");
    expect(stmt).toContain("M + CW - BANK_LABEL_W");
    expect(stmt).not.toContain("width: CW / 2 - 16");
  });
});

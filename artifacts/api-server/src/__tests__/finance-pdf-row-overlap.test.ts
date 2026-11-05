import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PDFDocument from "pdfkit";
import { resolve } from "path";
import { rtl, rtlLabelValue } from "../modules/finance/rtl-text";
import {
  generateSupplierStatementPdf,
  type SupplierStatementOptions,
} from "../modules/finance/supplier-statement-pdf";
import {
  generatePaymentOrderPdf,
  type PaymentOrderOptions,
} from "../modules/finance/payment-order-pdf";

// A label/value block used to advance by a CONSTANT step (11pt for the bank
// rows, 16pt for the reference rows). One line of Amiri at 8.5pt is 14.9pt
// tall, so every row already overprinted the next one slightly — and a long
// account holder name, which wraps onto a second line, was drawn straight
// over the row beneath it. Rows are measured now; these guards fail if anyone
// reintroduces a fixed step.

const LONG_HOLDER =
  "SINAMIX AUTOMATION FOR ELECTRICAL SUPPLIES AND IMPORT AND EXPORT ELMOATAZ ATEF HASSAN MOHAMED AND HIS PARTNERS";

const bank = {
  bankName: "البنك التجاري الدولي",
  bankAccountHolder: LONG_HOLDER,
  bankAccountNumber: "1234567890",
  iban: "EG380019000500000001234567890",
  swiftCode: "NBEGEGCX",
  bankBranch: "فرع مرسي مطروح",
};

const statement: SupplierStatementOptions = {
  statementNo: "STM-2026-000001",
  generatedAt: "2026-11-03T10:00:00.000Z",
  supplierName: "sinamix",
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
  supplierName: "sinamix",
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

interface Draw {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  height: number;
}

let draws: Draw[] = [];
let fontSize = 12;
const proto = PDFDocument.prototype as unknown as Record<string, unknown>;
const originalText = proto.text;
const originalFontSize = proto.fontSize;

/** An Amiri-only document, used to measure what a draw actually occupies. */
function measurer(): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4" });
  doc.registerFont("Amiri", resolve("src/assets/fonts/Amiri-Regular.ttf"));
  doc.font("Amiri");
  return doc;
}
let measure: PDFKit.PDFDocument;

beforeEach(() => {
  draws = [];
  fontSize = 12;
  measure = measurer();
  proto.fontSize = function (this: unknown, size: number) {
    fontSize = size;
    return (originalFontSize as (s: number) => unknown).call(this, size);
  };
  proto.text = function (this: unknown, text: unknown, ...rest: unknown[]) {
    const doc = this as { x: number; y: number };
    let x = doc.x;
    let y = doc.y;
    let options: { width?: number } = {};
    if (typeof rest[0] === "number" && typeof rest[1] === "number") {
      x = rest[0];
      y = rest[1];
      options = (rest[2] as { width?: number }) ?? {};
    } else if (typeof rest[0] === "number") {
      x = rest[0];
      options = (rest[1] as { width?: number }) ?? {};
    } else {
      options = (rest[0] as { width?: number }) ?? {};
    }
    if (typeof text === "string") {
      measure.fontSize(fontSize);
      draws.push({
        text,
        x,
        y,
        width: options.width ?? 0,
        fontSize,
        height: measure.heightOfString(text, options.width ? { width: options.width } : {}),
      });
    }
    return (originalText as (...a: unknown[]) => unknown).call(this, text, ...rest);
  };
});

afterEach(() => {
  proto.text = originalText;
  proto.fontSize = originalFontSize;
});

const oneLine = (size: number) => {
  measure.fontSize(size);
  return measure.heightOfString("أب", {});
};

/** Vertical overlaps between draws that share a column AND a font size. */
function boxOverlaps(tolerance = 1) {
  const bad: Array<{ overlap: number; a: string; b: string }> = [];
  for (let i = 0; i < draws.length; i++) {
    for (let j = i + 1; j < draws.length; j++) {
      const a = draws[i];
      const b = draws[j];
      if (a.fontSize !== b.fontSize) continue; // a large glyph box merely looks taller
      if (Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) <= 1) continue;
      const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (overlap > tolerance) {
        bad.push({
          overlap: Math.round(overlap * 10) / 10,
          a: a.text.slice(0, 40),
          b: b.text.slice(0, 40),
        });
      }
    }
  }
  return bad;
}

/** The rows of one label/value block, top to bottom. */
function block(value: string, labels: string[]): Draw[] {
  const wanted = new Set([value, ...labels.map((l) => rtl(l))]);
  return draws.filter((d) => wanted.has(d.text)).sort((a, b) => a.y - b.y);
}

/** A row is its label and its value, drawn on the same baseline. */
function rowsByY(list: Draw[]): Draw[][] {
  const groups: Draw[][] = [];
  for (const d of list) {
    const g = groups.find((row) => Math.abs(row[0].y - d.y) < 0.6);
    if (g) g.push(d);
    else groups.push([d]);
  }
  return groups.sort((a, b) => a[0].y - b[0].y);
}

/** No row may start before the row above it has finished. */
function assertRowsStack(list: Draw[], expectedRows: number) {
  const groups = rowsByY(list);
  expect(groups).toHaveLength(expectedRows);
  for (let i = 1; i < groups.length; i++) {
    const aboveY = groups[i - 1][0].y;
    const aboveH = Math.max(...groups[i - 1].map((d) => d.height));
    expect(groups[i][0].y).toBeGreaterThanOrEqual(aboveY + aboveH - 0.5);
  }
}

const BANK_LABELS = ["البنك", "اسم صاحب الحساب", "رقم الحساب", "IBAN", "SWIFT", "الفرع"];

describe("rows are measured, so a long value never overprints the next row", () => {
  it("gives every bank row its own measured height in the supplier statement", async () => {
    await generateSupplierStatementPdf(statement);
    const rows = block(rtl(LONG_HOLDER), BANK_LABELS);
    assertRowsStack(rows, 6); // the six bank rows, one of which wraps

    // The value really does wrap, and the row below clears the whole of it.
    const value = rows.find((d) => d.text === rtl(LONG_HOLDER))!;
    expect(value.height).toBeGreaterThan(oneLine(8.5) * 1.8);
    const below = rows.filter((d) => d.y > value.y);
    for (const row of below) expect(row.y).toBeGreaterThanOrEqual(value.y + value.height - 0.5);
  });

  it("gives every bank row its own measured height in the payment order", async () => {
    await generatePaymentOrderPdf(paymentOrder);
    const rows = block(rtl(LONG_HOLDER), BANK_LABELS);
    assertRowsStack(rows, 6);

    const value = rows.find((d) => d.text === rtl(LONG_HOLDER))!;
    expect(value.height).toBeGreaterThan(oneLine(9) * 1.8);
    const below = rows.filter((d) => d.y > value.y);
    for (const row of below) expect(row.y).toBeGreaterThanOrEqual(value.y + value.height - 0.5);
  });

  it("gives every reference row its own measured height in the payment order", async () => {
    await generatePaymentOrderPdf(paymentOrder);
    const rows = block("", [
      "رقم أمر الشراء",
      "رقم أمر الشراء (المورد)",
      "تاريخ أمر الدفع",
      "طريقة السداد",
    ]);
    assertRowsStack(rows, 4);
  });

  it("grows the payment-order amount block when the amount in words wraps", async () => {
    await generatePaymentOrderPdf({ ...paymentOrder, amount: 1_234_567.89 });
    const words = draws.find((d) => d.text.includes("فقط") && d.text.includes("جنيه"));
    expect(words).toBeDefined();
    const amount = draws.find((d) => d.text.includes("1,234,567.89"))!;
    // The words line starts below the whole amount, not on top of it.
    expect(words!.y).toBeGreaterThanOrEqual(amount.y + amount.height - 0.5);
  });

  it("keeps the signature rule below the name it belongs to", async () => {
    await generateSupplierStatementPdf({
      ...statement,
      preparedBy: "محمد عبد الرحمن السيد إبراهيم الشافعي",
    });
    const label = draws.find((d) => d.text === rtl("أعدّه"))!;
    const name = draws.find((d) => d.text === rtl("محمد عبد الرحمن السيد إبراهيم الشافعي"))!;
    expect(name.y).toBeGreaterThanOrEqual(label.y + label.height - 0.5);
  });

  it("fits every column heading on one line inside its own column", async () => {
    // A heading longer than its column is silently clipped: the header row is a
    // fixed-height bar drawn with lineBreak:false.
    await generateSupplierStatementPdf(statement);
    const heading = draws.find((d) => d.text === rtl("رقم أمر توريد العميل"));
    expect(heading).toBeDefined();
    expect(measure.fontSize(8.5).widthOfString(heading!.text)).toBeLessThanOrEqual(heading!.width);
    expect(heading!.height).toBeLessThanOrEqual(oneLine(8.5) * 1.2);
  });

  it("has no overlapping rows anywhere in the supplier statement", async () => {
    await generateSupplierStatementPdf(statement);
    expect(boxOverlaps()).toEqual([]);
  });

  it("has no overlapping rows anywhere in the payment order", async () => {
    await generatePaymentOrderPdf(paymentOrder);
    // The big amount and the words-of-amount line are drawn at different sizes,
    // so the same-size scan skips that pair; the dedicated case above covers it.
    const bad = boxOverlaps().filter(
      (o) => !(o.a.includes("PAYMENT ORDER") || o.b.includes("PAYMENT ORDER")),
    );
    expect(bad).toEqual([]);
  });

  it("still composes the totals and the label/value pairs once", async () => {
    await generateSupplierStatementPdf(statement);
    const totals = draws.filter((d) => d.text.includes("إجمالي"));
    expect(totals).toHaveLength(3);
    expect(totals.some((d) => d.text === rtlLabelValue("إجمالي المستحق:", "17,500.00"))).toBe(true);
  });
});

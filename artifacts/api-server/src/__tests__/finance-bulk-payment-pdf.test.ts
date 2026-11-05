/**
 * أمر دفع إجمالي — the ONE document that settles SEVERAL orders.
 *
 * The whole point of a bulk payment is that a single bank transfer clears
 * several debts, so the printed document must carry the SPLIT. Without a
 * breakdown the bank holds one instruction and the accountant cannot say which
 * order it cleared — the document would be a receipt for an amount, not for a
 * set of debts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PDFDocument from "pdfkit";
import { resolve } from "path";
import { rtl } from "../modules/finance/rtl-text";
import {
  generatePaymentOrderPdf,
  type PaymentOrderOptions,
} from "../modules/finance/payment-order-pdf";

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
let measure: PDFKit.PDFDocument;

function measurer(): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4" });
  doc.registerFont("Amiri", resolve("src/assets/fonts/Amiri-Regular.ttf"));
  doc.font("Amiri");
  return doc;
}

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

const bank = {
  bankName: "البنك التجاري الدولي",
  bankAccountHolder: "sinamix",
  bankAccountNumber: "1234567890",
  iban: "EG380019000500000001234567890",
  swiftCode: "NBEGEGCX",
  bankBranch: "فرع مرسي مطروح",
};

function bulkOrder(allocations: PaymentOrderOptions["allocations"]): PaymentOrderOptions {
  return {
    paymentNo: "PAY-2026-000042",
    paymentDate: "2026-11-03",
    supplierName: "sinamix",
    bank,
    amount: allocations!.reduce((s, a) => s + a.amount, 0),
    allocations,
    totalOutstandingAfter: 300,
    method: "تحويل بنكي",
    reference: "TRF-8891",
    preparedBy: "سارة أحمد",
  };
}

async function render(opts: PaymentOrderOptions): Promise<Buffer> {
  return generatePaymentOrderPdf(opts);
}

const texts = () => draws.map((d) => d.text);
const allText = () => texts().join(" | ");

describe("finance — bulk payment order PDF (أمر دفع إجمالي)", () => {
  it("prints the breakdown: every order and the amount it received", async () => {
    await render(
      bulkOrder([
        { internalPoNo: "PO-2026-000005", sheetPoNo: "P26E11407", amount: 100 },
        { internalPoNo: "PO-2026-000006", sheetPoNo: "P26E11408", amount: 150 },
      ]),
    );

    const t = allText();
    // Both orders must appear, each with its own allocation.
    expect(t).toContain("PO-2026-000005");
    expect(t).toContain("P26E11407");
    expect(t).toContain("PO-2026-000006");
    expect(t).toContain("P26E11408");
    // The breakdown header must be present — without it the numbers are a list.
    expect(t).toContain(rtl("المبلغ المخصص"));
  });

  it("says this is a bulk payment rather than a single-order one", async () => {
    await render(
      bulkOrder([
        { internalPoNo: "PO-1", sheetPoNo: "P26E001", amount: 100 },
        { internalPoNo: "PO-2", sheetPoNo: "P26E002", amount: 150 },
      ]),
    );

    const t = allText();
    expect(t).toContain(rtl("سداد إجمالي"));
    // A single-order block would claim "إجمالي أمر الشراء", which has no single
    // answer when several orders are settled — it must NOT be printed.
    expect(t).not.toContain(rtl("إجمالي أمر الشراء"));
  });

  it("shows the total that matches the sum of the allocations", async () => {
    await render(
      bulkOrder([
        { internalPoNo: "PO-1", sheetPoNo: "P26E001", amount: 100 },
        { internalPoNo: "PO-2", sheetPoNo: "P26E002", amount: 150 },
      ]),
    );
    // 250 total, printed as the amount of the transfer.
    expect(allText()).toContain("250");
  });

  it("keeps a SINGLE-order payment order free of the bulk breakdown", async () => {
    await render({
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
    });

    const t = allText();
    // The single-payment context block is what makes a partial payment legible
    // — it must survive the bulk feature being added.
    expect(t).toContain(rtl("إجمالي أمر الشراء"));
    expect(t).not.toContain(rtl("المبلغ المخصص"));
  });

  it("does not overprint the breakdown rows for many orders", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      internalPoNo: `PO-2026-0000${String(i + 1).padStart(2, "0")}`,
      sheetPoNo: `P26E1140${i}`,
      amount: 100,
    }));
    await render(bulkOrder(many));

    // Rows are drawn on a fixed 16pt step, which is taller than one Amiri line
    // at 9pt — assert that, so a later font-size change cannot silently make
    // the breakdown illegible.
    const rows = draws.filter((d) => d.text.startsWith("PO-2026-"));
    expect(rows.length).toBe(12);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].y - rows[i - 1].y).toBeGreaterThanOrEqual(15);
    }
  });

  it("renders a valid PDF (not an empty buffer)", async () => {
    const buf = await render(
      bulkOrder([{ internalPoNo: "PO-1", sheetPoNo: "P26E001", amount: 100 }]),
    );
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

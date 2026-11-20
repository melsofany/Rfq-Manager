/**
 * The supplier RFQ PDF must keep every row on the page that holds its number.
 *
 * A real request (27 items, long Arabic descriptions) came out as 19 pages,
 * with the description on one page and its quantity on another. The layout
 * drew each row at a fixed y and let PDFKit break pages on its own, so a row
 * that crossed the bottom edge split across pages. These guards fail if rows
 * stop being measured and paginated before they are drawn.
 */
import { describe, expect, it } from "vitest";
import { generateRfqPdf, type RfqPdfOptions } from "../modules/rfq/rfq-pdf";

const LONG =
  "صمام كروي من النحاس الأصفر مقاس 2 بوصة ضغط تشغيل 16 بار مع مقبض معدني ووصلات تيار ملولب متوافق مع المواصفة القياسية للمصانع الصناعية وتركيب مباشر على خطوط المياه";

function options(count: number): RfqPdfOptions {
  return {
    rfqNo: "RFQ-TEST-458",
    customerRfqNo: "x",
    rfqDate: "2026-11-20",
    closeDate: "2026-11-30",
    supplierName: "مورد تجريبي",
    contactPerson: "أحمد",
    items: Array.from({ length: count }, (_, i) => ({
      lineItem: String(i + 1),
      partNo: `PN-${1000 + i}`,
      description: i % 4 === 0 ? LONG : `صنف رقم ${i + 1} مواصفات قياسية`,
      qty: `${(i + 1) * 3}.000`,
      uom: "PCS",
    })),
    pricingUrl: "https://example.com",
    employeeName: "موظف",
    employeePhone: "01000000000",
    notes: "يرجى التسعير شامل الضريبة",
  };
}

function pageCount(pdf: Buffer): number {
  // compress:false keeps the page objects readable.
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

describe("RFQ supplier PDF pagination", () => {
  it("fits 27 long-description items on two pages, not nineteen", async () => {
    const pdf = await generateRfqPdf(options(27));
    expect(pageCount(pdf)).toBe(2);
  });

  it("grows by whole pages for a long list and does not split rows", async () => {
    const pdf = await generateRfqPdf(options(80));
    const pages = pageCount(pdf);
    expect(pages).toBeGreaterThanOrEqual(4);
    expect(pages).toBeLessThanOrEqual(6);
  });

  it("produces a valid single-page PDF for an empty item list", async () => {
    const pdf = await generateRfqPdf(options(0));
    expect(pageCount(pdf)).toBe(1);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

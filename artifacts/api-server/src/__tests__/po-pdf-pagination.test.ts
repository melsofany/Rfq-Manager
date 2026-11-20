/**
 * A purchase order must not split its rows across pages. Before the fix a
 * 27-line order rendered as 118 pages, because rows were drawn at fixed y
 * positions and PDFKit broke pages on its own. These bounds fail if rows stop
 * being paginated before they are drawn.
 */
import { describe, expect, it } from "vitest";
import { generatePoPdf } from "../modules/po/po-pdf";

const LONG =
  "صمام كروي من النحاس الأصفر مقاس 2 بوصة ضغط تشغيل 16 بار مع مقبض معدني ووصلات تيار ملولب متوافق مع المواصفة القياسية";

function items(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    lineItem: String(i + 1),
    partNo: `PN-${1000 + i}`,
    description: i % 3 === 0 ? LONG : `صنف رقم ${i + 1} مواصفات قياسية`,
    qty: String((i + 1) * 2),
    uom: "PCS",
    unitPrice: 100 + i,
    taxIncluded: i % 2 === 0,
    lineStatus: "active",
  }));
}

function pageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

const base = {
  poNo: "PO-TEST-1",
  poDate: "2026-11-20",
  supplierName: "مورد تجريبي",
  employeeName: "موظف",
  employeePhone: "01000000000",
  notes: "ملاحظة",
  receiverName: "مندوب",
  receiverPhone: "010",
};

describe("PO PDF pagination", () => {
  it("fits 27 lines on three pages, not one page per few lines", async () => {
    const pdf = await generatePoPdf({ ...base, items: items(27) } as never);
    expect(pageCount(pdf)).toBeLessThanOrEqual(3);
  });

  it("grows by whole pages for a long order", async () => {
    const pdf = await generatePoPdf({ ...base, items: items(60) } as never);
    const pages = pageCount(pdf);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(pages).toBeLessThanOrEqual(6);
  });
});

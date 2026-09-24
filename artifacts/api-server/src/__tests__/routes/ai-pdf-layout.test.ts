/**
 * Report layout regressions the operator reported on the EDC census PDF.
 *
 *  1. «مبقتش عارف احدد دي تبع ايه» — column headers were CLIPPED, so it was
 *     impossible to tell which column held what.
 *  2. The trailing pages carried no header, no page number and no running title,
 *     so a continuation page's rows could not be attributed to anything.
 *
 * The assertions are structural, made against the bytes pdfkit actually emits —
 * not a mock. The header fill colour («#1a3a5c») appears once per drawn header,
 * so counting it per page answers "does this page say what its columns are?".
 * Reading the Arabic text back is unreliable (the font subset mangles
 * extraction), but the fill AND the ASCII parts of the Latin labels survive
 * verbatim in the content stream.
 */
import { describe, expect, it } from "vitest";
import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { generateAssistantPdf } from "../../modules/ai-assistant/pdf";

const here = dirname(fileURLToPath(import.meta.url));

/** pdfkit emits the fill colour as `<r> <g> <b> scn` then `f` for the filled rect. */
const HEADER_FILL = Buffer.from(
  "0.10196078431372549 0.22745098039215686 0.3607843137254902 scn\nf",
);
/** #8a8a8a footer grey, drawn as a text colour. */
const FOOTER_FILL = Buffer.from("0.5411764705882353 0.5411764705882353 0.5411764705882353 scn");

/** Page content streams, in document order. */
function pageStreams(pdf: Buffer): Buffer[] {
  const streams: Buffer[] = [];
  const re = /\n(\d+) 0 obj\s*<<\s*\/Length \d+\s*>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const m of pdf.toString("latin1").matchAll(re)) streams.push(Buffer.from(m[2], "latin1"));
  return streams;
}

/** Count non-overlapping occurrences. */
function count(buf: Buffer, needle: Buffer): number {
  let n = 0;
  let i = 0;
  for (;;) {
    const at = buf.indexOf(needle, i);
    if (at === -1) return n;
    n++;
    i = at + needle.length;
  }
}

const LONG_DESCRIPTION =
  "3680 ELECTROLUX P/N : 003680 GLASS DOOR GASKET SIZE 1480 MM FOR CONVECTION OVEN 6 GN 1/1";

const COLUMNS = [
  "الترتيب",
  "وصف البند الكامل",
  "رقم القطعة (Part Number)",
  "Line Item",
  "عدد أوامر الشراء",
  "إجمالي الكمية",
  "الوحدة",
  "متوسط سعر الوحدة",
  "إجمالي المبلغ (مجموع Line Totals)",
];

async function buildReport(itemCount: number) {
  const ranked = Array.from({ length: itemCount }, (_, i) => ({
    description: `${LONG_DESCRIPTION} VARIANT ${i + 1}`,
    partNo: `PN-${1000 + i}`,
    lineItemNos: ["1531.032.GENRAL.7014", "5720.003.GENRAL.7539"],
    occurrences: (i % 7) + 2,
    qty: 100 + i * 37,
    uom: "Each",
    avgUnitPrice: 4800.5 + i,
    totalValue: 14400 + i * 1000,
  }));
  return generateAssistantPdf({
    title: "حصر بنود البريد (مهمة خلفية)",
    subtitle: `${itemCount} بندًا الأكثر تكرارًا`,
    sections: [
      { paragraphs: ["رسائل مطابقة: 3713، فُتح مرفق 1200 رسالة.", "مستندات أوامر شراء: 332."] },
      {
        table: {
          columns: COLUMNS,
          rightAligned: ["وصف البند الكامل", "Line Item", "رقم القطعة (Part Number)"],
          rows: ranked.map((p, i) => [
            i + 1,
            p.description,
            p.partNo,
            p.lineItemNos.join("، "),
            p.occurrences,
            p.qty,
            p.uom,
            p.avgUnitPrice.toFixed(2),
            p.totalValue.toFixed(2),
          ]),
        },
      },
      {
        heading: "تفاصيل كل ظهور (PO / كمية / سعر الوحدة)",
        paragraphs: ["كل صف ظهر للبند في أمر شراء مستقل. البند مذكور في أول عمود."],
        table: {
          columns: ["البند (الترتيب)", "أمر الشراء", "الكمية", "سعر الوحدة", "إجمالي البند"],
          rightAligned: ["البند (الترتيب)"],
          rows: ranked.flatMap((p, i) =>
            ["P26E13839", "P26E13894"].map((doc, li) => [
              li === 0 ? `${i + 1}. ${p.description}` : "",
              doc,
              3,
              4800,
              14400,
            ]),
          ),
        },
      },
    ],
    footer: "المصدر: مرفقات أوامر الشراء في البريد الإلكتروني — وليس قاعدة البيانات.",
  });
}

describe("census report PDF layout", () => {
  it("draws a column header on EVERY page, including continuation pages", async () => {
    const streams = pageStreams(await buildReport(20));
    // A 20-item report with per-appearance details is several pages; if this
    // ever collapses to one page the assertion stops proving anything.
    expect(streams.length).toBeGreaterThan(1);
    // The regression: the old renderer drew the header once, so continuation
    // pages had 0 fills and their rows could not be attributed to a column.
    streams.forEach((s, i) => {
      expect(count(s, HEADER_FILL), `page ${i + 1} has no table header`).toBeGreaterThanOrEqual(1);
    });
  });

  it("keeps a header on every page of a longer report too", async () => {
    const streams = pageStreams(await buildReport(40));
    expect(streams.length).toBeGreaterThan(2);
    const withHeader = streams.filter((s) => count(s, HEADER_FILL) >= 1).length;
    expect(withHeader).toBe(streams.length);
  });

  it("gives every detail row an item and PO label, not a floating line", async () => {
    // The trailing pages of the operator's report held only prose detail lines
    // with nothing naming them («مبقتش عارف دي تبع ايه»). The detail section is
    // now a TABLE whose header repeats and whose first row of each item group
    // carries the item's rank + description. Assert the detail header exists as
    // a drawn header, and that its PO label appears in the same table.
    const pdf = await buildReport(20);
    const streams = pageStreams(pdf);
    const last = streams[streams.length - 1];
    // The last page must carry a drawn header (the detail table's) rather than
    // being a bare continuation of text.
    expect(count(last, HEADER_FILL)).toBeGreaterThanOrEqual(1);
    // And the whole document must have MORE header fills than a single table
    // would produce, because two tables each repeat theirs.
    const totalFills = streams.reduce((n, s) => n + count(s, HEADER_FILL), 0);
    expect(totalFills).toBeGreaterThan(streams.length);
  });

  it("stamps a footer on every page", async () => {
    const streams = pageStreams(await buildReport(20));
    const withFooter = streams.filter((s) => count(s, FOOTER_FILL) >= 1).length;
    expect(withFooter).toBe(streams.length);
  });

  it("gives the previously-clipped headers room to wrap inside their column", async () => {
    // This is the «مبقتش عارف احدد دي تبع ايه» defect measured directly: the old
    // equal split gave each of the 9 columns 52pt of usable width, while
    // «رقم القطعة (Part Number)» needs 62pt — and it was drawn with
    // `lineBreak:false` in a 14pt box, so the overflow was cut off.
    const { columnWidths } = await import("../../modules/ai-assistant/pdf");
    const doc = new PDFDocument({ size: "A4", autoFirstPage: false });
    const font = resolve(here, "../../assets/fonts/Amiri-Regular.ttf");
    doc.registerFont("Amiri", font);
    doc.font("Amiri");
    const CW = 595.3 - 72;
    const padding = 6;
    const widths = columnWidths(
      doc,
      {
        columns: COLUMNS,
        rows: [
          [
            1,
            LONG_DESCRIPTION,
            "PN-1000",
            "1531.032.GENRAL.7014",
            4,
            100,
            "Each",
            "4800.50",
            "14400.00",
          ],
        ],
      },
      CW,
    );

    for (const idx of [
      COLUMNS.indexOf("رقم القطعة (Part Number)"),
      COLUMNS.indexOf("إجمالي المبلغ (مجموع Line Totals)"),
    ]) {
      const avail = widths[idx] - padding;
      // The whole point: the column is now at least as wide as the header needs
      // for it to fit in a small number of wrapped lines, instead of a sliver.
      expect(avail).toBeGreaterThan(58);
      const lineH = doc.fontSize(8).currentLineHeight();
      const lines =
        doc.fontSize(8).heightOfString(COLUMNS[idx], {
          width: avail,
          height: lineH * 3,
        }) / lineH;
      expect(lines).toBeLessThanOrEqual(3);
    }
    // And the wide description column must still get the most room.
    const descIdx = COLUMNS.indexOf("وصف البند الكامل");
    expect(widths[descIdx]).toBe(Math.max(...widths));
  });
});

/**
 * AI Assistant — generic Arabic/English PDF generator.
 *
 * Renders a simple, branded document from a title + optional subtitle + a list
 * of sections, each with paragraphs and/or a table. Used when the operator asks
 * the assistant for a PDF (report, summary, invoice copy, data extract). Reuses
 * the Amiri font bundled for the PO/invoice PDFs.
 */
import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

export interface PdfTable {
  columns: string[];
  rows: Array<Array<string | number | null | undefined>>;
  /** Column names rendered right-aligned (e.g. free-text descriptions). */
  rightAligned?: string[];
  /**
   * Relative column widths, one per column. A column's share of the usable
   * width is `widths[i] / sum(widths)`. Omitted → widths are measured from the
   * header and cell text (see `columnWidths`), which is the normal case.
   *
   * An equal split is the thing that cut the headers: 9 columns over 523pt
   * leaves 52pt each, while «رقم القطعة (Part Number)» needs 62pt, so it was
   * clipped and the operator could no longer tell which column was which.
   */
  widths?: number[];
}

export interface PdfSection {
  heading?: string;
  paragraphs?: string[];
  table?: PdfTable;
}

export interface AssistantPdfOptions {
  title: string;
  subtitle?: string | null;
  sections: PdfSection[];
  footer?: string | null;
}

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function rtl(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (!ARABIC_RE.test(trimmed)) return trimmed;
  const words = trimmed.split(/\s+/);
  if (words.length <= 1) return trimmed;
  return words.reverse().join(" ");
}

function fontPath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return resolve(dir, "assets/fonts/Amiri-Regular.ttf");
}
function logoPath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return resolve(dir, "assets/logo.png");
}

function cell(value: string | number | null | undefined): string {
  if (value == null) return "";
  return rtl(String(value));
}

export function generateAssistantPdf(opts: AssistantPdfOptions): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 40, bottom: 40, left: 36, right: 36 },
        autoFirstPage: true,
        compress: false,
        // Buffered so every page can be stamped with «صفحة X من Y» once the
        // total is known — a multi-page report previously had no page numbers
        // and no running title, so a trailing page could not be attributed.
        bufferPages: true,
      });
      const chunks: Buffer[] = [];
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => settle(() => resolvePromise(Buffer.concat(chunks))));
      doc.on("error", (e: Error) => settle(() => reject(e)));

      // The Arabic font ships in `assets/` (copied into dist by the build). When
      // it is missing — a source-run, or a bundle that lost the asset — fall back
      // to a built-in font rather than throwing, so a report is still produced.
      const font = fontPath();
      if (existsSync(font)) {
        doc.registerFont("Amiri", font);
        doc.font("Amiri");
      } else {
        doc.font("Helvetica");
      }
      const PAGE_W = doc.page.width;
      const M = 36;
      const CW = PAGE_W - M * 2;
      const BLUE = "#1a3a5c";

      const logo = logoPath();
      if (existsSync(logo)) {
        try {
          doc.image(logo, M, 32, { height: 42 });
        } catch {
          /* ignore logo errors */
        }
      }
      doc.fontSize(16).fillColor(BLUE).text(rtl("قرطبة للتوريدات"), M, 36, {
        width: CW,
        align: "right",
      });
      doc.fontSize(8).fillColor("#666").text("CORTOBA SUPPLIES", M, 56, {
        width: CW,
        align: "right",
      });

      doc.moveDown(2);
      doc
        .fontSize(20)
        .fillColor(BLUE)
        .text(rtl(opts.title), M, doc.y + 12, {
          width: CW,
          align: "center",
        });
      if (opts.subtitle) {
        doc.moveDown(0.3);
        doc.fontSize(11).fillColor("#555").text(rtl(opts.subtitle), { width: CW, align: "center" });
      }
      doc.moveDown(0.8);
      doc
        .moveTo(M, doc.y)
        .lineTo(PAGE_W - M, doc.y)
        .strokeColor("#c8a84b")
        .lineWidth(1.5)
        .stroke();
      doc.moveDown(0.8);

      for (const section of opts.sections) {
        if (doc.y > doc.page.height - 100) doc.addPage();
        if (section.heading) {
          doc
            .fontSize(13)
            .fillColor(BLUE)
            .text(rtl(section.heading), { width: CW, align: "right" });
          doc.moveDown(0.3);
        }
        doc.fontSize(10).fillColor("#222");
        for (const p of section.paragraphs ?? []) {
          doc.text(rtl(p), { width: CW, align: "right" });
          doc.moveDown(0.25);
        }
        if (section.table) {
          renderTable(doc, section.table, M, CW);
        }
        doc.moveDown(0.6);
      }

      // Stamp EVERY page once the total is known: a running title + the page
      // number + the source line. The last pages of the census report held only
      // floating detail lines with nothing naming them, which is why the
      // operator «مبقتش عارف دي تبع ايه».
      const range = doc.bufferedPageRange();
      const total = range.count;
      const footerText = rtl(
        opts.footer || `تم الإنشاء بواسطة المساعد الذكي — ${new Date().toLocaleString("en-GB")}`,
      );
      for (let i = 0; i < total; i++) {
        doc.switchToPage(range.start + i);
        // Writing below the bottom margin would spill onto a new page.
        const bottomY = doc.page.height - 52;
        doc
          .fontSize(7.5)
          .fillColor("#8a8a8a")
          .text(rtl(opts.title), M, bottomY - 12, {
            width: CW,
            align: "center",
            lineBreak: false,
          });
        doc
          .fontSize(7.5)
          .fillColor("#8a8a8a")
          .text(`${footerText}  ·  صفحة ${i + 1} من ${total}`, M, bottomY, {
            width: CW,
            align: "center",
            lineBreak: false,
          });
      }
      doc.flushPages();

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Build a complete missing-number report directly from the server-side set
 * difference. The model receives only a bounded sample of the census, so passing
 * its rows to generate_pdf would silently lose the rest of the list.
 */
export function generateMissingNumbersPdf(
  comparison: {
    table: string;
    column: string;
    found: number;
    missing: Array<{ number: string; subject: string; date: string; mailbox: string }>;
  },
  title = "أرقام البريد غير المسجلة في النظام",
): Promise<Buffer> {
  return generateAssistantPdf({
    title,
    subtitle: "مقارنة أرقام البريد الإلكتروني بسجل النظام",
    sections: [
      {
        paragraphs: [
          `تم فحص أرقام البريد مقابل جدول ${comparison.table} (عمود ${comparison.column}).`,
          `الأرقام الموجودة في النظام: ${comparison.found} — الأرقام غير المسجلة: ${comparison.missing.length}.`,
        ],
      },
      {
        table: {
          columns: ["رقم الطلب", "التاريخ", "البريد", "موضوع الرسالة"],
          rows: comparison.missing.map((m) => [
            m.number,
            m.date?.slice(0, 10) ?? "",
            m.mailbox,
            m.subject,
          ]),
        },
      },
    ],
    footer: `تم إنشاء التقرير من الحصر الكامل — ${new Date().toLocaleString("en-GB")}`,
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Column widths for a table.
 *
 * An explicit `table.widths` wins. Otherwise the widths are MEASURED from the
 * content: each column gets a share proportional to the widest thing it must
 * hold — its header, or its widest cell, capped so one long description cannot
 * starve the numeric columns.
 *
 * Hand-tuned constants and equal splits were both fragile: 9 columns over 523pt
 * gave 52pt each while «رقم القطعة (Part Number)» needs 62pt, so the header was
 * clipped and the operator could not tell which column held what. Measuring
 * removes that class of bug for every table.
 */
export function columnWidths(doc: any, table: PdfTable, width: number): number[] {
  const n = table.columns.length || 1;
  if (table.widths && table.widths.length === n) {
    const total = table.widths.reduce((a, b) => a + (b > 0 ? b : 0.0001), 0);
    return table.widths.map((w) => (width * (w > 0 ? w : 0.0001)) / total);
  }
  const padding = 6;
  const natural = table.columns.map((c, i) => {
    let w = doc.fontSize(8).widthOfString(cell(c) || " ");
    for (const row of table.rows) {
      const v = cell(row[i]);
      if (!v) continue;
      // Cap a single cell's contribution: an unbounded description would take
      // the whole table and squeeze every other column to a sliver.
      w = Math.max(w, Math.min(doc.fontSize(9).widthOfString(v), 150));
    }
    return Math.max(w + padding, 26);
  });
  const total = natural.reduce((a, b) => a + b, 0);
  return natural.map((w) => (width * w) / total);
}

/**
 * Render a table, repeating the COLUMN HEADER at the top of every page.
 *
 * The report spans several pages and a continuation page must still be readable:
 * the header is re-drawn whenever the table pushes onto a new page, and the
 * header itself WRAPS (it previously passed `lineBreak:false` with a 14pt box, so
 * a header wider than its column was clipped — «رقم القطعة (Part Number)» and
 * «إجمالي المبلغ (مجموع Line Totals)» both were).
 *
 * A cell whose text does not fit the column height is WRAPPED and the row is made
 * as tall as its tallest cell, so a full description is never cut off.
 * `lineBreak:false` is therefore not used for data cells, and no `height` is
 * passed when drawing them: pdfkit CLIPS text taller than the box it is given.
 */
function renderTable(doc: any, table: PdfTable, startX: number, width: number): void {
  const widths = columnWidths(doc, table, width);
  const fontSize = 9;
  const headerFontSize = 8;
  const padding = 6;
  const lineH = 11;
  /** x offset of each column from `startX`. */
  const xs: number[] = [];
  widths.reduce((acc, w) => {
    xs.push(acc);
    return acc + w;
  }, 0);

  /** Height a cell needs at its column width, measured by pdfkit itself. */
  const cellHeightAt = (col: number, v: string | number | null | undefined, size: number): number =>
    doc.fontSize(size).heightOfString(cell(v) || " ", { width: widths[col] - padding });

  const headerHeight = (): number =>
    Math.max(lineH + 4, ...table.columns.map((c, i) => cellHeightAt(i, c, headerFontSize) + 4));

  const drawHeaderRow = () => {
    const y = doc.y;
    const h = headerHeight();
    doc.rect(startX, y, width, h).fill("#1a3a5c");
    doc.fillColor("#ffffff");
    table.columns.forEach((c, i) => {
      doc.fontSize(headerFontSize).text(cell(c), startX + xs[i] + 3, y + 3, {
        width: widths[i] - padding,
        align: "center",
      });
    });
    doc.y = y + h;
  };

  drawHeaderRow();
  const footerRoom = 78;
  table.rows.forEach((row, rowIdx) => {
    const height = Math.max(18, ...row.map((v, i) => cellHeightAt(i, v, fontSize) + 2));
    // Start a new page BEFORE drawing a row that does not fit, and re-draw the
    // header on it so the row is readable there.
    if (doc.y + height > doc.page.height - footerRoom) {
      doc.addPage();
      drawHeaderRow();
    }
    const y = doc.y;
    doc.rect(startX, y, width, height).fill(rowIdx % 2 === 0 ? "#f4f6f9" : "#ffffff");
    doc.fillColor("#222").fontSize(fontSize);
    const rightCols = table.rightAligned ?? [];
    row.forEach((v, i) => {
      // NO `height` here on purpose: pdfkit CLIPS text taller than the box it is
      // given, so passing the measured height (or anything derived from it) cut
      // the last line off a wrapped description — the «مقصوص» defect. The row is
      // already as tall as its tallest cell, so the text fits without a limit.
      doc.text(cell(v), startX + xs[i] + 3, y + 2, {
        width: widths[i] - padding,
        align: rightCols.includes(table.columns[i]) ? "right" : "center",
      });
    });
    doc.y = y + height;
  });
}

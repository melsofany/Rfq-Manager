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

      doc.registerFont("Amiri", fontPath());
      doc.font("Amiri");
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

      doc
        .fontSize(8)
        .fillColor("#888")
        .text(
          rtl(
            opts.footer ||
              `تم الإنشاء بواسطة المساعد الذكي — ${new Date().toLocaleString("en-GB")}`,
          ),
          M,
          doc.page.height - 60,
          {
            width: CW,
            align: "center",
          },
        );

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
function renderTable(doc: any, table: PdfTable, startX: number, width: number): void {
  const cols = table.columns.length || 1;
  const colW = width / cols;
  const rowH = 22;

  const drawRow = (values: Array<string | number | null | undefined>, header: boolean) => {
    if (doc.y + rowH > doc.page.height - 70) doc.addPage();
    const y = doc.y;
    if (header) {
      doc.rect(startX, y, width, rowH).fill("#1a3a5c");
    } else {
      doc.rect(startX, y, width, rowH).fill("#f4f6f9");
    }
    doc.fillColor(header ? "#ffffff" : "#222").fontSize(9);
    values.forEach((v, i) => {
      doc.text(cell(v), startX + i * colW + 4, y + 6, {
        width: colW - 8,
        height: rowH,
        align: "center",
        lineBreak: false,
      });
    });
    doc.y = y + rowH;
  };

  drawRow(table.columns, true);
  for (const row of table.rows) drawRow(row, false);
}

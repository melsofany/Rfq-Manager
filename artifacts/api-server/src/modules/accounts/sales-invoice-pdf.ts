/**
 * Accounts Module — مولّد فاتورة البيع (PDF)
 *
 * Generates a branded, Arabic-RTL sales invoice PDF (A4) mirroring the PO PDF
 * style. Carries: invoice no, date, customer, line items (description, qty,
 * unit price, line total), subtotals, VAT 14%, gross, and the company tax
 * identity. Reuses the Amiri font + logo bundled in src/assets.
 */
import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

export interface SalesInvoicePdfOptions {
  invoiceNo: string;
  invoiceDate: string;
  dueDate?: string | null;
  customerName: string;
  customerPoNo?: string | null;
  items: Array<{
    lineItem?: string | null;
    partNo?: string | null;
    description: string;
    qty?: string | number | null;
    uom?: string | null;
    unitPrice?: string | number | null;
    total?: string | number | null;
  }>;
  netAmount: number;
  vatAmount: number;
  vatRate: number;
  grossAmount: number;
  companyName?: string | null;
  companyTaxId?: string | null;
  companyAddress?: string | null;
  companyPhone?: string | null;
  notes?: string | null;
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

function formatDate(d?: string | null): string {
  try {
    const dt = new Date(d ?? new Date().toISOString());
    if (isNaN(dt.getTime())) return d ?? "";
    const dd = String(dt.getDate()).padStart(2, "0");
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${dt.getFullYear()}`;
  } catch {
    return d ?? "";
  }
}

function fmt(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const s = String(v).trim();
  if (!s) return "—";
  if (/^-?\d+(\.\d+)?$/.test(s)) return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return s;
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getFontPath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return resolve(dir, "../assets/fonts/Amiri-Regular.ttf");
}

function getLogoPath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return resolve(dir, "../assets/logo.png");
}

export function generateSalesInvoicePdf(opts: SalesInvoicePdfOptions): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    try {
      const fontPath = getFontPath();
      const logoPath = getLogoPath();
      const hasLogo = existsSync(logoPath);

      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
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

      doc.registerFont("Amiri", fontPath);

      const PAGE_W = doc.page.width;
      const M = 28;
      const CW = PAGE_W - M * 2;
      const BLUE = "#1a3a5c";
      const GOLD = "#c8a84b";
      const LGREY = "#eef2f7";

      const invDate = formatDate(opts.invoiceDate);
      const dueDate = opts.dueDate ? formatDate(opts.dueDate) : "";

      // HEADER
      const HDR_H = 88;
      doc.rect(0, 0, PAGE_W, HDR_H).fill(BLUE);
      doc.rect(0, HDR_H - 3, PAGE_W, 3).fill(GOLD);

      const TITLE_X = PAGE_W / 2;
      const TITLE_W = PAGE_W / 2 - M;
      if (hasLogo) {
        try {
          doc.image(logoPath, M + 4, 18, { width: 52, height: 52 });
        } catch {
          // ignore logo rendering errors
        }
      }
      doc
        .fillColor("#fff")
        .font("Amiri")
        .fontSize(26)
        .text(rtl("فاتورة ضريبية"), TITLE_X, 30, { width: TITLE_W, align: "center" });
      doc
        .fontSize(11)
        .fillColor("#c8a84b")
        .text(rtl(opts.companyName || "قرطبة للتوريدات"), TITLE_X, 62, { width: TITLE_W, align: "center" });

      // Company + invoice meta block
      let y = HDR_H + 14;
      const LEFT_W = CW * 0.5;
      doc.fillColor(BLUE).font("Amiri").fontSize(10);
      const companyLines = [
        rtl(opts.companyName || "قرطبة للتوريدات"),
        opts.companyAddress ? rtl(opts.companyAddress) : null,
        opts.companyPhone ? `ت: ${opts.companyPhone}` : null,
        opts.companyTaxId ? `البطاقة الضريبية: ${opts.companyTaxId}` : null,
      ].filter(Boolean) as string[];
      companyLines.forEach((line, i) => {
        doc.fillColor(i === 0 ? BLUE : "#555").fontSize(i === 0 ? 11 : 9).text(line, M, y + i * 14, {
          width: LEFT_W,
          align: "right",
        });
      });

      doc.fillColor(BLUE).fontSize(9);
      let metaY = y;
      const metaX = M + LEFT_W;
      const metaW = CW - LEFT_W;
      doc.text(rtl(`رقم الفاتورة: ${opts.invoiceNo}`), metaX, metaY, { width: metaW, align: "right" });
      doc.text(rtl(`التاريخ: ${invDate}`), metaX, metaY + 14, { width: metaW, align: "right" });
      if (dueDate) doc.text(rtl(`تاريخ الاستحقاق: ${dueDate}`), metaX, metaY + 28, { width: metaW, align: "right" });
      if (opts.customerPoNo) doc.text(rtl(`أمر شراء العميل: ${opts.customerPoNo}`), metaX, metaY + 42, { width: metaW, align: "right" });

      // Customer box
      y += Math.max(companyLines.length * 14, 56) + 8;
      doc.roundedRect(M, y, CW, 30, 4).fill(LGREY);
      doc.fillColor("#555").fontSize(9).text(rtl("فاتورة إلى (العميل):"), M + 6, y + 5, { width: CW - 12, align: "right" });
      doc.fillColor(BLUE).fontSize(12).text(rtl(opts.customerName), M + 6, y + 14, { width: CW - 12, align: "right" });
      y += 30 + 10;

      // Items table
      const TABLE_Y = y;
      const colX = (i: number) => M + [0, CW * 0.08, CW * 0.42, CW * 0.62, CW * 0.8, CW][i];
      doc.rect(M, TABLE_Y, CW, 24).fill(BLUE);
      doc.fillColor("#fff").fontSize(9);
      const headers = ["#", rtl("الوصف"), rtl("الكمية"), rtl("السعر"), rtl("الإجمالي"), ""];
      headers.forEach((h, i) => {
        if (i === headers.length - 1) return;
        doc.text(h, colX(i) + 4, TABLE_Y + 7, { width: colX(i + 1) - colX(i) - 8, align: "center" });
      });
      y = TABLE_Y + 24;

      opts.items.forEach((it, idx) => {
        if (idx % 2 === 0) doc.rect(M, y, CW, 20).fill(LGREY);
        doc.fillColor("#333").fontSize(9);
        doc.text(String(idx + 1), colX(0) + 4, y + 5, { width: colX(1) - colX(0) - 8, align: "center" });
        const desc = [it.description, it.partNo ? `(${it.partNo})` : null].filter(Boolean).join(" ");
        doc.text(rtl(desc), colX(1) + 4, y + 5, { width: colX(2) - colX(1) - 8, align: "right" });
        doc.text(fmt(it.qty), colX(2) + 4, y + 5, { width: colX(3) - colX(2) - 8, align: "center" });
        doc.text(fmtMoney(Number(it.unitPrice ?? 0)), colX(3) + 4, y + 5, { width: colX(4) - colX(3) - 8, align: "center" });
        doc.text(fmtMoney(Number(it.total ?? 0)), colX(4) + 4, y + 5, { width: colX(5) - colX(4) - 8, align: "center" });
        y += 20;
      });

      // Totals
      y += 10;
      const totalsW = CW * 0.4;
      const totalsX = M + CW - totalsW;
      const totals: Array<[string, string, boolean]> = [
        [rtl("الإجمالي قبل الضريبة"), fmtMoney(opts.netAmount), false],
        [rtl(`ضريبة القيمة المضافة ${opts.vatRate}%`), fmtMoney(opts.vatAmount), false],
        [rtl("الإجمالي شامل الضريبة"), fmtMoney(opts.grossAmount), true],
      ];
      totals.forEach(([label, val, strong], i) => {
        if (strong) {
          doc.roundedRect(totalsX, y, totalsW, 24, 4).fill(BLUE);
          doc.fillColor("#fff").fontSize(11);
          doc.text(label, totalsX + 6, y + 6, { width: totalsW * 0.6, align: "right" });
          doc.text(val, totalsX + totalsW * 0.6, y + 6, { width: totalsW * 0.4 - 6, align: "center" });
          y += 24 + 4;
        } else {
          doc.fillColor("#555").fontSize(9);
          doc.text(label, totalsX, y, { width: totalsW * 0.6, align: "right" });
          doc.fillColor("#333").text(val, totalsX + totalsW * 0.6, y, { width: totalsW * 0.4 - 6, align: "center" });
          y += 18;
        }
      });

      // Notes + footer
      if (opts.notes) {
        y += 8;
        doc.fillColor("#555").fontSize(8).text(rtl(opts.notes), M, y, { width: CW, align: "right" });
      }
      doc.rect(0, doc.page.height - 26, PAGE_W, 26).fill(BLUE);
      doc.fillColor("#c8a84b").fontSize(8).text(rtl("هذه الفاتورة صادرة إلكترونياً من نظام قرطبة للتوريدات"), M, doc.page.height - 18, { width: CW, align: "center" });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

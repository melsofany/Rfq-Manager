import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

// Customer quotation (عرض سعر) PDF — sent to the customer by WhatsApp / email.
// Same brand and fonts as the purchase-order PDF (see modules/po/po-pdf.ts).

export const COMPANY_PHONE = "432-972-587";
export const COMPANY_ADDRESS = "ش.الإسكندرية - برج نجمة مطروح، الدور الرابع - مرسي مطروح";
export const COMPANY_CR = "س-ت: 21618";
export const COMPANY_EMAIL = "INFO@CORTOBA-SUPPLIES.COM";

export interface QuotationPdfItem {
  partNo?: string | null;
  lineItem?: string | null;
  description?: string | null;
  uom?: string | null;
  qty?: string | number | null;
  unitPrice?: string | number | null;
}

export interface QuotationPdfOptions {
  quotationNo: string; // internal RFQ number used as the quotation reference
  customerRfqNo?: string | null;
  entryDate?: string | null;
  expiryDate?: string | null;
  customerName: string;
  customerAddress?: string | null;
  customerPhone?: string | null;
  contactPerson?: string | null;
  showPrices: boolean;
  items: QuotationPdfItem[];
  terms: string[];
}

const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

// PDFKit does not shape Arabic: reverse word order for right-to-left display.
function rtl(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (!ARABIC_RE.test(trimmed)) return trimmed;
  const words = trimmed.split(/\s+/);
  if (words.length <= 1) return trimmed;
  return words.reverse().join(" ");
}

function formatDate(d?: string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

function toNum(v: string | number | null | undefined): number {
  const n = typeof v === "string" ? parseFloat(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Bundle: dist/assets (copied by build.mjs). Source/tests: src/assets.
function assetPath(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(here, rel);
  if (existsSync(bundled)) return bundled;
  return resolve(here, "../..", rel);
}

export function generateQuotationPdf(opts: QuotationPdfOptions): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    try {
      const fontPath = assetPath("assets/fonts/Amiri-Regular.ttf");
      const logoPath = assetPath("assets/logo.png");
      const hasLogo = existsSync(logoPath);

      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 36, left: 36, right: 36, bottom: 0 },
        autoFirstPage: true,
        compress: true,
      });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolvePromise(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.registerFont("Amiri", fontPath);

      const PAGE_W = doc.page.width;
      const M = 36;
      const CW = PAGE_W - M * 2;
      const BLUE = "#1a3a5c";
      const GOLD = "#c8a84b";
      const LGREY = "#eef2f7";

      // ── Header band ──
      const HDR_H = 96;
      doc.rect(0, 0, PAGE_W, HDR_H).fill(BLUE);
      doc.rect(0, HDR_H - 3, PAGE_W, 3).fill(GOLD);
      if (hasLogo) {
        doc.image(logoPath, M, 14, { fit: [64, 64] });
      }
      doc
        .font("Amiri")
        .fontSize(11)
        .fillColor(GOLD)
        .text(rtl("قرطبة للتوريدات"), M + 76, 22, { width: 200, align: "left", lineBreak: false });
      doc
        .fontSize(8)
        .fillColor("#c0d8f0")
        .text("CORTOBA SUPPLIES", M + 76, 40, { width: 200, align: "left", lineBreak: false });
      doc
        .fontSize(7.5)
        .fillColor("#8aaec8")
        .text(rtl(COMPANY_ADDRESS), M + 76, 56, { width: 260, align: "left", lineBreak: false });
      doc
        .fontSize(8)
        .fillColor("#dfe9f5")
        .text(`${rtl("ت:")} ${COMPANY_PHONE}   |   ${COMPANY_EMAIL}`, M + 76, 70, {
          width: 320,
          align: "left",
          lineBreak: false,
        });

      doc
        .font("Amiri")
        .fontSize(22)
        .fillColor("#ffffff")
        .text(rtl("عرض سعر"), PAGE_W - M - 200, 18, {
          width: 200,
          align: "right",
          lineBreak: false,
        });
      doc
        .fontSize(9)
        .fillColor(GOLD)
        .text("QUOTATION", PAGE_W - M - 200, 46, { width: 200, align: "right", lineBreak: false });
      doc
        .fontSize(9)
        .fillColor("#aaccee")
        .text(`${rtl("رقم:")} ${opts.quotationNo}`, PAGE_W - M - 200, 64, {
          width: 200,
          align: "right",
          lineBreak: false,
        });

      // ── Reference block ──
      let y = HDR_H + 16;
      const refRows: Array<[string, string]> = [
        ["رقم الطلب الداخلي", opts.quotationNo],
        ["رقم طلب العميل", opts.customerRfqNo || "—"],
        ["تاريخ العرض", formatDate(opts.entryDate)],
        ["صالح حتى", formatDate(opts.expiryDate)],
      ];
      doc.font("Amiri").fontSize(10).fillColor("#111111");
      refRows.forEach(([label, value], i) => {
        const rowY = y + i * 16;
        doc.text(rtl(value), M, rowY, { width: CW / 2, align: "left", lineBreak: false });
        doc.fillColor("#555555").text(rtl(label), M + CW / 2, rowY, {
          width: CW / 2,
          align: "right",
          lineBreak: false,
        });
        doc.fillColor("#111111");
      });
      y += refRows.length * 16 + 12;

      // ── Customer block ──
      doc.rect(M, y, CW, 74).fill(LGREY);
      doc
        .font("Amiri")
        .fontSize(9)
        .fillColor(BLUE)
        .text(rtl("إلى:"), M + 8, y + 6, {
          width: CW - 16,
          align: "right",
          lineBreak: false,
        });
      const custLines: Array<[string, string | null | undefined]> = [
        ["العميل", opts.customerName],
        ["المسؤول", opts.contactPerson],
        ["العنوان", opts.customerAddress],
        ["الهاتف", opts.customerPhone],
      ];
      custLines.forEach(([label, value], i) => {
        const rowY = y + 20 + i * 13;
        doc
          .fontSize(9)
          .fillColor("#111111")
          .text(rtl(value?.trim() || "—"), M + 8, rowY, {
            width: CW - 90,
            align: "right",
            lineBreak: false,
          });
        doc.fillColor("#666666").text(rtl(label), M + CW - 80, rowY, {
          width: 72,
          align: "right",
          lineBreak: false,
        });
      });
      y += 74 + 14;

      // ── Items table ──
      const cols = opts.showPrices
        ? { n: 28, part: 80, desc: 170, uom: 40, qty: 50, price: 70, total: 0 }
        : { n: 28, part: 90, desc: 250, uom: 60, qty: 60, price: 0, total: 0 };
      const used = cols.n + cols.part + cols.desc + cols.uom + cols.qty + cols.price;
      const colTotal = CW - used;
      if (opts.showPrices) cols.total = colTotal;
      else cols.desc += colTotal;

      const drawHeader = (ty: number) => {
        doc.rect(M, ty, CW, 20).fill(BLUE);
        let x = M;
        const head: Array<[string, number]> = [
          ["م", cols.n],
          ["رقم القطعة", cols.part],
          ["البند / الوصف", cols.desc],
          ["الوحدة", cols.uom],
          ["الكمية", cols.qty],
        ];
        if (opts.showPrices) {
          head.push(["سعر الوحدة", cols.price], ["الإجمالي", cols.total]);
        }
        doc.font("Amiri").fontSize(9).fillColor("#ffffff");
        head.forEach(([label, w]) => {
          doc.text(rtl(label), x + 3, ty + 6, { width: w - 6, align: "center", lineBreak: false });
          x += w;
        });
        return ty + 20;
      };

      y = drawHeader(y);
      let grand = 0;
      opts.items.forEach((it, i) => {
        const qty = toNum(it.qty);
        const price = toNum(it.unitPrice);
        const total = Math.round(qty * price * 10000) / 10000;
        grand += total;
        const desc = [it.lineItem, it.description].filter((s) => s && String(s).trim()).join(" - ");
        const rowH = Math.max(
          22,
          doc
            .font("Amiri")
            .fontSize(9)
            .heightOfString(rtl(desc || "—"), { width: cols.desc - 6 }) + 8,
        );
        if (y + rowH > doc.page.height - 120) {
          doc.addPage();
          y = drawHeader(M);
        }
        if (i % 2 === 0) doc.rect(M, y, CW, rowH).fill("#f7f9fc");
        doc.fillColor("#111111").fontSize(9);
        let x = M;
        const cells: Array<[string, number, string]> = [
          [String(i + 1), cols.n, "center"],
          [it.partNo || "—", cols.part, "left"],
          [rtl(desc || "—"), cols.desc, "right"],
          [rtl(it.uom || "—"), cols.uom, "center"],
          [qty ? String(qty) : "—", cols.qty, "center"],
        ];
        if (opts.showPrices) {
          cells.push([price ? money(price) : "—", cols.price, "center"]);
          cells.push([total ? money(total) : "—", cols.total, "center"]);
        }
        cells.forEach(([text, w, align]) => {
          doc.text(text, x + 3, y + 5, {
            width: w - 6,
            align: align as "left" | "right" | "center",
          });
          x += w;
        });
        doc
          .moveTo(M, y + rowH)
          .lineTo(M + CW, y + rowH)
          .strokeColor("#dde3ec")
          .lineWidth(0.5)
          .stroke();
        y += rowH;
      });

      // ── Grand total ──
      if (opts.showPrices) {
        doc.rect(M, y, CW, 22).fill(LGREY);
        doc
          .font("Amiri")
          .fontSize(10)
          .fillColor(BLUE)
          .text(money(grand), M + 6, y + 6, { width: CW - 90, align: "left", lineBreak: false });
        doc.text(rtl("الإجمالي"), M + CW - 84, y + 6, {
          width: 78,
          align: "right",
          lineBreak: false,
        });
        y += 22;
      }

      // ── Terms ──
      const terms = opts.terms.map((t) => t.trim()).filter(Boolean);
      if (terms.length) {
        y += 16;
        if (y > doc.page.height - 140) {
          doc.addPage();
          y = M;
        }
        doc.font("Amiri").fontSize(10).fillColor(BLUE).text(rtl("الشروط والأحكام"), M, y, {
          width: CW,
          align: "right",
          lineBreak: false,
        });
        y += 16;
        terms.forEach((t, i) => {
          doc
            .fontSize(9)
            .fillColor("#222222")
            .text(`${rtl(t)} .${i + 1}`, M, y, {
              width: CW,
              align: "right",
            });
          y = doc.y + 4;
        });
      }

      // ── Footer ──
      const FY = doc.page.height - 50;
      doc.rect(M, FY, CW, 1.5).fill(GOLD);
      doc
        .font("Amiri")
        .fontSize(8)
        .fillColor("#666666")
        .text(
          `${rtl(COMPANY_ADDRESS)}   |   ${rtl("ت:")} ${COMPANY_PHONE}   |   ${COMPANY_CR}`,
          M,
          FY + 8,
          { width: CW, align: "center", lineBreak: false },
        );
      doc.text(COMPANY_EMAIL, M, FY + 22, { width: CW, align: "center", lineBreak: false });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

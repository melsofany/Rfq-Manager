import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

export interface RfqPdfOptions {
  rfqNo: string;
  customerRfqNo: string; // kept in interface for backward-compat but NOT shown in PDF
  rfqDate?: string | null;
  closeDate: string;
  supplierName: string;
  contactPerson?: string | null;
  items: Array<{
    lineItem?: string | null;
    partNo?: string | null;
    description: string;
    qty?: string | null;
    uom?: string | null;
  }>;
  pricingUrl: string;
  employeeName: string;
  employeePhone?: string | null;
  notes?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RTL helper
//
// PDFKit renders characters left-to-right in the order they appear in the
// string.  Arabic Unicode text is stored in *logical* (reading) order, which
// is right-to-left, so a 3-word Arabic string rendered LTR appears with its
// words in reverse visual order.
//
// Fix: reverse the word sequence before handing it to PDFKit.  PDFKit then
// places word-1 (the RTL-last word) at the left, word-N (the RTL-first word)
// at the right, and an Arabic reader scanning right-to-left sees the correct
// reading order.
//
// This applies only to strings that contain Arabic characters and have more
// than one whitespace-delimited token.  Single words and Latin-only strings
// are returned unchanged.
// ─────────────────────────────────────────────────────────────────────────────
const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

export function rtl(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (!ARABIC_RE.test(trimmed)) return trimmed; // no Arabic → leave as-is
  const words = trimmed.split(/\s+/);
  if (words.length <= 1) return trimmed; // single token → no reversal
  return words.reverse().join(" ");
}

function formatDate(d: string): string {
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    // Use Western (ASCII) digits in DD/MM/YYYY format.
    // Arabic-Indic numerals from ar-EG locale appear reversed in PDFKit
    // because PDFKit renders text LTR; e.g. "٢٠٢٦" is read RTL as "٦٢٠٢".
    const dd = String(dt.getDate()).padStart(2, "0");
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const yyyy = dt.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  } catch {
    return d;
  }
}

/**
 * Strips trailing zeros from a plain numeric string using regex only —
 * no parseFloat, so large numbers can't silently switch to scientific notation.
 */
function formatQty(qty: string | null | undefined): string {
  if (!qty) return "—";
  const t = qty.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return t;
  return t.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

// Bundle: dist/assets (copied by build.mjs). Source/tests: src/assets.
function assetPath(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(here, rel);
  if (existsSync(bundled)) return bundled;
  return resolve(here, "../..", rel);
}

// ─────────────────────────────────────────────────────────────────────────────
// Page geometry
//
// Why the old layout produced 19 pages for 27 items: every row was drawn at a
// y computed for the CURRENT page, and nothing checked whether the row still
// fitted. Once a row crossed the bottom edge PDFKit started a new page by
// itself, and the rest of the row (the description, then the quantity) landed
// on that new page at the top, while the cell backgrounds stayed on the old
// one. The table then looked like text in one place and numbers in another.
//
// The fix is explicit pagination: before a row is drawn its height is known,
// and if it does not fit above the footer, a new page is started, the slim
// header is repeated and the column titles are repeated. Nothing is left to
// PDFKit's automatic page breaks, which are disabled by the zero margins.
// ─────────────────────────────────────────────────────────────────────────────
const M = 28; // horizontal margin
const FOOTER_TOP_OFFSET = 58; // footer rule sits this far above the page bottom
const BOTTOM_RESERVE = 70; // content must stay above this band on every page
const CONT_HDR_H = 34; // slim header on continuation pages
const ROW_H = 22; // minimum row height (pt)
const ROW_PAD_V = 6; // vertical padding inside each row
const FONT_SIZE = 9.5;

const BLUE = "#1a3a5c";
const GOLD = "#c8a84b";
const LGREY = "#eef2f7";

export function generateRfqPdf(opts: RfqPdfOptions): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    try {
      const fontPath = assetPath("assets/fonts/Amiri-Regular.ttf");
      const logoPath = assetPath("assets/logo.png");
      const hasLogo = existsSync(logoPath);

      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        autoFirstPage: true,
        compress: false,
        // Buffered so the footer (with "Page X of Y") can be written on every
        // page once the total is known.
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

      doc.registerFont("Amiri", fontPath);

      const PAGE_W = doc.page.width; // 595.28 pt (A4)
      const PAGE_H = doc.page.height; // 841.89 pt (A4)
      const CW = PAGE_W - M * 2; // content width
      const FOOTER_Y = PAGE_H - FOOTER_TOP_OFFSET;
      const CONTENT_BOTTOM = PAGE_H - BOTTOM_RESERVE;

      // ── Format dates ─────────────────────────────────────────────────────
      const rfqDate = opts.rfqDate
        ? formatDate(opts.rfqDate)
        : formatDate(new Date().toISOString());
      const closeDate = formatDate(opts.closeDate);

      // ── Table geometry ───────────────────────────────────────────────────
      const C_NUM = 34;
      const C_PART = 100;
      const C_QTY = 60;
      const C_UOM = 54;
      const C_DESC = CW - C_NUM - C_PART - C_QTY - C_UOM;
      const colWArr = [C_NUM, C_PART, C_DESC, C_QTY, C_UOM];
      const colLbls = ["#", rtl("رقم القطعة"), rtl("الوصف"), rtl("الكمية"), rtl("الوحدة")];

      function colX(idx: number): number {
        let x = M + CW;
        for (let k = 0; k <= idx; k++) x -= colWArr[k];
        return x;
      }

      // ═══════════════════════════════════════════════════════════════════
      // FIRST-PAGE HEADER  (title + company block + info band)
      // ═══════════════════════════════════════════════════════════════════
      function drawFirstHeader(): number {
        const HDR_H = 88;
        doc.rect(0, 0, PAGE_W, HDR_H).fill(BLUE);
        doc.rect(0, HDR_H - 3, PAGE_W, 3).fill(GOLD);

        // RIGHT block: document title
        const TITLE_X = PAGE_W / 2;
        const TITLE_W = PAGE_W / 2 - M;
        doc.font("Amiri").fontSize(24).fillColor("#ffffff").text(rtl("طلب عرض سعر"), TITLE_X, 14, {
          width: TITLE_W,
          align: "right",
          lineBreak: false,
        });
        doc.font("Amiri").fontSize(9).fillColor(GOLD).text("REQUEST FOR QUOTATION", TITLE_X, 48, {
          width: TITLE_W,
          align: "right",
          lineBreak: false,
        });
        doc.font("Amiri").fontSize(8).fillColor("#aaccee").text(`رقم: ${opts.rfqNo}`, TITLE_X, 63, {
          width: TITLE_W,
          align: "right",
          lineBreak: false,
        });

        // LEFT block: logo + company info
        const LOGO_SIZE = 52;
        const LOGO_X = M;
        const LOGO_Y = (HDR_H - LOGO_SIZE) / 2;
        const CO_TEXT_X = M + LOGO_SIZE + 8;
        const CO_TEXT_W = PAGE_W / 2 - LOGO_SIZE - M - 16;

        if (hasLogo) {
          doc.image(logoPath, LOGO_X, LOGO_Y, {
            width: LOGO_SIZE,
            height: LOGO_SIZE,
            fit: [LOGO_SIZE, LOGO_SIZE],
          });
        } else {
          doc.roundedRect(LOGO_X, LOGO_Y, LOGO_SIZE, LOGO_SIZE, 6).fill(GOLD);
          doc
            .font("Amiri")
            .fontSize(22)
            .fillColor(BLUE)
            .text("ق", LOGO_X, LOGO_Y + LOGO_SIZE / 2 - 14, {
              width: LOGO_SIZE,
              align: "center",
              lineBreak: false,
            });
        }

        doc.font("Amiri").fontSize(11).fillColor(GOLD).text(rtl("قرطبة للتوريدات"), CO_TEXT_X, 12, {
          width: CO_TEXT_W,
          align: "left",
          lineBreak: false,
        });
        doc.font("Amiri").fontSize(8).fillColor("#c0d8f0").text("CORTOBA SUPPLIES", CO_TEXT_X, 30, {
          width: CO_TEXT_W,
          align: "left",
          lineBreak: false,
        });
        doc
          .font("Amiri")
          .fontSize(7)
          .fillColor("#8aaec8")
          .text(rtl("ش.الإسكندرية - برج نجمة مطروح، الدور الرابع"), CO_TEXT_X, 46, {
            width: CO_TEXT_W,
            align: "left",
            lineBreak: false,
          });
        doc
          .font("Amiri")
          .fontSize(7)
          .fillColor("#8aaec8")
          .text(rtl("مرسي مطروح  |  ت: 432-972-587"), CO_TEXT_X, 59, {
            width: CO_TEXT_W,
            align: "left",
            lineBreak: false,
          });
        doc
          .font("Amiri")
          .fontSize(7)
          .fillColor("#8aaec8")
          .text("INFO@CORTOBA-SUPPLIES.COM", CO_TEXT_X, 72, {
            width: CO_TEXT_W,
            align: "left",
            lineBreak: false,
          });

        // INFO BAND — RTL order (right → left): رقم الطلب | تاريخ الإصدار | آخر موعد للرد
        const IY = HDR_H;
        const IH = 50;
        doc.rect(0, IY, PAGE_W, IH).fill(LGREY);

        const infoCells = [
          { label: rtl("رقم الطلب الداخلي"), value: opts.rfqNo },
          { label: rtl("تاريخ الإصدار"), value: rfqDate },
          { label: rtl("آخر موعد للرد"), value: closeDate },
        ];
        const cellW = CW / infoCells.length;
        infoCells.forEach((cell, i) => {
          const cx = M + (infoCells.length - 1 - i) * cellW;
          doc
            .font("Amiri")
            .fontSize(7.5)
            .fillColor("#7a90a8")
            .text(cell.label, cx, IY + 7, { width: cellW, align: "center", lineBreak: false });
          doc
            .font("Amiri")
            .fontSize(12)
            .fillColor(BLUE)
            .text(cell.value, cx, IY + 24, { width: cellW, align: "center", lineBreak: false });
        });

        return IY + IH;
      }

      // Slim header for pages after the first: keeps the document identity
      // (number and title) visible without repeating the whole block.
      function drawContinuationHeader(): number {
        doc.rect(0, 0, PAGE_W, CONT_HDR_H).fill(BLUE);
        doc.rect(0, CONT_HDR_H - 2, PAGE_W, 2).fill(GOLD);
        doc
          .font("Amiri")
          .fontSize(11)
          .fillColor("#ffffff")
          .text(rtl("طلب عرض سعر — تابع"), M, 11, { width: CW, align: "right", lineBreak: false });
        // Number kept on its own line: mixing it into the Arabic run reversed it.
        doc
          .font("Amiri")
          .fontSize(8)
          .fillColor("#aaccee")
          .text(`RFQ: ${opts.rfqNo}`, M, 12, { width: CW, align: "left", lineBreak: false });
        return CONT_HDR_H + 10;
      }

      function drawTableHeader(y: number): number {
        doc.rect(M, y, CW, ROW_H).fill(BLUE);
        colLbls.forEach((lbl, i) => {
          doc
            .font("Amiri")
            .fontSize(FONT_SIZE)
            .fillColor("#ffffff")
            .text(lbl, colX(i) + 2, y + 5, {
              width: colWArr[i] - 4,
              align: "center",
              lineBreak: false,
            });
        });
        return y + ROW_H;
      }

      // Start a new page when `height` would not fit above the footer band.
      // Returns the y at which the caller should draw.
      let y = 0;
      function ensureSpace(height: number): void {
        if (y + height <= CONTENT_BOTTOM) return;
        doc.addPage();
        y = drawContinuationHeader();
        y = drawTableHeader(y);
      }

      // ═══════════════════════════════════════════════════════════════════
      // BODY
      // ═══════════════════════════════════════════════════════════════════
      y = drawFirstHeader() + 12;

      const supplierLine = opts.contactPerson
        ? `${opts.supplierName} — ${opts.contactPerson}`
        : opts.supplierName;

      doc
        .font("Amiri")
        .fontSize(8.5)
        .fillColor("#8899aa")
        .text(rtl("إلى المورّد:"), M, y, { width: CW, align: "right", lineBreak: false });
      y += 15;

      doc
        .font("Amiri")
        .fontSize(14)
        .fillColor(BLUE)
        .text(rtl(supplierLine), M, y, { width: CW, align: "right", lineBreak: false });
      y += 24;

      const intro = rtl(
        "يسرنا الاستفسار عن أسعار الأصناف التالية، ونرجو التفضل بتزويدنا بعروض الأسعار قبل التاريخ المحدد أعلاه.",
      );
      doc.font("Amiri").fontSize(9.5);
      const introH = doc.heightOfString(intro, { width: CW });
      doc.fillColor("#555555").text(intro, M, y, { width: CW, align: "right" });
      y += introH + 10;

      // ═══════════════════════════════════════════════════════════════════
      // ITEMS TABLE  — one row per item, measured before it is drawn
      // ═══════════════════════════════════════════════════════════════════
      ensureSpace(ROW_H * 2); // never start the table at the very bottom
      y = drawTableHeader(y);

      opts.items.forEach((item, idx) => {
        const descText = rtl(item.description);
        const descWidth = colWArr[2] - 6;

        doc.font("Amiri").fontSize(FONT_SIZE);
        const descTextH = doc.heightOfString(descText, { width: descWidth });
        const rowH = Math.max(ROW_H, descTextH + ROW_PAD_V * 2);

        ensureSpace(rowH);

        const bg = idx % 2 === 0 ? "#ffffff" : "#f4f7fb";
        doc.rect(M, y, CW, rowH).fill(bg).stroke("#d8e2ee");

        const vals = [
          String(idx + 1),
          item.partNo ?? "—",
          descText,
          formatQty(item.qty),
          item.uom ?? "—",
        ];

        vals.forEach((v, i) => {
          const isDesc = i === 2;
          const cellY = isDesc ? y + ROW_PAD_V : y + (rowH - FONT_SIZE) / 2 - 1;
          doc
            .font("Amiri")
            .fontSize(FONT_SIZE)
            .fillColor("#2c3e50")
            .text(v, colX(i) + 3, cellY, {
              width: colWArr[i] - 6,
              align: isDesc ? "right" : "center",
              lineBreak: isDesc,
            });
        });
        y += rowH;
      });

      // ═══════════════════════════════════════════════════════════════════
      // NOTES (right-to-left; accent bar on the RIGHT)
      // ═══════════════════════════════════════════════════════════════════
      if (opts.notes?.trim()) {
        const NH = 46;
        y += 12;
        ensureSpace(NH);
        doc.rect(M, y, CW, NH).fill("#f0f5fa");
        doc.rect(M + CW - 4, y, 4, NH).fill(BLUE);
        doc
          .font("Amiri")
          .fontSize(8.5)
          .fillColor("#7a90a8")
          .text(rtl("ملاحظات:"), M + 6, y + 7, {
            width: CW - 18,
            align: "right",
            lineBreak: false,
          });
        doc
          .font("Amiri")
          .fontSize(10.5)
          .fillColor("#2c3e50")
          .text(rtl(opts.notes.trim()), M + 6, y + 24, {
            width: CW - 18,
            align: "right",
            lineBreak: false,
          });
        y += NH;
      }

      // ═══════════════════════════════════════════════════════════════════
      // FOOTER — on every page, with the page number
      // ═══════════════════════════════════════════════════════════════════
      const contactParts = [
        opts.employeeName ? rtl(opts.employeeName) : null,
        opts.employeePhone ?? null,
        "INFO@CORTOBA-SUPPLIES.COM",
      ].filter(Boolean);
      const contact = contactParts.join("   |   ");

      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.rect(M, FOOTER_Y, CW, 1.5).fill(GOLD);
        doc
          .font("Amiri")
          .fontSize(9.5)
          .fillColor("#555555")
          .text(contact, M, FOOTER_Y + 8, { width: CW, align: "center", lineBreak: false });
        doc
          .font("Amiri")
          .fontSize(7.5)
          .fillColor("#999999")
          .text(
            rtl("ش.الإسكندرية - برج نجمة مطروح، الدور الرابع - مرسي مطروح") +
              "   |   ت: 432-972-587   |   س-ت: 21618",
            M,
            FOOTER_Y + 24,
            { width: CW, align: "center", lineBreak: false },
          );
        doc
          .font("Amiri")
          .fontSize(7)
          .fillColor("#aaaaaa")
          .text(rtl("قرطبة للتوريدات") + " — CORTOBA SUPPLIES", M, FOOTER_Y + 38, {
            width: CW / 2,
            align: "left",
            lineBreak: false,
          });
        doc
          .font("Amiri")
          .fontSize(7)
          .fillColor("#aaaaaa")
          .text(`Page ${i + 1} of ${range.count}`, M + CW / 2, FOOTER_Y + 38, {
            width: CW / 2,
            align: "right",
            lineBreak: false,
          });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

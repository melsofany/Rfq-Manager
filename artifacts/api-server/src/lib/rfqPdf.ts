import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

export interface RfqPdfOptions {
  rfqNo: string;
  customerRfqNo: string;
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

// ── Company logo (same PNG used in offersPdf) ────────────────────────────────
const LOGO_BASE64 =
  "data:image/png;base64,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";

function getLogoBuffer(): Buffer {
  const b64 = LOGO_BASE64.replace("data:image/png;base64,", "");
  return Buffer.from(b64, "base64");
}

function formatDate(d: string): string {
  try {
    return new Date(d).toLocaleDateString("ar-EG");
  } catch {
    return d;
  }
}

/**
 * Strips trailing zeros from a plain numeric string using regex only —
 * no parseFloat, so large numbers can't silently switch to scientific notation.
 * "2.000" → "2",  "2.500" → "2.5",  "12abc" → "12abc" (unchanged)
 * "001.2300" → "001.23"  (preserves leading zeros; caller owns that decision)
 */
function formatQty(qty: string | null | undefined): string {
  if (!qty) return "—";
  const t = qty.trim();
  // Only process purely numeric strings (optional leading sign, digits, optional decimal part)
  if (!/^-?\d+(\.\d+)?$/.test(t)) return t;
  // Strip trailing zeros after decimal point, then strip a lone trailing dot
  return t.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function getFontPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "assets/fonts/Amiri-Regular.ttf");
}

export function generateRfqPdf(opts: RfqPdfOptions): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    try {
      const fontPath = getFontPath();

      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        autoFirstPage: true,
        compress: false,
      });

      const chunks: Buffer[] = [];
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn(); }
      };
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end",  () => settle(() => resolvePromise(Buffer.concat(chunks))));
      doc.on("error",(e: Error) => settle(() => reject(e)));

      doc.registerFont("Amiri", fontPath);

      const PAGE_W = doc.page.width;   // 595.28 pt (A4)
      const M      = 28;               // horizontal margin
      const CW     = PAGE_W - M * 2;  // content width
      const BLUE   = "#1a3a5c";
      const GOLD   = "#c8a84b";
      const LGREY  = "#eef2f7";

      // ── Format dates ─────────────────────────────────────────────────────
      const rfqDate   = opts.rfqDate ? formatDate(opts.rfqDate) : formatDate(new Date().toISOString());
      const closeDate = formatDate(opts.closeDate);

      // ═══════════════════════════════════════════════════════════════════
      // HEADER  (RTL layout: right = document identity, left = company)
      // ═══════════════════════════════════════════════════════════════════
      const HDR_H = 88;
      doc.rect(0, 0, PAGE_W, HDR_H).fill(BLUE);
      // Gold accent stripe at bottom of header
      doc.rect(0, HDR_H - 3, PAGE_W, 3).fill(GOLD);

      // ── RIGHT block: document title (RTL start position) ─────────────
      // Arabic readers start from the right — the document type goes here.
      const TITLE_X = PAGE_W / 2;          // right half of header
      const TITLE_W = PAGE_W / 2 - M;

      doc.font("Amiri").fontSize(24).fillColor("#ffffff")
        .text("طلب عرض سعر", TITLE_X, 14, {
          width: TITLE_W, align: "right", lineBreak: false,
        });
      doc.font("Amiri").fontSize(9).fillColor(GOLD)
        .text("REQUEST FOR QUOTATION", TITLE_X, 48, {
          width: TITLE_W, align: "right", lineBreak: false,
        });
      doc.font("Amiri").fontSize(8).fillColor("#aaccee")
        .text(`رقم: ${opts.rfqNo}`, TITLE_X, 63, {
          width: TITLE_W, align: "right", lineBreak: false,
        });

      // ── LEFT block: logo + company info ──────────────────────────────
      const LOGO_SIZE = 52;
      const LOGO_X    = M;
      const LOGO_Y    = (HDR_H - LOGO_SIZE) / 2;
      const CO_TEXT_X = M + LOGO_SIZE + 8;
      const CO_TEXT_W = PAGE_W / 2 - LOGO_SIZE - M - 16;

      // Logo image (wrapped in try-catch — same pattern as offersPdf)
      try {
        doc.image(getLogoBuffer(), LOGO_X, LOGO_Y, { width: LOGO_SIZE, height: LOGO_SIZE });
      } catch {
        // Logo failed to render — draw a placeholder box
        doc.rect(LOGO_X, LOGO_Y, LOGO_SIZE, LOGO_SIZE).fill(GOLD);
        doc.font("Amiri").fontSize(8).fillColor(BLUE)
          .text("Q", LOGO_X, LOGO_Y + LOGO_SIZE / 2 - 5, {
            width: LOGO_SIZE, align: "center", lineBreak: false,
          });
      }

      doc.font("Amiri").fontSize(11).fillColor(GOLD)
        .text("قرطبة للتوريدات", CO_TEXT_X, 12, {
          width: CO_TEXT_W, align: "left", lineBreak: false,
        });
      doc.font("Amiri").fontSize(8).fillColor("#c0d8f0")
        .text("CORTOBA SUPPLIES", CO_TEXT_X, 30, {
          width: CO_TEXT_W, align: "left", lineBreak: false,
        });
      doc.font("Amiri").fontSize(7).fillColor("#8aaec8")
        .text("ش.الإسكندرية - برج نجمة مطروح، الدور الرابع", CO_TEXT_X, 46, {
          width: CO_TEXT_W, align: "left", lineBreak: false,
        });
      doc.font("Amiri").fontSize(7).fillColor("#8aaec8")
        .text("مرسي مطروح  |  ت: 432-972-587", CO_TEXT_X, 59, {
          width: CO_TEXT_W, align: "left", lineBreak: false,
        });
      doc.font("Amiri").fontSize(7).fillColor("#8aaec8")
        .text("INFO@CORTOBA-SUPPLIES.COM", CO_TEXT_X, 72, {
          width: CO_TEXT_W, align: "left", lineBreak: false,
        });

      // ═══════════════════════════════════════════════════════════════════
      // INFO BAND  (4 cells, rendered right → left for RTL)
      // Order on page (right → left): رقم الطلب | رقم RFQ | تاريخ | آخر موعد
      // ═══════════════════════════════════════════════════════════════════
      const IY  = HDR_H;
      const IH  = 50;
      doc.rect(0, IY, PAGE_W, IH).fill(LGREY);

      const infoCells = [
        { label: "رقم الطلب الداخلي", value: opts.rfqNo },
        { label: "رقم RFQ العميل",    value: opts.customerRfqNo },
        { label: "تاريخ الإصدار",     value: rfqDate },
        { label: "آخر موعد للرد",     value: closeDate },
      ];
      const cellW = CW / infoCells.length;

      // i=0 → rightmost cell  (RTL start)
      infoCells.forEach((cell, i) => {
        const cx = M + (infoCells.length - 1 - i) * cellW;
        doc.font("Amiri").fontSize(7.5).fillColor("#7a90a8")
          .text(cell.label, cx, IY + 7, { width: cellW, align: "center", lineBreak: false });
        doc.font("Amiri").fontSize(12).fillColor(BLUE)
          .text(cell.value, cx, IY + 24, { width: cellW, align: "center", lineBreak: false });
      });

      // ═══════════════════════════════════════════════════════════════════
      // BODY
      // ═══════════════════════════════════════════════════════════════════
      let y = IY + IH + 12;

      // Supplier label + name  (align: "right" = RTL start)
      const supplierLine = opts.contactPerson
        ? `${opts.supplierName} — ${opts.contactPerson}`
        : opts.supplierName;

      doc.font("Amiri").fontSize(8.5).fillColor("#8899aa")
        .text("إلى المورّد:", M, y, { width: CW, align: "right", lineBreak: false });
      y += 15;

      doc.font("Amiri").fontSize(14).fillColor(BLUE)
        .text(supplierLine, M, y, { width: CW, align: "right", lineBreak: false });
      y += 24;

      doc.font("Amiri").fontSize(9.5).fillColor("#555555")
        .text(
          "يسرنا الاستفسار عن أسعار الأصناف التالية، ونرجو التفضل بتزويدنا بعروض الأسعار قبل التاريخ المحدد أعلاه.",
          M, y, { width: CW, align: "right" },
        );
      y += 26;

      // ═══════════════════════════════════════════════════════════════════
      // ITEMS TABLE  — full RTL column layout
      //
      // Physical order on page (left → right):
      //   الوحدة | الكمية | الوصف (wide) | رقم القطعة | #
      //
      // RTL reading order (right → left):
      //   #  |  رقم القطعة  |  الوصف  |  الكمية  |  الوحدة
      // ═══════════════════════════════════════════════════════════════════

      // Column definitions — index 0 = rightmost in RTL
      const C_NUM  = 34;
      const C_PART = 100;
      const C_QTY  = 60;
      const C_UOM  = 54;
      const C_DESC = CW - C_NUM - C_PART - C_QTY - C_UOM;

      // colW[i] and colX[i] describe the physical x position on the page.
      // colX(0) = rightmost column (#), colX(4) = leftmost column (الوحدة).
      const colWArr  = [C_NUM, C_PART, C_DESC, C_QTY, C_UOM];
      const colLbls  = ["#", "رقم القطعة", "الوصف", "الكمية", "الوحدة"];

      function colX(idx: number): number {
        // x = right edge of content area minus cumulative widths up to idx
        let x = M + CW;
        for (let k = 0; k <= idx; k++) x -= colWArr[k];
        return x;
      }

      const ROW_H = 22;

      // Header row
      doc.rect(M, y, CW, ROW_H).fill(BLUE);
      colLbls.forEach((lbl, i) => {
        doc.font("Amiri").fontSize(9.5).fillColor("#ffffff")
          .text(lbl, colX(i) + 2, y + 5, {
            width: colWArr[i] - 4, align: "center", lineBreak: false,
          });
      });
      y += ROW_H;

      // Data rows
      opts.items.forEach((item, idx) => {
        const bg = idx % 2 === 0 ? "#ffffff" : "#f4f7fb";
        doc.rect(M, y, CW, ROW_H).fill(bg).stroke("#d8e2ee");

        const vals = [
          String(idx + 1),
          item.partNo ?? "—",
          item.description,
          formatQty(item.qty),
          item.uom ?? "—",
        ];

        vals.forEach((v, i) => {
          doc.font("Amiri").fontSize(9.5).fillColor("#2c3e50")
            .text(v, colX(i) + 3, y + 5, {
              width: colWArr[i] - 6,
              // Description column (index 2) uses right-align for Arabic text
              align: i === 2 ? "right" : "center",
              lineBreak: false,
            });
        });
        y += ROW_H;
      });

      // ═══════════════════════════════════════════════════════════════════
      // NOTES (right-to-left; accent bar on the RIGHT)
      // ═══════════════════════════════════════════════════════════════════
      if (opts.notes?.trim()) {
        y += 12;
        const NH = 46;
        doc.rect(M, y, CW, NH).fill("#f0f5fa");
        // Accent bar on the RIGHT edge (RTL start of the block)
        doc.rect(M + CW - 4, y, 4, NH).fill(BLUE);
        doc.font("Amiri").fontSize(8.5).fillColor("#7a90a8")
          .text("ملاحظات:", M + 6, y + 7, {
            width: CW - 18, align: "right", lineBreak: false,
          });
        doc.font("Amiri").fontSize(10.5).fillColor("#2c3e50")
          .text(opts.notes.trim(), M + 6, y + 24, {
            width: CW - 18, align: "right", lineBreak: false,
          });
        y += NH;
      }

      // ═══════════════════════════════════════════════════════════════════
      // FOOTER
      // ═══════════════════════════════════════════════════════════════════
      const FY = Math.max(y + 20, doc.page.height - 58);
      doc.rect(M, FY, CW, 1.5).fill(GOLD);

      const contact = [
        opts.employeeName,
        opts.employeePhone,
        "INFO@CORTOBA-SUPPLIES.COM",
      ].filter(Boolean).join("   |   ");

      doc.font("Amiri").fontSize(9.5).fillColor("#555555")
        .text(contact, M, FY + 8, { width: CW, align: "center", lineBreak: false });

      doc.font("Amiri").fontSize(7.5).fillColor("#999999")
        .text(
          "ش.الإسكندرية - برج نجمة مطروح، الدور الرابع - مرسي مطروح   |   ت: 432-972-587   |   س-ت: 21618",
          M, FY + 24,
          { width: CW, align: "center", lineBreak: false },
        );

      doc.font("Amiri").fontSize(7).fillColor("#aaaaaa")
        .text("قرطبة للتوريدات — CORTOBA SUPPLIES", M, FY + 38, {
          width: CW, align: "center", lineBreak: false,
        });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

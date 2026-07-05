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

      // Company monogram — pure vector, no image/zlib dependency
      doc.roundedRect(LOGO_X, LOGO_Y, LOGO_SIZE, LOGO_SIZE, 6).fill(GOLD);
      doc.font("Amiri").fontSize(22).fillColor(BLUE)
        .text("ق", LOGO_X, LOGO_Y + LOGO_SIZE / 2 - 14, {
          width: LOGO_SIZE, align: "center", lineBreak: false,
        });

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

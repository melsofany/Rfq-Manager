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
    return new Date(d).toLocaleDateString("en-GB");
  } catch {
    return d;
  }
}

/**
 * Removes trailing zeros from a purely numeric quantity string.
 * Only converts strings that are entirely numeric (with optional leading/
 * trailing whitespace and an optional single decimal point).
 * Non-numeric or mixed strings are returned unchanged so we never silently
 * misrepresent the value (e.g. "1,200.00" stays "1,200.00", "12abc" stays "12abc").
 * Examples: "2.000" → "2",  "2.500" → "2.5",  "1.250" → "1.25"
 */
function formatQty(qty: string | null | undefined): string {
  if (!qty) return "—";
  const trimmed = qty.trim();
  // Accept only fully numeric strings: optional sign, digits, optional single dot
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  const num = parseFloat(trimmed);
  if (isNaN(num)) return trimmed;
  return String(num);
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
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => settle(() => resolvePromise(Buffer.concat(chunks))));
      doc.on("error", (err: Error) => settle(() => reject(err)));

      doc.registerFont("Amiri", fontPath);

      const PAGE_W = doc.page.width;
      const MARGIN = 30;
      const CONTENT_W = PAGE_W - MARGIN * 2;
      const BLUE = "#1a3a5c";
      const GOLD = "#c8a84b";
      const GREY_BG = "#eef2f7";

      const rfqDate = opts.rfqDate
        ? formatDate(opts.rfqDate)
        : formatDate(new Date().toISOString());
      const closeDate = formatDate(opts.closeDate);

      // ── HEADER BAND ──────────────────────────────────────────────────────
      const HEADER_H = 90;
      doc.rect(0, 0, PAGE_W, HEADER_H).fill(BLUE);

      // RIGHT side: Company info (Arabic reads right → left, so company info on the right)
      const RIGHT_BLOCK_W = 200;
      const RIGHT_X = PAGE_W - MARGIN - RIGHT_BLOCK_W;

      doc.font("Amiri").fontSize(13).fillColor(GOLD)
        .text("قرطبة للتوريدات", RIGHT_X, 8, { width: RIGHT_BLOCK_W, align: "right", lineBreak: false });

      doc.font("Amiri").fontSize(8).fillColor("#aaccee")
        .text("CORTOBA SUPPLIES", RIGHT_X, 28, { width: RIGHT_BLOCK_W, align: "right", lineBreak: false });

      doc.font("Amiri").fontSize(7).fillColor("#aaccee")
        .text("ش.الإسكندرية - برج نجمة مطروح، الدور الرابع - مرسي مطروح", RIGHT_X, 45, {
          width: RIGHT_BLOCK_W,
          align: "right",
          lineBreak: false,
        });

      doc.font("Amiri").fontSize(7).fillColor("#aaccee")
        .text("ت: 432-972-587  |  س-ت: 21618", RIGHT_X, 60, { width: RIGHT_BLOCK_W, align: "right", lineBreak: false });

      doc.font("Amiri").fontSize(7).fillColor("#aaccee")
        .text("INFO@CORTOBA-SUPPLIES.COM", RIGHT_X, 73, { width: RIGHT_BLOCK_W, align: "right", lineBreak: false });

      // LEFT side: Document title
      doc.font("Amiri").fontSize(22).fillColor("#ffffff")
        .text("طلب عرض سعر", MARGIN, 18, { lineBreak: false });
      doc.font("Amiri").fontSize(9).fillColor(GOLD)
        .text("REQUEST FOR QUOTATION", MARGIN, 52, { lineBreak: false });

      // ── INFO BAND ─────────────────────────────────────────────────────────
      const INFO_Y = HEADER_H;
      const INFO_H = 52;
      doc.rect(0, INFO_Y, PAGE_W, INFO_H).fill(GREY_BG);
      doc.rect(0, INFO_Y + INFO_H - 2.5, PAGE_W, 2.5).fill(GOLD);

      // Info cells rendered RTL (right → left)
      const infoCells = [
        { label: "رقم الطلب الداخلي", value: opts.rfqNo },
        { label: "رقم RFQ العميل",    value: opts.customerRfqNo },
        { label: "تاريخ الإصدار",     value: rfqDate },
        { label: "آخر موعد للتقديم",  value: closeDate },
      ];

      const cellW = CONTENT_W / infoCells.length;
      // RTL: first cell on the right
      infoCells.forEach((cell, i) => {
        // i=0 → rightmost cell, i=3 → leftmost cell
        const cx = MARGIN + (infoCells.length - 1 - i) * cellW;
        doc.font("Amiri").fontSize(8).fillColor("#8899aa")
          .text(cell.label, cx, INFO_Y + 8, {
            width: cellW,
            align: "center",
            lineBreak: false,
          });
        doc.font("Amiri").fontSize(12).fillColor(BLUE)
          .text(cell.value, cx, INFO_Y + 26, {
            width: cellW,
            align: "center",
            lineBreak: false,
          });
      });

      // ── BODY ──────────────────────────────────────────────────────────────
      let y = INFO_Y + INFO_H + 14;

      // To-supplier line (RTL: align right)
      const supplierLine = opts.contactPerson
        ? `${opts.supplierName} — ${opts.contactPerson}`
        : opts.supplierName;

      doc.font("Amiri").fontSize(9).fillColor("#8899aa")
        .text("إلى المورّد:", MARGIN, y, {
          width: CONTENT_W,
          align: "right",
          lineBreak: false,
        });
      y += 16;

      doc.font("Amiri").fontSize(15).fillColor(BLUE)
        .text(supplierLine, MARGIN, y, {
          width: CONTENT_W,
          align: "right",
          lineBreak: false,
        });
      y += 26;

      doc.font("Amiri").fontSize(10).fillColor("#555555")
        .text(
          "يسرنا الاستفسار عن أسعار الأصناف التالية، ونرجو التفضل بتزويدنا بأفضل عروض الأسعار قبل التاريخ المحدد أعلاه.",
          MARGIN,
          y,
          { width: CONTENT_W, align: "right" },
        );
      y += 28;

      // ── ITEMS TABLE (RTL layout) ───────────────────────────────────────────
      //
      // Columns ordered logically (index 0 = rightmost in RTL):
      //   0: #          (36 px)
      //   1: رقم القطعة (105 px)
      //   2: الوصف      (remaining width)
      //   3: الكمية     (64 px)
      //   4: الوحدة     (58 px)  ← leftmost in RTL
      //
      const DESC_W = CONTENT_W - 36 - 105 - 64 - 58;
      const COL_W    = [36, 105, DESC_W, 64, 58];
      const COL_LABELS = ["#", "رقم القطعة", "الوصف", "الكمية", "الوحدة"];
      const ROW_H = 22;

      /**
       * RTL column X positions.
       * We walk from the RIGHT edge of the content area and subtract each
       * column's width in order, so column 0 (#) ends up on the far right.
       */
      function colX(colIndex: number): number {
        let x = MARGIN + CONTENT_W;
        for (let k = 0; k <= colIndex; k++) x -= COL_W[k];
        return x;
      }

      // Header row
      doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill(BLUE);
      COL_LABELS.forEach((label, i) => {
        doc.font("Amiri").fontSize(10).fillColor("#ffffff")
          .text(label, colX(i), y + 5, {
            width: COL_W[i],
            align: "center",
            lineBreak: false,
          });
      });
      y += ROW_H;

      // Data rows
      opts.items.forEach((item, idx) => {
        const rowBg = idx % 2 === 0 ? "#ffffff" : "#f4f7fa";
        doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill(rowBg).stroke("#d8e0e8");

        const cells = [
          String(idx + 1),
          item.partNo ?? "—",
          item.description,
          formatQty(item.qty),   // ← zeros removed here
          item.uom ?? "—",
        ];

        cells.forEach((val, i) => {
          doc.font("Amiri").fontSize(10).fillColor("#333333")
            .text(val, colX(i) + 3, y + 5, {
              width: COL_W[i] - 6,
              // Description (index 2) aligns right (Arabic text), others centre
              align: i === 2 ? "right" : "center",
              lineBreak: false,
            });
        });
        y += ROW_H;
      });

      // ── NOTES ─────────────────────────────────────────────────────────────
      if (opts.notes?.trim()) {
        y += 14;
        const notesH = 44;
        doc.rect(MARGIN, y, CONTENT_W, notesH).fill("#f0f4f8");
        // RTL: accent bar on the LEFT (visually the "end" in LTR, but "start" in RTL layout is right)
        doc.rect(MARGIN, y, 4, notesH).fill(BLUE);
        doc.font("Amiri").fontSize(9).fillColor("#888888")
          .text("ملاحظات:", MARGIN + 6, y + 6, {
            width: CONTENT_W - 18,
            align: "right",
            lineBreak: false,
          });
        doc.font("Amiri").fontSize(11).fillColor("#333333")
          .text(opts.notes.trim(), MARGIN + 6, y + 22, {
            width: CONTENT_W - 18,
            align: "right",
            lineBreak: false,
          });
        y += notesH;
      }

      // ── FOOTER ────────────────────────────────────────────────────────────
      const footerY = Math.max(y + 24, doc.page.height - 60);
      doc.rect(MARGIN, footerY, CONTENT_W, 1.5).fill(GOLD);

      // Line 1: employee contact
      const contactLine = [
        opts.employeeName,
        opts.employeePhone,
        "INFO@CORTOBA-SUPPLIES.COM",
      ]
        .filter(Boolean)
        .join("   |   ");

      doc.font("Amiri").fontSize(10).fillColor("#555555")
        .text(contactLine, MARGIN, footerY + 8, {
          width: CONTENT_W,
          align: "center",
          lineBreak: false,
        });

      // Line 2: company address
      doc.font("Amiri").fontSize(8).fillColor("#999999")
        .text(
          "ش.الإسكندرية - برج نجمة مطروح، الدور الرابع - مرسي مطروح   |   ت: 432-972-587   |   س-ت: 21618",
          MARGIN,
          footerY + 24,
          { width: CONTENT_W, align: "center", lineBreak: false },
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

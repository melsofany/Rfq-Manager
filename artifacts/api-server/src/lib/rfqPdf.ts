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

  // Logo image removed — pdfkit PNG stream causes zlib uncaught exception; using text instead



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
        doc.rect(0, 0, PAGE_W, 80).fill(BLUE);

        // Company name text (replacing logo image to avoid pdfkit zlib uncaught exception on PNG)
        doc.font("Amiri").fontSize(11).fillColor(GOLD)
          .text("قرطبة للتوريدات", PAGE_W - MARGIN - 100, 20, { width: 100, align: "right", lineBreak: false });
        doc.font("Amiri").fontSize(8).fillColor("#aaccee")
          .text("CORTOBA SUPPLIES", PAGE_W - MARGIN - 100, 40, { width: 100, align: "right", lineBreak: false });

        // Title text (left side of header = right in RTL view)
        doc.font("Amiri").fontSize(22).fillColor("#ffffff")
          .text("طلب عرض سعر", MARGIN, 16, { lineBreak: false });
        doc.font("Amiri").fontSize(9).fillColor(GOLD)
          .text("REQUEST FOR QUOTATION", MARGIN, 48, { lineBreak: false });

        // ── INFO BAND ─────────────────────────────────────────────────────────
        const INFO_Y = 80;
        const INFO_H = 52;
        doc.rect(0, INFO_Y, PAGE_W, INFO_H).fill(GREY_BG);
        doc.rect(0, INFO_Y + INFO_H - 2.5, PAGE_W, 2.5).fill(GOLD);

        const infoCells = [
          { label: "رقم الطلب الداخلي", value: opts.rfqNo },
          { label: "رقم RFQ العميل", value: opts.customerRfqNo },
          { label: "تاريخ الإصدار", value: rfqDate },
          { label: "آخر موعد للتقديم", value: closeDate },
        ];

        const cellW = CONTENT_W / infoCells.length;
        infoCells.forEach((cell, i) => {
          const cx = MARGIN + i * cellW;
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

        // To-supplier line
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

        // ── ITEMS TABLE ───────────────────────────────────────────────────────
        const COL_W = [36, 105, CONTENT_W - 36 - 105 - 64 - 58, 64, 58];
        const COL_LABELS = ["#", "رقم القطعة", "الوصف", "الكمية", "الوحدة"];
        const ROW_H = 22;

        // Header row
        doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill(BLUE);
        let cx = MARGIN;
        COL_LABELS.forEach((label, i) => {
          doc.font("Amiri").fontSize(10).fillColor("#ffffff")
            .text(label, cx, y + 5, {
              width: COL_W[i],
              align: "center",
              lineBreak: false,
            });
          cx += COL_W[i];
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
            item.qty ?? "—",
            item.uom ?? "—",
          ];

          cx = MARGIN;
          cells.forEach((val, i) => {
            doc.font("Amiri").fontSize(10).fillColor("#333333")
              .text(val, cx + 3, y + 5, {
                width: COL_W[i] - 6,
                align: i === 2 ? "right" : "center",
                lineBreak: false,
              });
            cx += COL_W[i];
          });
          y += ROW_H;
        });

        // ── NOTES ─────────────────────────────────────────────────────────────
        if (opts.notes?.trim()) {
          y += 14;
          const notesH = 44;
          doc.rect(MARGIN, y, CONTENT_W, notesH).fill("#f0f4f8");
          doc.rect(MARGIN + CONTENT_W - 4, y, 4, notesH).fill(BLUE);
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
        const footerY = Math.max(y + 24, doc.page.height - 50);
        doc.rect(MARGIN, footerY, CONTENT_W, 1.5).fill(GOLD);
        const contact = [
          opts.employeeName,
          opts.employeePhone,
          "INFO@CORTOBA-SUPPLIES.COM",
        ]
          .filter(Boolean)
          .join("   |   ");
        doc.font("Amiri").fontSize(10).fillColor("#777777")
          .text(contact, MARGIN, footerY + 8, {
            width: CONTENT_W,
            align: "center",
            lineBreak: false,
          });

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }
  
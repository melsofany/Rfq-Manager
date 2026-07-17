import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

export interface DispatchSupplier {
  supplierName: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  linkOpened: boolean;
  openCount: number;
  offerSubmitted: boolean;
  createdAt: string;
}

export interface DispatchReportOptions {
  rfqNo: string;
  customerRfqNo: string;
  exportDate: string;
  suppliers: DispatchSupplier[];
}

function getFontPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "assets/fonts/Amiri-Regular.ttf");
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-GB");
  } catch {
    return iso;
  }
}

function channelLabel(s: DispatchSupplier): string {
  const hasPhone = !!s.phone?.trim();
  const hasEmail = !!s.email?.trim();
  if (hasPhone && hasEmail) return "WA + Email";
  if (hasPhone) return "WhatsApp";
  if (hasEmail) return "Email";
  return "-";
}

/**
 * Generate the dispatch-report PDF and return it as a Buffer.
 * Uses the Amiri font (same as rfqPdf / offersPdf) so Arabic text renders correctly.
 */
export function generateDispatchReportPdf(opts: DispatchReportOptions): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const fontPath = getFontPath();

    const doc = new PDFDocument({
      size: "A4",
      layout: "portrait",
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: true,
      compress: false,
      info: {
        Title: `Dispatch Report - ${opts.rfqNo}`,
        Author: "Cortoba Supplies",
      },
    });

    // Attach stream listeners BEFORE writing content
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => settle(() => resolve(Buffer.concat(chunks))));
    doc.on("error", (err: Error) => settle(() => reject(err)));

    // Register Arabic font — same font file used by rfqPdf and offersPdf
    doc.registerFont("Amiri", fontPath);

    const PAGE_W = doc.page.width;
    const PAGE_H = doc.page.height;
    const M = 28;
    const CW = PAGE_W - M * 2;

    const BLUE = "#1a3a5c";
    const GOLD = "#c8a84b";
    const GREY_BG = "#eef2f7";
    const GREEN = "#1a7a4a";
    const AMBER = "#b45309";
    const WHITE = "#ffffff";
    const LIGHT = "#f4f8fc";
    const BORDER = "#d0dbe8";

    // ── header ──────────────────────────────────────────────────────────────
    function drawHeader(yStart: number): number {
      const H = 68;
      doc.rect(0, yStart, PAGE_W, H).fill(BLUE);
      doc
        .font("Amiri")
        .fontSize(20)
        .fillColor(WHITE)
        .text("Dispatch Report - RFQ", M, yStart + 12, { lineBreak: false });
      doc
        .font("Amiri")
        .fontSize(10)
        .fillColor(GOLD)
        .text("RFQ SEND LOG  |  Cortoba Supplies", M, yStart + 44, { lineBreak: false });
      return yStart + H;
    }

    // ── info bar ─────────────────────────────────────────────────────────────
    function drawInfoBar(yStart: number): number {
      const H = 48;
      doc.rect(0, yStart, PAGE_W, H).fill(GREY_BG);
      doc.rect(0, yStart + H - 2, PAGE_W, 2).fill(GOLD);
      const cells = [
        { label: "Internal RFQ No", value: opts.rfqNo },
        { label: "Customer RFQ No", value: opts.customerRfqNo || "-" },
        { label: "Export Date", value: opts.exportDate },
        { label: "Total Suppliers", value: String(opts.suppliers.length) },
      ];
      const cellW = CW / cells.length;
      cells.forEach((c, i) => {
        const cx = M + i * cellW;
        doc
          .font("Amiri")
          .fontSize(8)
          .fillColor("#7a8fa6")
          .text(c.label, cx, yStart + 8, { width: cellW, align: "center", lineBreak: false });
        doc
          .font("Amiri")
          .fontSize(12)
          .fillColor(BLUE)
          .text(c.value, cx, yStart + 24, { width: cellW, align: "center", lineBreak: false });
      });
      return yStart + H;
    }

    // ── footer ───────────────────────────────────────────────────────────────
    function drawFooter(): void {
      const fy = PAGE_H - 22;
      doc.rect(0, fy, PAGE_W, 22).fill(BLUE);
      doc
        .font("Amiri")
        .fontSize(8)
        .fillColor(GOLD)
        .text("Cortoba Supplies  |  INFO@CORTOBA-SUPPLIES.COM", M, fy + 7, {
          width: CW,
          align: "center",
          lineBreak: false,
        });
    }

    // ── table header ─────────────────────────────────────────────────────────
    const ROW_H = 26;
    // col widths must add up to CW (538 for A4 with M=28 each side)
    const colWidths = [26, 130, 90, 88, 68, 52, 46, 38] as const;
    const colLabels = ["#", "Supplier", "Contact", "Phone", "Method", "Opened", "Offer", "Sent"];

    function drawTableHeader(yStart: number): number {
      doc.rect(M, yStart, CW, ROW_H).fill(BLUE);
      let tx = M;
      colLabels.forEach((h, i) => {
        doc
          .font("Amiri")
          .fontSize(8.5)
          .fillColor(WHITE)
          .text(h, tx + 2, yStart + 9, {
            width: colWidths[i] - 4,
            align: "center",
            lineBreak: false,
          });
        tx += colWidths[i];
      });
      return yStart + ROW_H;
    }

    try {
      // ── page 1 ──────────────────────────────────────────────────────────
      let y = drawHeader(0);
      y = drawInfoBar(y);
      y += 12;

      doc
        .font("Amiri")
        .fontSize(11)
        .fillColor(BLUE)
        .text("Suppliers who received this RFQ", M, y, { width: CW, lineBreak: false });
      y += 20;
      y = drawTableHeader(y);

      // ── rows ────────────────────────────────────────────────────────────
      opts.suppliers.forEach((s, idx) => {
        if (y + ROW_H > PAGE_H - 50) {
          drawFooter();
          doc.addPage({ size: "A4", margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          y = drawHeader(0);
          y += 8;
          y = drawTableHeader(y);
        }

        const rowBg = idx % 2 === 0 ? WHITE : LIGHT;
        doc.rect(M, y, CW, ROW_H).fill(rowBg).strokeColor(BORDER).lineWidth(0.3).stroke();

        const method = channelLabel(s);
        const methodColor =
          method === "WA + Email"
            ? BLUE
            : method === "WhatsApp"
              ? GREEN
              : method === "Email"
                ? AMBER
                : "#999999";

        const cells: { text: string; color: string; align: "center" | "left" }[] = [
          { text: String(idx + 1), color: "#666666", align: "center" },
          { text: s.supplierName || "-", color: "#111827", align: "left" },
          { text: s.contactPerson || "-", color: "#555555", align: "left" },
          { text: s.phone || "-", color: BLUE, align: "center" },
          { text: method, color: methodColor, align: "center" },
          {
            text: s.linkOpened ? `Yes (${s.openCount})` : "No",
            color: s.linkOpened ? GREEN : "#aaaaaa",
            align: "center",
          },
          {
            text: s.offerSubmitted ? "Yes" : "No",
            color: s.offerSubmitted ? GREEN : "#aaaaaa",
            align: "center",
          },
          { text: fmtDate(s.createdAt), color: "#666666", align: "center" },
        ];

        let tx = M;
        cells.forEach((cell, i) => {
          doc
            .font("Amiri")
            .fontSize(9)
            .fillColor(cell.color)
            .text(cell.text, tx + 3, y + 8, {
              width: colWidths[i] - 6,
              align: cell.align,
              lineBreak: false,
            });
          tx += colWidths[i];
        });
        y += ROW_H;
      });

      // ── summary bar ─────────────────────────────────────────────────────
      y += 10;
      if (y + 36 > PAGE_H - 50) {
        drawFooter();
        doc.addPage({ size: "A4", margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        y = 24;
      }

      const waCount = opts.suppliers.filter((s) => s.phone?.trim()).length;
      const emailCount = opts.suppliers.filter((s) => s.email?.trim()).length;
      const opened = opts.suppliers.filter((s) => s.linkOpened).length;
      const submitted = opts.suppliers.filter((s) => s.offerSubmitted).length;

      doc.rect(M, y, CW, 30).fill(GREY_BG).strokeColor(BORDER).lineWidth(0.4).stroke();
      doc
        .font("Amiri")
        .fontSize(9)
        .fillColor(BLUE)
        .text(
          `Total: ${opts.suppliers.length}   |   WhatsApp: ${waCount}   |   Email: ${emailCount}   |   Link opened: ${opened}   |   Offer submitted: ${submitted}`,
          M + 4,
          y + 10,
          { width: CW - 8, align: "center", lineBreak: false },
        );

      drawFooter();
      doc.end();
    } catch (buildErr) {
      settle(() => reject(buildErr as Error));
    }
  });
}

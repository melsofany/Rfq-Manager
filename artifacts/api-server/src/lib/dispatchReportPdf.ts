import PDFDocument from "pdfkit";

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

// Cortoba logo embedded as base64 (same as rfqPdf.ts)
const LOGO_BASE64 = "data:image/png;base64,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";

function getLogoBuffer(): Buffer {
  return Buffer.from(LOGO_BASE64.replace("data:image/png;base64,", ""), "base64");
}

function channelLabel(s: DispatchSupplier): string {
  const hasPhone = !!(s.phone?.trim());
  const hasEmail = !!(s.email?.trim());
  if (hasPhone && hasEmail) return "WhatsApp + Email";
  if (hasPhone) return "WhatsApp";
  if (hasEmail) return "Email";
  return "-";
}

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString("en-GB"); } catch { return iso; }
}

/**
 * Generates the dispatch report as a Buffer.
 *
 * IMPORTANT: event listeners are attached immediately after doc creation —
 * before any content is written — to match the rfqPdf.ts pattern and ensure
 * no `data` events are lost on the PDFKit stream.
 */
export function generateDispatchReportPdf(opts: DispatchReportOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      // ── 1. Create document ──────────────────────────────────────────────────
      const doc = new PDFDocument({
        size: "A4",
        layout: "portrait",
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        autoFirstPage: true,
        info: {
          Title: `Dispatch Report - ${opts.rfqNo}`,
          Author: "Cortoba Supplies",
        },
      });

      // ── 2. Attach stream listeners FIRST (same pattern as rfqPdf.ts) ────────
      const chunks: Buffer[] = [];
      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
      doc.on("data",  (chunk: Buffer) => chunks.push(chunk));
      doc.on("end",   () => settle(() => resolve(Buffer.concat(chunks))));
      doc.on("error", (err: Error)   => settle(() => reject(err)));

      // ── 3. Layout constants ─────────────────────────────────────────────────
      const PAGE_W  = doc.page.width;   // 595.28
      const PAGE_H  = doc.page.height;  // 841.89
      const MARGIN  = 28;
      const CW      = PAGE_W - MARGIN * 2;

      const BLUE    = "#1a3a5c";
      const GOLD    = "#c8a84b";
      const GREY_BG = "#eef2f7";
      const GREEN_C = "#1a7a4a";
      const AMBER   = "#b45309";
      const WHITE   = "#ffffff";

      // ── 4. Helper: page header ──────────────────────────────────────────────
      function drawHeader(yStart: number): number {
        const HDR_H = 72;
        doc.rect(0, yStart, PAGE_W, HDR_H).fill(BLUE);
        try {
          doc.image(getLogoBuffer(), PAGE_W - MARGIN - 60, yStart + 7, { height: 58 });
        } catch { /* non-fatal */ }
        doc.font("Helvetica-Bold").fontSize(18).fillColor(WHITE)
          .text("Dispatch Report - RFQ", MARGIN, yStart + 14, { lineBreak: false });
        doc.font("Helvetica").fontSize(9).fillColor(GOLD)
          .text("RFQ DISPATCH REPORT", MARGIN, yStart + 44, { lineBreak: false });
        return yStart + HDR_H;
      }

      // ── 5. Helper: page footer ──────────────────────────────────────────────
      function drawFooter(): void {
        const footerY = PAGE_H - 22;
        doc.rect(0, footerY, PAGE_W, 22).fill(BLUE);
        doc.font("Helvetica").fontSize(8).fillColor(GOLD)
          .text(
            "Cortoba Supplies  |  INFO@CORTOBA-SUPPLIES.COM",
            MARGIN, footerY + 7,
            { width: CW, align: "center", lineBreak: false },
          );
      }

      // ── 6. Helper: info bar ─────────────────────────────────────────────────
      function drawInfoBar(yStart: number): number {
        const INFO_H = 46;
        doc.rect(0, yStart, PAGE_W, INFO_H).fill(GREY_BG);
        doc.rect(0, yStart + INFO_H - 2, PAGE_W, 2).fill(GOLD);
        const cells = [
          { label: "Internal RFQ No",  value: opts.rfqNo },
          { label: "Customer RFQ No",  value: opts.customerRfqNo },
          { label: "Export Date",       value: opts.exportDate },
          { label: "Total Suppliers",   value: String(opts.suppliers.length) },
        ];
        const cellW = CW / cells.length;
        cells.forEach((cell, i) => {
          const cx = MARGIN + i * cellW;
          doc.font("Helvetica").fontSize(7).fillColor("#7a8fa6")
            .text(cell.label, cx, yStart + 7,  { width: cellW, align: "center", lineBreak: false });
          doc.font("Helvetica-Bold").fontSize(11).fillColor(BLUE)
            .text(cell.value, cx, yStart + 22, { width: cellW, align: "center", lineBreak: false });
        });
        return yStart + INFO_H;
      }

      // ── 7. Table layout ─────────────────────────────────────────────────────
      const ROW_H = 24;
      const COL = { num: 28, name: 120, contact: 88, phone: 90, method: 80, opened: 52, offer: 50 };
      const dateW = CW - Object.values(COL).reduce((a, b) => a + b, 0);
      const colWidths  = [COL.num, COL.name, COL.contact, COL.phone, COL.method, COL.opened, COL.offer, dateW];
      const colHeaders = ["#", "Supplier", "Contact", "Phone", "Method", "Opened", "Offer", "Sent Date"];

      function drawTableHeader(yStart: number): number {
        doc.rect(MARGIN, yStart, CW, ROW_H).fill(BLUE);
        let tx = MARGIN;
        colHeaders.forEach((h, i) => {
          doc.font("Helvetica-Bold").fontSize(8).fillColor(WHITE)
            .text(h, tx + 2, yStart + 7, { width: colWidths[i] - 4, align: "center", lineBreak: false });
          tx += colWidths[i];
        });
        return yStart + ROW_H;
      }

      // ── 8. Build content ────────────────────────────────────────────────────
      let y = drawHeader(0);
      y = drawInfoBar(y);
      y += 10;

      doc.font("Helvetica-Bold").fontSize(11).fillColor(BLUE)
        .text("Suppliers who received this RFQ", MARGIN, y, { width: CW, align: "left", lineBreak: false });
      y += 20;
      y = drawTableHeader(y);

      opts.suppliers.forEach((s, idx) => {
        if (y + ROW_H > PAGE_H - 50) {
          drawFooter();
          doc.addPage({ size: "A4", margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          y = drawHeader(0);
          y += 6;
          y = drawTableHeader(y);
        }

        const rowBg = idx % 2 === 0 ? WHITE : "#f4f8fc";
        doc.rect(MARGIN, y, CW, ROW_H).fill(rowBg).stroke("#d0dbe8");

        const method = channelLabel(s);
        const methodColor = method.includes("WhatsApp") && method.includes("Email") ? BLUE
          : method.includes("WhatsApp") ? GREEN_C
          : method.includes("Email")    ? AMBER
          : "#888888";

        const cells = [
          { text: String(idx + 1),        color: "#666666",  align: "center" as const },
          { text: s.supplierName || "-",  color: "#1a2a3a",  align: "left"   as const },
          { text: s.contactPerson || "-", color: "#555555",  align: "left"   as const },
          { text: s.phone || "-",         color: BLUE,       align: "center" as const },
          { text: method,                 color: methodColor, align: "center" as const },
          { text: s.linkOpened ? `Yes (${s.openCount})` : "No",
            color: s.linkOpened ? GREEN_C : "#aaaaaa", align: "center" as const },
          { text: s.offerSubmitted ? "Yes" : "No",
            color: s.offerSubmitted ? GREEN_C : "#aaaaaa", align: "center" as const },
          { text: fmtDate(s.createdAt),   color: "#666666",  align: "center" as const },
        ];

        let tx = MARGIN;
        cells.forEach((cell, i) => {
          doc.font("Helvetica").fontSize(8.5).fillColor(cell.color)
            .text(cell.text, tx + 3, y + 7, { width: colWidths[i] - 6, align: cell.align, lineBreak: false });
          tx += colWidths[i];
        });
        y += ROW_H;
      });

      // ── 9. Summary row ──────────────────────────────────────────────────────
      y += 8;
      if (y + 32 > PAGE_H - 50) {
        drawFooter();
        doc.addPage({ size: "A4", margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        y = 20;
      }

      const waCount    = opts.suppliers.filter(s => s.phone?.trim()).length;
      const emailCount = opts.suppliers.filter(s => s.email?.trim()).length;
      const opened     = opts.suppliers.filter(s => s.linkOpened).length;
      const submitted  = opts.suppliers.filter(s => s.offerSubmitted).length;

      doc.rect(MARGIN, y, CW, 28).fill(GREY_BG).stroke("#d0dbe8");
      doc.font("Helvetica").fontSize(9).fillColor(BLUE)
        .text(
          `Total: ${opts.suppliers.length} suppliers  |  WhatsApp: ${waCount}  |  Email: ${emailCount}  |  Opened link: ${opened}  |  Submitted offer: ${submitted}`,
          MARGIN + 4, y + 9,
          { width: CW - 8, align: "center", lineBreak: false },
        );

      drawFooter();

      // ── 10. Finalize ────────────────────────────────────────────────────────
      doc.end();

    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Returns a PDFDocument pre-populated with the dispatch report content.
 * The caller must attach stream listeners and call doc.end().
 *
 * NOTE: Prefer generateDispatchReportPdf() for buffer generation — it attaches
 * listeners before writing content, which is the safe PDFKit pattern.
 */
export function createDispatchReportPdfDoc(opts: DispatchReportOptions): PDFKit.PDFDocument {
  // Thin shell kept for API compatibility. Internally delegates to a
  // synchronous doc build (listeners must be attached by the caller before end()).
  const doc = new PDFDocument({
    size: "A4",
    layout: "portrait",
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    autoFirstPage: true,
    info: { Title: `Dispatch Report - ${opts.rfqNo}`, Author: "Cortoba Supplies" },
  });
  // Intentionally NOT building content here — callers should use
  // generateDispatchReportPdf() instead, which is the safe pattern.
  return doc;
}

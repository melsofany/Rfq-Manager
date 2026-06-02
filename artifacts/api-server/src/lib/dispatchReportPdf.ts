import PDFDocument from "pdfkit";
  import { resolve, dirname } from "path";
  import { fileURLToPath } from "url";
  import { existsSync, readFileSync } from "fs";

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

  const LOGO_BASE64 =
    "data:image/png;base64,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";

  function getLogoBuffer(): Buffer {
    const base64 = LOGO_BASE64.replace("data:image/png;base64,", "");
    return Buffer.from(base64, "base64");
  }

  // Cache the Amiri font as a Buffer at module load time.
  // PDFKit font subsetting is CPU-intensive; caching avoids repeated disk reads
  // and allows Node.js to reuse the same Buffer across requests.
  let _cachedFontBuffer: Buffer | null = null;

  function getFontBuffer(): Buffer {
    if (_cachedFontBuffer) return _cachedFontBuffer;
    const g = globalThis as Record<string, unknown>;
    const baseDir: string =
      typeof g.__dirname === "string"
        ? (g.__dirname as string)
        : dirname(fileURLToPath(import.meta.url));
    const fontPath = resolve(baseDir, "assets/fonts/Amiri-Regular.ttf");
    if (!existsSync(fontPath)) {
      throw new Error(
        `Amiri font missing at: ${fontPath} (baseDir=${baseDir})`
      );
    }
    _cachedFontBuffer = readFileSync(fontPath);
    return _cachedFontBuffer;
  }

  function channel(s: DispatchSupplier): string {
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
   * Creates and draws the dispatch report PDF document.
   * Does NOT call doc.end() — caller must call doc.end() after piping.
   * Use this for streaming: pipe doc to res, then call doc.end().
   */
  export function createDispatchReportPdfDoc(opts: DispatchReportOptions): PDFKit.PDFDocument {
    const doc = new PDFDocument({
      size: "A4",
      layout: "portrait",
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: true,
      compress: false,
    });

    doc.registerFont("Amiri", getFontBuffer());

    const PAGE_W = doc.page.width;
    const PAGE_H = doc.page.height;
    const MARGIN = 28;
    const CW = PAGE_W - MARGIN * 2;
    const BLUE = "#1a3a5c";
    const GOLD = "#c8a84b";
    const GREY_BG = "#eef2f7";
    const GREEN_C = "#1a7a4a";
    const AMBER = "#b45309";

    function drawPageHeader(y0: number) {
      doc.rect(0, y0, PAGE_W, 72).fill(BLUE);
      try { doc.image(getLogoBuffer(), PAGE_W - MARGIN - 56, y0 + 7, { height: 58 }); } catch { /* ok */ }
      doc.font("Amiri").fontSize(20).fillColor("#ffffff")
        .text("Dispatch Report - RFQ", MARGIN, y0 + 14, { lineBreak: false });
      doc.font("Amiri").fontSize(9).fillColor(GOLD)
        .text("RFQ DISPATCH REPORT", MARGIN, y0 + 44, { lineBreak: false });
      return y0 + 72;
    }

    let y = drawPageHeader(0);

    const INFO_H = 46;
    doc.rect(0, y, PAGE_W, INFO_H).fill(GREY_BG);
    doc.rect(0, y + INFO_H - 2, PAGE_W, 2).fill(GOLD);
    const infoCells = [
      { label: "Internal RFQ No", value: opts.rfqNo },
      { label: "Customer RFQ No",  value: opts.customerRfqNo },
      { label: "Export Date",       value: opts.exportDate },
      { label: "Supplier Count",    value: String(opts.suppliers.length) },
    ];
    const cellW = CW / infoCells.length;
    infoCells.forEach((cell, i) => {
      const cx = MARGIN + i * cellW;
      doc.font("Amiri").fontSize(7).fillColor("#7a8fa6")
        .text(cell.label, cx, y + 7, { width: cellW, align: "center", lineBreak: false });
      doc.font("Amiri").fontSize(11).fillColor(BLUE)
        .text(cell.value, cx, y + 22, { width: cellW, align: "center", lineBreak: false });
    });
    y += INFO_H;

    y += 10;
    doc.font("Amiri").fontSize(11).fillColor(BLUE)
      .text("Suppliers who received this RFQ", MARGIN, y,
        { width: CW, align: "left", lineBreak: false });
    y += 20;

    const ROW_H = 24;
    const C = { num: 28, name: 118, contact: 88, phone: 92, method: 80, opened: 50, offer: 50 };
    const dateColW = CW - Object.values(C).reduce((a, b) => a + b, 0);
    const colW = [C.num, C.name, C.contact, C.phone, C.method, C.opened, C.offer, dateColW];
    const tableHeaders = ["#", "Supplier", "Contact", "Phone", "Method", "Opened", "Offer", "Sent Date"];

    function drawTableHeader(ty: number) {
      doc.rect(MARGIN, ty, CW, ROW_H).fill(BLUE);
      let tx = MARGIN;
      tableHeaders.forEach((h, i) => {
        doc.font("Amiri").fontSize(8).fillColor("#ffffff")
          .text(h, tx + 2, ty + 7, { width: colW[i] - 4, align: "center", lineBreak: false });
        tx += colW[i];
      });
      return ty + ROW_H;
    }

    y = drawTableHeader(y);

    opts.suppliers.forEach((s, idx) => {
      if (y + ROW_H > PAGE_H - 28) {
        doc.rect(0, PAGE_H - 22, PAGE_W, 22).fill(BLUE);
        doc.font("Amiri").fontSize(8).fillColor(GOLD)
          .text("Cortoba Supplies  |  INFO@CORTOBA-SUPPLIES.COM",
            MARGIN, PAGE_H - 14, { width: CW, align: "center", lineBreak: false });
        doc.addPage({ size: "A4", margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        y = drawPageHeader(0);
        y += 6;
        y = drawTableHeader(y);
      }

      const rowBg = idx % 2 === 0 ? "#ffffff" : "#f4f8fc";
      doc.rect(MARGIN, y, CW, ROW_H).fill(rowBg);
      doc.rect(MARGIN, y, CW, ROW_H).stroke("#d0dbe8");

      const meth = channel(s);
      const methColor = meth.includes("WhatsApp") && meth.includes("Email") ? BLUE
        : meth.includes("WhatsApp") ? GREEN_C
        : meth.includes("Email") ? AMBER : "#888";
      const openText  = s.linkOpened ? `Yes (${s.openCount})` : "No";
      const offerText = s.offerSubmitted ? "Yes" : "No";

      const cells = [
        { t: String(idx + 1),       c: "#666",    a: "center" as const },
        { t: s.supplierName || "-", c: "#1a2a3a", a: "left"   as const },
        { t: s.contactPerson || "-",c: "#555",    a: "left"   as const },
        { t: s.phone || "-",        c: BLUE,      a: "center" as const },
        { t: meth,                  c: methColor, a: "center" as const },
        { t: openText,              c: s.linkOpened ? GREEN_C : "#aaa", a: "center" as const },
        { t: offerText,             c: s.offerSubmitted ? GREEN_C : "#aaa", a: "center" as const },
        { t: fmtDate(s.createdAt),  c: "#666",    a: "center" as const },
      ];

      let tx = MARGIN;
      cells.forEach((cell, i) => {
        doc.font("Amiri").fontSize(8.5).fillColor(cell.c)
          .text(cell.t, tx + 3, y + 7,
            { width: colW[i] - 6, align: cell.a, lineBreak: false });
        tx += colW[i];
      });
      y += ROW_H;
    });

    y += 8;
    if (y + 32 > PAGE_H - 28) {
      doc.addPage({ size: "A4", margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      y = 20;
    }
    const waCount    = opts.suppliers.filter(s => s.phone?.trim()).length;
    const emailCount = opts.suppliers.filter(s => s.email?.trim()).length;
    const opened     = opts.suppliers.filter(s => s.linkOpened).length;
    const submitted  = opts.suppliers.filter(s => s.offerSubmitted).length;
    doc.rect(MARGIN, y, CW, 28).fill(GREY_BG);
    doc.rect(MARGIN, y, CW, 28).stroke("#d0dbe8");
    doc.font("Amiri").fontSize(9).fillColor(BLUE)
      .text(
        `Total: ${opts.suppliers.length} suppliers  |  WhatsApp: ${waCount}  |  Email: ${emailCount}  |  Opened link: ${opened}  |  Submitted offer: ${submitted}`,
        MARGIN + 4, y + 9, { width: CW - 8, align: "center", lineBreak: false }
      );

    const footerY = PAGE_H - 22;
    doc.rect(0, footerY, PAGE_W, 22).fill(BLUE);
    doc.font("Amiri").fontSize(8).fillColor(GOLD)
      .text("Cortoba Supplies  |  INFO@CORTOBA-SUPPLIES.COM",
        MARGIN, footerY + 7, { width: CW, align: "center", lineBreak: false });

    return doc;
  }

  /**
   * Generates dispatch report PDF and resolves with a Buffer.
   * For streaming, prefer createDispatchReportPdfDoc() instead.
   */
  export function generateDispatchReportPdf(opts: DispatchReportOptions): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
      const pdfTimeout = setTimeout(
        () => reject(new Error("PDF generation timed out")),
        55_000
      );
      try {
        const doc = createDispatchReportPdfDoc(opts);
        const chunks: Buffer[] = [];
        let settled = false;
        const settle = (fn: () => void) => {
          if (!settled) { settled = true; clearTimeout(pdfTimeout); fn(); }
        };
        doc.on("data", (c: Buffer) => chunks.push(c));
        doc.on("end", () => settle(() => resolvePromise(Buffer.concat(chunks))));
        doc.on("error", (e: Error) => settle(() => reject(e)));
        doc.end();
      } catch (err) {
        clearTimeout(pdfTimeout);
        reject(err);
      }
    });
  }
  
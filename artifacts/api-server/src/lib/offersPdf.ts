import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const VAT_RATE = 0.14;

export interface OffersPdfOptions {
  rfqNo: string;
  customerRfqNo: string;
  exportDate: string;
  itemAnalysis: Array<{
    rfqItemId: number;
    description: string;
    partNo?: string | null;
    qty?: number | null;
    uom?: string | null;
    referencePrice?: number | null;
    minPrice?: number | null;
    maxPrice?: number | null;
    avgPrice?: number | null;
    offers: Array<{
      supplierName: string;
      price: number;
      priceWithVat: number;
      taxIncluded: boolean;
      deliveryDays?: number | null;
      deviation: number;
      isLowest: boolean;
      isAnomaly: boolean;
    }>;
  }>;
}

const LOGO_BASE64 =
  "data:image/png;base64,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";

function getLogoBuffer(): Buffer {
  const base64 = LOGO_BASE64.replace("data:image/png;base64,", "");
  return Buffer.from(base64, "base64");
}

function getFontPath(): string | null {
  try {
    const g = globalThis as Record<string, unknown>;
    const baseDir: string =
      typeof g.__dirname === "string"
        ? (g.__dirname as string)
        : dirname(fileURLToPath(import.meta.url));
    const fontPath = resolve(baseDir, "assets/fonts/Amiri-Regular.ttf");
    if (existsSync(fontPath)) return fontPath;
  } catch {
    // ignore
  }
  return null;
}

function fmt(n: number): string {
  return n.toLocaleString("en-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function generateOffersPdf(opts: OffersPdfOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Hard timeout — if PDFKit never emits "end", reject after 20s
    const hardTimeout = setTimeout(() => {
      reject(new Error("PDF generation timed out"));
    }, 20_000);

    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(hardTimeout);
        fn();
      }
    };

    try {
      const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",
        margins: { top: 36, bottom: 36, left: 36, right: 36 },
        autoFirstPage: true,
        compress: true,
        bufferPages: false,
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => settle(() => resolve(Buffer.concat(chunks))));
      doc.on("error", (err: Error) => settle(() => reject(err)));

      // Register Arabic font if available, else fall back to Helvetica
      const fontPath = getFontPath();
      const FONT = fontPath ? "Amiri" : "Helvetica";
      const FONT_BOLD = fontPath ? "Amiri" : "Helvetica-Bold";
      if (fontPath) doc.registerFont("Amiri", fontPath);

      const PAGE_W = doc.page.width;
      const MARGIN = 36;
      const CONTENT_W = PAGE_W - MARGIN * 2;

      const BLUE = "#1a3a5c";
      const GOLD = "#c8a84b";
      const GREEN = "#166534";
      const AMBER = "#b45309";
      const GREY = "#f4f8fc";
      const BORDER = "#d0dbe8";

      // ── HEADER ────────────────────────────────────────────────────────────
      doc.rect(MARGIN, MARGIN, CONTENT_W, 60).fill(BLUE);

      // Logo
      try {
        doc.image(getLogoBuffer(), MARGIN + CONTENT_W - 60, MARGIN + 4, { height: 52 });
      } catch { /* skip */ }

      doc.font(FONT).fontSize(18).fillColor("#ffffff")
        .text("RFQ PRICE COMPARISON REPORT", MARGIN + 14, MARGIN + 10, { lineBreak: false });
      doc.font(FONT).fontSize(10).fillColor(GOLD)
        .text("\u062a\u0642\u0631\u064a\u0631 \u0645\u0642\u0627\u0631\u0646\u0629 \u0623\u0633\u0639\u0627\u0631 \u0627\u0644\u0639\u0631\u0648\u0636 | Cortoba Supplies", MARGIN + 14, MARGIN + 36, { lineBreak: false });

      // ── INFO BAND ─────────────────────────────────────────────────────────
      const infoY = MARGIN + 66;
      doc.rect(MARGIN, infoY, CONTENT_W, 38).fill(GREY);
      doc.rect(MARGIN, infoY + 36, CONTENT_W, 2).fill(GOLD);

      const infoCells = [
        { label: "Internal RFQ", value: opts.rfqNo },
        { label: "Customer RFQ", value: opts.customerRfqNo },
        { label: "Export Date", value: opts.exportDate },
        { label: "Items", value: String(opts.itemAnalysis.length) },
        { label: "VAT Rate", value: "14%" },
      ];
      const cellW = CONTENT_W / infoCells.length;
      infoCells.forEach((c, i) => {
        const cx = MARGIN + i * cellW;
        doc.font(FONT).fontSize(7).fillColor("#8899aa")
          .text(c.label, cx + 2, infoY + 6, { width: cellW - 4, align: "center", lineBreak: false });
        doc.font(FONT_BOLD).fontSize(10).fillColor(BLUE)
          .text(c.value, cx + 2, infoY + 20, { width: cellW - 4, align: "center", lineBreak: false });
      });

      // ── VAT NOTE ──────────────────────────────────────────────────────────
      const noteY = infoY + 46;
      doc.font(FONT).fontSize(7.5).fillColor("#555555")
        .text(
          "(*) Prices in the \"Incl. VAT\" column are normalized for comparison: supplier price is used as-is when tax is included, or multiplied by 1.14 when tax is excluded.",
          MARGIN, noteY, { width: CONTENT_W, lineBreak: false }
        );

      // ── TABLE ─────────────────────────────────────────────────────────────
      let y = noteY + 16;

      const allSuppliers = Array.from(
        new Set(opts.itemAnalysis.flatMap((ia) => ia.offers.map((o) => o.supplierName)))
      );

      // Fixed columns: #, Description, Part No, QTY/UOM
      const fixedCols = [
        { label: "#", w: 26 },
        { label: "Description", w: 160 },
        { label: "Part No", w: 82 },
        { label: "QTY", w: 54 },
        { label: "Summary (Incl. VAT)", w: 148 },
      ];
      const fixedW = fixedCols.reduce((s, c) => s + c.w, 0);
      const remaining = CONTENT_W - fixedW;
      // Each supplier gets 2 sub-columns: Original | Incl. VAT
      const supGroupW = allSuppliers.length > 0 ? Math.max(90, Math.floor(remaining / allSuppliers.length)) : 90;
      const supColW = Math.floor(supGroupW / 2);

      const totalTableW = fixedW + supGroupW * allSuppliers.length;
      const tableX = MARGIN + Math.max(0, (CONTENT_W - totalTableW) / 2);
      const ROW_H = 22;
      const PAGE_H = doc.page.height;

      const drawHeader = (hy: number): number => {
        // Top row — supplier names spanning 2 sub-cols each
        doc.rect(tableX, hy, totalTableW, ROW_H).fill(BLUE);
        // Fixed col headers
        let cx = tableX;
        fixedCols.forEach((col) => {
          doc.font(FONT_BOLD).fontSize(7).fillColor("#ffffff")
            .text(col.label, cx + 2, hy + 7, { width: col.w - 4, align: "center", lineBreak: false });
          cx += col.w;
        });
        // Supplier group headers
        allSuppliers.forEach((s) => {
          doc.font(FONT_BOLD).fontSize(7).fillColor("#ffffff")
            .text(s, cx + 2, hy + 7, { width: supGroupW - 4, align: "center", lineBreak: false });
          cx += supGroupW;
        });

        // Second row — sub-headers for each supplier
        const subY = hy + ROW_H;
        doc.rect(tableX, subY, totalTableW, 16).fill("#2a4a6c");
        cx = tableX;
        fixedCols.forEach((col) => {
          doc.rect(cx, subY, col.w, 16).stroke(BORDER);
          cx += col.w;
        });
        allSuppliers.forEach(() => {
          doc.font(FONT).fontSize(6.5).fillColor(GOLD)
            .text("Original", cx + 2, subY + 4, { width: supColW - 4, align: "center", lineBreak: false });
          cx += supColW;
          doc.font(FONT).fontSize(6.5).fillColor(GOLD)
            .text("Incl. VAT *", cx + 2, subY + 4, { width: supColW - 4, align: "center", lineBreak: false });
          cx += supColW;
        });

        return subY + 16;
      };

      y = drawHeader(y);

      // Draw rows
      opts.itemAnalysis.forEach((item, idx) => {
        if (y + ROW_H > PAGE_H - MARGIN - 20) {
          doc.addPage({ size: "A4", layout: "landscape", margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } });
          doc.rect(MARGIN, MARGIN, CONTENT_W, 22).fill(BLUE);
          doc.font(FONT_BOLD).fontSize(9).fillColor(GOLD)
            .text(`Cont. - ${opts.rfqNo}`, MARGIN + 8, MARGIN + 6, { lineBreak: false });
          y = MARGIN + 28;
          y = drawHeader(y);
        }

        const rowBg = idx % 2 === 0 ? "#ffffff" : GREY;
        doc.rect(tableX, y, totalTableW, ROW_H).fill(rowBg);

        // Draw light cell borders
        let cx = tableX;
        fixedCols.forEach((col) => {
          doc.rect(cx, y, col.w, ROW_H).stroke(BORDER);
          cx += col.w;
        });
        allSuppliers.forEach(() => {
          doc.rect(cx, y, supGroupW, ROW_H).stroke(BORDER);
          cx += supGroupW;
        });

        // Fill fixed cols
        cx = tableX;
        const textY = y + 7;

        doc.font(FONT).fontSize(7.5).fillColor("#555")
          .text(String(idx + 1), cx + 2, textY, { width: fixedCols[0].w - 4, align: "center", lineBreak: false });
        cx += fixedCols[0].w;

        doc.font(FONT).fontSize(7.5).fillColor("#1a1a1a")
          .text(item.description, cx + 3, textY, { width: fixedCols[1].w - 6, lineBreak: false });
        cx += fixedCols[1].w;

        doc.font(FONT).fontSize(7).fillColor("#555")
          .text(item.partNo ?? "—", cx + 2, textY, { width: fixedCols[2].w - 4, align: "center", lineBreak: false });
        cx += fixedCols[2].w;

        doc.font(FONT).fontSize(7.5).fillColor("#333")
          .text(item.qty != null ? `${item.qty} ${item.uom ?? ""}`.trim() : "—", cx + 2, textY, { width: fixedCols[3].w - 4, align: "center", lineBreak: false });
        cx += fixedCols[3].w;

        // Supplier price columns
        const bySupplier: Record<string, { price: number; priceWithVat: number; isLowest: boolean; isAnomaly: boolean }> = {};
        for (const o of item.offers) {
          bySupplier[o.supplierName] = {
            price: o.price,
            priceWithVat: o.priceWithVat,
            isLowest: o.isLowest,
            isAnomaly: o.isAnomaly,
          };
        }

        allSuppliers.forEach((s) => {
          const p = bySupplier[s];
          if (!p) {
            doc.font(FONT).fontSize(7.5).fillColor("#aaa")
              .text("—", cx + 2, textY, { width: supColW - 4, align: "center", lineBreak: false });
            cx += supColW;
            doc.font(FONT).fontSize(7.5).fillColor("#aaa")
              .text("—", cx + 2, textY, { width: supColW - 4, align: "center", lineBreak: false });
            cx += supColW;
          } else {
            const priceColor = p.isLowest ? GREEN : p.isAnomaly ? AMBER : "#333";
            // Original price
            doc.font(FONT).fontSize(7.5).fillColor("#555")
              .text(fmt(p.price), cx + 2, textY, { width: supColW - 4, align: "right", lineBreak: false });
            cx += supColW;
            // VAT-normalized price
            doc.font(FONT_BOLD).fontSize(7.5).fillColor(priceColor)
              .text(fmt(p.priceWithVat), cx + 2, textY, { width: supColW - 4, align: "right", lineBreak: false });
            if (p.isLowest) {
              doc.font(FONT).fontSize(6).fillColor(GREEN)
                .text("LOW", cx + 2, textY - 4, { width: supColW - 4, align: "left", lineBreak: false });
            }
            cx += supColW;
          }
        });

        // Summary col (VAT-inclusive min/avg/max)
        const summaryCol = fixedCols[4];
        const sx = tableX + fixedCols.slice(0, 4).reduce((a, c) => a + c.w, 0) + supGroupW * allSuppliers.length;
        const summaryText = item.minPrice != null
          ? `Min: ${fmt(item.minPrice)}\nAvg: ${fmt(item.avgPrice!)}\nMax: ${fmt(item.maxPrice!)}`
          : "No quotes";
        doc.font(FONT).fontSize(6.5).fillColor("#444")
          .text(summaryText, sx + 2, y + 3, { width: summaryCol.w - 6, align: "center", lineBreak: true });

        y += ROW_H;
      });

      // ── FOOTER ────────────────────────────────────────────────────────────
      const footerY = doc.page.height - MARGIN + 4;
      doc.rect(MARGIN, footerY - 6, CONTENT_W, 22).fill(BLUE);
      doc.font(FONT).fontSize(8).fillColor(GOLD)
        .text(
          `Cortoba Supplies | INFO@CORTOBA-SUPPLIES.COM | ${opts.exportDate} | All monetary values in EGP | VAT 14% applied to tax-exclusive prices`,
          MARGIN + 4,
          footerY + 2,
          { width: CONTENT_W - 8, align: "center", lineBreak: false }
        );

      doc.end();
    } catch (err) {
      settle(() => reject(err));
    }
  });
}

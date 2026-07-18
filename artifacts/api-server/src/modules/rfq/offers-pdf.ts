import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const VAT_RATE = 0.14;

export interface OffersPdfOptions {
  rfqNo: string;
  customerRfqNo: string;
  exportDate: string;
  employeeName?: string | null;
  closeDate?: string | null;
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
      notes?: string | null;
      deviation: number;
      isLowest: boolean;
      isAnomaly: boolean;
      notPriced?: boolean;
    }>;
  }>;
  supplierSummaries?: Array<{
    supplierName: string;
    generalNotes?: string | null;
    attachments?: Array<{ fileName: string; mimeType?: string; content?: string }>;
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
      const HEADER_H = 72;
      doc.rect(MARGIN, MARGIN, CONTENT_W, HEADER_H).fill(BLUE);

      try {
        doc.image(getLogoBuffer(), MARGIN + CONTENT_W - 68, MARGIN + 6, { height: 58 });
      } catch {
        /* skip */
      }

      doc
        .font(FONT)
        .fontSize(15)
        .fillColor(GOLD)
        .text(
          "\u0642\u0631\u0637\u0628\u0629 \u0644\u0644\u062a\u0648\u0631\u064a\u062f\u0627\u062a",
          MARGIN + 14,
          MARGIN + 8,
          { lineBreak: false },
        );
      doc
        .font(FONT)
        .fontSize(9)
        .fillColor("#aaccee")
        .text("Cortoba Supplies", MARGIN + 14, MARGIN + 30, { lineBreak: false });
      doc
        .font(FONT)
        .fontSize(11)
        .fillColor("#ffffff")
        .text("RFQ PRICE COMPARISON REPORT", MARGIN + 14, MARGIN + 48, { lineBreak: false });
      doc
        .font(FONT)
        .fontSize(8)
        .fillColor(GOLD)
        .text(
          "\u062a\u0642\u0631\u064a\u0631 \u0645\u0642\u0627\u0631\u0646\u0629 \u0639\u0631\u0648\u0636 \u0627\u0644\u0623\u0633\u0639\u0627\u0631",
          MARGIN + 14,
          MARGIN + 62,
          { lineBreak: false },
        );

      // ── INFO BAND ─────────────────────────────────────────────────────────
      const infoY = MARGIN + HEADER_H + 4;
      doc.rect(MARGIN, infoY, CONTENT_W, 42).fill(GREY);
      doc.rect(MARGIN, infoY + 40, CONTENT_W, 2).fill(GOLD);

      const infoCells: Array<{ label: string; labelAr: string; value: string }> = [
        {
          label: "Internal RFQ",
          labelAr:
            "\u0631\u0642\u0645 \u0627\u0644\u0637\u0644\u0628 \u0627\u0644\u062f\u0627\u062e\u0644\u064a",
          value: opts.rfqNo,
        },
        {
          label: "Customer RFQ",
          labelAr: "\u0631\u0642\u0645 \u0637\u0644\u0628 \u0627\u0644\u0639\u0645\u064a\u0644",
          value: opts.customerRfqNo,
        },
        {
          label: "Prepared By",
          labelAr: "\u0623\u0639\u062f\u0647",
          value: opts.employeeName || "—",
        },
        {
          label: "Close Date",
          labelAr: "\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0625\u063a\u0644\u0627\u0642",
          value: opts.closeDate || "—",
        },
        {
          label: "Export Date",
          labelAr: "\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062a\u0635\u062f\u064a\u0631",
          value: opts.exportDate,
        },
        {
          label: "Items",
          labelAr: "\u0639\u062f\u062f \u0627\u0644\u0628\u0646\u0648\u062f",
          value: String(opts.itemAnalysis.length),
        },
        {
          label: "VAT Rate",
          labelAr: "\u0646\u0633\u0628\u0629 \u0636 \u0642 \u0645",
          value: "14%",
        },
      ];

      const cellW = CONTENT_W / infoCells.length;
      infoCells.forEach((c, i) => {
        const cx = MARGIN + i * cellW;
        doc
          .font(FONT)
          .fontSize(6)
          .fillColor("#8899aa")
          .text(c.labelAr, cx + 2, infoY + 4, {
            width: cellW - 4,
            align: "center",
            lineBreak: false,
          });
        doc
          .font(FONT)
          .fontSize(5.5)
          .fillColor("#aaaaaa")
          .text(c.label, cx + 2, infoY + 14, {
            width: cellW - 4,
            align: "center",
            lineBreak: false,
          });
        doc
          .font(FONT_BOLD)
          .fontSize(9)
          .fillColor(BLUE)
          .text(c.value, cx + 2, infoY + 24, {
            width: cellW - 4,
            align: "center",
            lineBreak: false,
          });
      });

      // ── VAT NOTE ──────────────────────────────────────────────────────────
      const noteY = infoY + 48;
      doc
        .font(FONT)
        .fontSize(7)
        .fillColor("#555555")
        .text(
          '(*) \u0627\u0644\u0623\u0633\u0639\u0627\u0631 \u0641\u064a \u0639\u0645\u0648\u062f "\u0634\u0627\u0645\u0644\u0627\u064b \u0636.q.\u0645" \u062a\u0634\u0645\u0644 14% \u0625\u0630\u0627 \u0644\u0645 \u062a\u0643\u0646 \u0645\u062f\u0631\u062c\u0629 \u0623\u0635\u0644\u0627\u064b \u2014 Prices in "Incl. VAT" column = original \u00d7 1.14 when tax excluded, or as-is when included.',
          MARGIN,
          noteY,
          { width: CONTENT_W, lineBreak: false },
        );

      // ── TABLE ─────────────────────────────────────────────────────────────
      let y = noteY + 16;

      const allSuppliers = Array.from(
        new Set(opts.itemAnalysis.flatMap((ia) => ia.offers.map((o) => o.supplierName))),
      );

      const mainCols = [
        { label: "#", w: 26 },
        { label: "Description / \u0627\u0644\u0628\u064a\u0627\u0646", w: 160 },
        { label: "Part No", w: 82 },
        { label: "QTY / \u0627\u0644\u0643\u0645\u064a\u0629", w: 54 },
      ];
      const SUMMARY_W = 148;
      const mainW = mainCols.reduce((s, c) => s + c.w, 0);
      const remaining = CONTENT_W - mainW - SUMMARY_W;
      const supGroupW =
        allSuppliers.length > 0 ? Math.max(90, Math.floor(remaining / allSuppliers.length)) : 90;
      const supColW = Math.floor(supGroupW / 2);

      const totalTableW = mainW + supGroupW * allSuppliers.length + SUMMARY_W;
      const tableX = MARGIN + Math.max(0, (CONTENT_W - totalTableW) / 2);
      const ROW_H = 22;
      const NOTES_ROW_H = 14;
      const PAGE_H = doc.page.height;

      const addContinuationPage = (): number => {
        doc.addPage({
          size: "A4",
          layout: "landscape",
          margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        });
        doc.rect(MARGIN, MARGIN, CONTENT_W, 22).fill(BLUE);
        doc
          .font(FONT_BOLD)
          .fontSize(9)
          .fillColor(GOLD)
          .text(`\u062a\u0627\u0628\u0639 - ${opts.rfqNo}`, MARGIN + 8, MARGIN + 6, {
            lineBreak: false,
          });
        return MARGIN + 28;
      };

      const drawHeader = (hy: number): number => {
        doc.rect(tableX, hy, totalTableW, ROW_H).fill(BLUE);

        let cx = tableX;
        mainCols.forEach((col) => {
          doc
            .font(FONT_BOLD)
            .fontSize(7)
            .fillColor("#ffffff")
            .text(col.label, cx + 2, hy + 7, {
              width: col.w - 4,
              align: "center",
              lineBreak: false,
            });
          cx += col.w;
        });

        allSuppliers.forEach((s) => {
          doc
            .font(FONT_BOLD)
            .fontSize(7)
            .fillColor("#ffffff")
            .text(s, cx + 2, hy + 7, { width: supGroupW - 4, align: "center", lineBreak: false });
          cx += supGroupW;
        });

        doc
          .font(FONT_BOLD)
          .fontSize(7)
          .fillColor("#ffffff")
          .text("\u0645\u0644\u062e\u0635 / Summary (Incl. VAT)", cx + 2, hy + 7, {
            width: SUMMARY_W - 4,
            align: "center",
            lineBreak: false,
          });

        const subY = hy + ROW_H;
        doc.rect(tableX, subY, totalTableW, 16).fill("#2a4a6c");

        cx = tableX;
        mainCols.forEach((col) => {
          doc.rect(cx, subY, col.w, 16).stroke(BORDER);
          cx += col.w;
        });
        allSuppliers.forEach(() => {
          doc
            .font(FONT)
            .fontSize(6.5)
            .fillColor(GOLD)
            .text(
              "\u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0623\u0635\u0644\u064a",
              cx + 2,
              subY + 4,
              { width: supColW - 4, align: "center", lineBreak: false },
            );
          cx += supColW;
          doc
            .font(FONT)
            .fontSize(6.5)
            .fillColor(GOLD)
            .text("\u0634\u0627\u0645\u0644 \u0636.q.\u0645 *", cx + 2, subY + 4, {
              width: supColW - 4,
              align: "center",
              lineBreak: false,
            });
          cx += supColW;
        });
        doc.rect(cx, subY, SUMMARY_W, 16).stroke(BORDER);

        return subY + 16;
      };

      y = drawHeader(y);

      opts.itemAnalysis.forEach((item, idx) => {
        // ── check space for item row + potential notes row ────────────────
        if (y + ROW_H > PAGE_H - MARGIN - 20) {
          y = addContinuationPage();
          y = drawHeader(y);
        }

        const rowBg = idx % 2 === 0 ? "#ffffff" : GREY;
        doc.rect(tableX, y, totalTableW, ROW_H).fill(rowBg);

        let cx = tableX;
        mainCols.forEach((col) => {
          doc.rect(cx, y, col.w, ROW_H).stroke(BORDER);
          cx += col.w;
        });
        allSuppliers.forEach(() => {
          doc.rect(cx, y, supGroupW, ROW_H).stroke(BORDER);
          cx += supGroupW;
        });
        doc.rect(cx, y, SUMMARY_W, ROW_H).stroke(BORDER);

        cx = tableX;
        const textY = y + 7;

        doc
          .font(FONT)
          .fontSize(7.5)
          .fillColor("#555")
          .text(String(idx + 1), cx + 2, textY, {
            width: mainCols[0].w - 4,
            align: "center",
            lineBreak: false,
          });
        cx += mainCols[0].w;

        doc
          .font(FONT)
          .fontSize(7.5)
          .fillColor("#1a1a1a")
          .text(item.description, cx + 3, textY, { width: mainCols[1].w - 6, lineBreak: false });
        cx += mainCols[1].w;

        doc
          .font(FONT)
          .fontSize(7)
          .fillColor("#555")
          .text(item.partNo ?? "—", cx + 2, textY, {
            width: mainCols[2].w - 4,
            align: "center",
            lineBreak: false,
          });
        cx += mainCols[2].w;

        doc
          .font(FONT)
          .fontSize(7.5)
          .fillColor("#333")
          .text(item.qty != null ? `${item.qty} ${item.uom ?? ""}`.trim() : "—", cx + 2, textY, {
            width: mainCols[3].w - 4,
            align: "center",
            lineBreak: false,
          });
        cx += mainCols[3].w;

        const bySupplier: Record<
          string,
          {
            price: number;
            priceWithVat: number;
            isLowest: boolean;
            isAnomaly: boolean;
            notes?: string | null;
            deliveryDays?: number | null;
          }
        > = {};
        for (const o of item.offers) {
          bySupplier[o.supplierName] = {
            price: o.price,
            priceWithVat: o.priceWithVat,
            isLowest: o.isLowest,
            isAnomaly: o.isAnomaly,
            notes: o.notes,
            deliveryDays: o.deliveryDays,
          };
        }

        allSuppliers.forEach((s) => {
          const p = bySupplier[s];
          if (!p) {
            doc
              .font(FONT)
              .fontSize(7.5)
              .fillColor("#aaa")
              .text("—", cx + 2, textY, { width: supColW - 4, align: "center", lineBreak: false });
            cx += supColW;
            doc
              .font(FONT)
              .fontSize(7.5)
              .fillColor("#aaa")
              .text("—", cx + 2, textY, { width: supColW - 4, align: "center", lineBreak: false });
            cx += supColW;
          } else {
            const priceColor = p.isLowest ? GREEN : p.isAnomaly ? AMBER : "#333";
            doc
              .font(FONT)
              .fontSize(7.5)
              .fillColor("#555")
              .text(fmt(p.price), cx + 2, textY, {
                width: supColW - 4,
                align: "right",
                lineBreak: false,
              });
            cx += supColW;
            doc
              .font(FONT_BOLD)
              .fontSize(7.5)
              .fillColor(priceColor)
              .text(fmt(p.priceWithVat) + (p.isLowest ? " \u2713" : ""), cx + 2, textY, {
                width: supColW - 4,
                align: "right",
                lineBreak: false,
              });
            cx += supColW;
          }
        });

        const summaryText =
          item.minPrice != null
            ? `\u0623\u0642\u0644: ${fmt(item.minPrice)}\n\u0645\u062a\u0648\u0633\u0637: ${fmt(item.avgPrice!)}\n\u0623\u0639\u0644\u0649: ${fmt(item.maxPrice!)}`
            : "\u0644\u0627 \u062a\u0648\u062c\u062f \u0639\u0631\u0648\u0636";
        doc
          .font(FONT)
          .fontSize(6.5)
          .fillColor("#444")
          .text(summaryText, cx + 2, y + 3, {
            width: SUMMARY_W - 6,
            align: "center",
            lineBreak: true,
          });

        y += ROW_H;

        // ── ITEM DETAILS ROW (delivery days + notes) ─────────────────────
        const DETAILS_ROW_H = 20;
        const itemHasDetails = allSuppliers.some(
          (s) => bySupplier[s]?.notes || bySupplier[s]?.deliveryDays != null,
        );
        if (itemHasDetails) {
          if (y + DETAILS_ROW_H > PAGE_H - MARGIN - 20) {
            y = addContinuationPage();
            y = drawHeader(y);
          }
          doc.rect(tableX, y, totalTableW, DETAILS_ROW_H).fill("#fef3c7");
          doc.rect(tableX, y, totalTableW, DETAILS_ROW_H).stroke("#fcd34d");

          // Label column
          doc
            .font(FONT_BOLD)
            .fontSize(7)
            .fillColor("#92400e")
            .text(
              "مدة / ملاحظات",
              tableX + 2,
              y + 5,
              { width: mainW - 4, align: "center", lineBreak: false },
            );

          let nx = tableX + mainW;
          allSuppliers.forEach((s) => {
            const entry = bySupplier[s];
            const parts: string[] = [];
            if (entry?.deliveryDays != null) {
              parts.push("مدة: " + entry.deliveryDays + " يوم");
            }
            if (entry?.notes) {
              parts.push(entry.notes);
            }
            if (parts.length > 0) {
              doc
                .font(FONT)
                .fontSize(7.5)
                .fillColor("#78350f")
                .text(parts.join(" | "), nx + 3, y + 5, {
                  width: supGroupW - 6,
                  lineBreak: false,
                  ellipsis: true,
                });
            }
            nx += supGroupW;
          });

          y += DETAILS_ROW_H;
        }
      });
      // ── GENERAL NOTES & ATTACHMENTS SECTION ───────────────────────────────
      const hasGeneralNotes = opts.supplierSummaries?.some((s) => s.generalNotes);
      const hasAttachments = opts.supplierSummaries?.some((s) => s.attachments?.length);

      if (hasGeneralNotes || hasAttachments) {
        // Start a new page for notes/attachments
        doc.addPage({
          size: "A4",
          layout: "landscape",
          margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        });
        let sy = MARGIN;

        // Section header bar
        doc.rect(MARGIN, sy, CONTENT_W, 28).fill(BLUE);
        doc
          .font(FONT_BOLD)
          .fontSize(12)
          .fillColor(GOLD)
          .text(
            "\u0645\u0644\u0627\u062d\u0638\u0627\u062a \u0648\u0645\u0631\u0641\u0642\u0627\u062a \u0627\u0644\u0645\u0648\u0631\u062f\u064a\u0646",
            MARGIN + 12,
            sy + 6,
            { lineBreak: false },
          );
        doc
          .font(FONT)
          .fontSize(8)
          .fillColor("#aaccee")
          .text("Supplier Notes & Attachments", MARGIN + 12, sy + 19, { lineBreak: false });
        // RFQ reference on right
        doc
          .font(FONT)
          .fontSize(8)
          .fillColor("#ffffff")
          .text(opts.rfqNo, MARGIN + CONTENT_W - 120, sy + 10, {
            width: 110,
            align: "right",
            lineBreak: false,
          });
        sy += 36;

        // ── General Notes ──────────────────────────────────────────────────
        if (hasGeneralNotes) {
          // Sub-header
          doc.rect(MARGIN, sy, CONTENT_W, 18).fill("#e8f0f8");
          doc.rect(MARGIN, sy, 4, 18).fill(BLUE);
          doc
            .font(FONT_BOLD)
            .fontSize(9)
            .fillColor(BLUE)
            .text(
              "\u0627\u0644\u0645\u0644\u0627\u062d\u0638\u0627\u062a \u0627\u0644\u0639\u0627\u0645\u0629 \u0644\u0643\u0644 \u0645\u0648\u0631\u062f  |  General Notes per Supplier",
              MARGIN + 10,
              sy + 4,
              { lineBreak: false },
            );
          sy += 22;

          for (const s of opts.supplierSummaries ?? []) {
            if (!s.generalNotes) continue;
            if (sy + 20 > PAGE_H - MARGIN - 10) {
              doc.addPage({
                size: "A4",
                layout: "landscape",
                margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
              });
              sy = MARGIN;
            }
            // Supplier name column
            doc.rect(MARGIN, sy, 160, 18).fill("#dce8f5");
            doc
              .font(FONT_BOLD)
              .fontSize(8)
              .fillColor(BLUE)
              .text(s.supplierName, MARGIN + 6, sy + 4, {
                width: 148,
                lineBreak: false,
                ellipsis: true,
              });
            // Notes column
            doc.rect(MARGIN + 160, sy, CONTENT_W - 160, 18).fill("#fafcff");
            doc.rect(MARGIN, sy, CONTENT_W, 18).stroke(BORDER);
            doc
              .font(FONT)
              .fontSize(8)
              .fillColor("#1a1a1a")
              .text(s.generalNotes, MARGIN + 168, sy + 4, {
                width: CONTENT_W - 176,
                lineBreak: false,
                ellipsis: true,
              });
            sy += 18;
          }
          sy += 12;
        }

        // ── Attachments — each attachment gets its own full page ──────────
        if (hasAttachments) {
          const IMAGE_MIMES = new Set([
            "image/png", "image/jpeg", "image/jpg",
            "image/gif", "image/webp", "image/bmp",
          ]);

          for (const s of opts.supplierSummaries ?? []) {
            if (!s.attachments?.length) continue;
            for (const att of s.attachments) {
              // Every attachment gets a dedicated landscape A4 page
              doc.addPage({
                size: "A4",
                layout: "landscape",
                margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
              });

              // ── Page header bar ──────────────────────────────────────
              doc.rect(MARGIN, MARGIN, CONTENT_W, 28).fill(BLUE);
              doc
                .font(FONT_BOLD)
                .fontSize(11)
                .fillColor(GOLD)
                .text(
                  "\u0645\u0631\u0641\u0642\u0627\u062a \u0627\u0644\u0645\u0648\u0631\u062f\u064a\u0646  |  Supplier Attachments",
                  MARGIN + 12,
                  MARGIN + 6,
                  { lineBreak: false },
                );
              doc
                .font(FONT)
                .fontSize(8)
                .fillColor("#ffffff")
                .text(opts.rfqNo, MARGIN + CONTENT_W - 120, MARGIN + 10, {
                  width: 110,
                  align: "right",
                  lineBreak: false,
                });

              // ── Supplier + filename info strip ───────────────────────
              const stripY = MARGIN + 34;
              doc.rect(MARGIN, stripY, CONTENT_W, 22).fill("#e8f0f8");
              doc.rect(MARGIN, stripY, 4, 22).fill(GOLD);

              doc
                .font(FONT_BOLD)
                .fontSize(8)
                .fillColor(BLUE)
                .text(s.supplierName, MARGIN + 10, stripY + 4, {
                  width: 200,
                  lineBreak: false,
                  ellipsis: true,
                });
              doc
                .font(FONT)
                .fontSize(7.5)
                .fillColor("#555")
                .text("\uD83D\uDCCE " + att.fileName, MARGIN + 220, stripY + 6, {
                  width: CONTENT_W - 224,
                  lineBreak: false,
                  ellipsis: true,
                });

              // ── Image area ──────────────────────────────────────────
              const imgAreaY = stripY + 28;
              const imgAreaH = doc.page.height - imgAreaY - MARGIN - 10;
              const imgAreaW = CONTENT_W;

              const isImage = IMAGE_MIMES.has((att.mimeType ?? "").toLowerCase());
              if (isImage && att.content) {
                try {
                  const imgBuf = Buffer.from(att.content, "base64");
                  // Fit the image inside the available area while keeping aspect ratio
                  doc.image(imgBuf, MARGIN, imgAreaY, {
                    width: imgAreaW,
                    height: imgAreaH,
                    fit: [imgAreaW, imgAreaH],
                    align: "center",
                    valign: "top",
                  });
                } catch {
                  // If the image can't be decoded, fall back to a text placeholder
                  doc
                    .font(FONT)
                    .fontSize(10)
                    .fillColor("#888")
                    .text(
                      "\u2022 \u062a\u0639\u0630\u0651\u0631 \u0639\u0631\u0636 \u0627\u0644\u0635\u0648\u0631\u0629 | Could not render image",
                      MARGIN,
                      imgAreaY + imgAreaH / 2,
                      { width: imgAreaW, align: "center", lineBreak: false },
                    );
                }
              } else {
                // Non-image file (PDF, Excel, Word…) — show descriptive placeholder
                doc.rect(MARGIN, imgAreaY, imgAreaW, imgAreaH).fill("#f9fafb").stroke(BORDER);
                doc
                  .font(FONT_BOLD)
                  .fontSize(36)
                  .fillColor("#d0dbe8")
                  .text("\uD83D\uDCC4", MARGIN, imgAreaY + imgAreaH / 2 - 50, {
                    width: imgAreaW,
                    align: "center",
                    lineBreak: false,
                  });
                doc
                  .font(FONT)
                  .fontSize(11)
                  .fillColor("#666")
                  .text(att.fileName, MARGIN, imgAreaY + imgAreaH / 2 + 10, {
                    width: imgAreaW,
                    align: "center",
                    lineBreak: false,
                    ellipsis: true,
                  });
                doc
                  .font(FONT)
                  .fontSize(8)
                  .fillColor("#999")
                  .text(
                    "\u0647\u0630\u0627 \u0627\u0644\u0645\u0644\u0641 \u0644\u0627 \u064a\u0645\u0643\u0646 \u0639\u0631\u0636\u0647 \u0645\u0628\u0627\u0634\u0631\u0629\u064b \u0641\u064a PDF \u2014 This file type cannot be embedded in PDF",
                    MARGIN,
                    imgAreaY + imgAreaH / 2 + 30,
                    { width: imgAreaW, align: "center", lineBreak: false },
                  );
              }
            }
          }
        }
      }

      // ── FOOTER (last page) ────────────────────────────────────────────────
      const footerY = doc.page.height - MARGIN + 4;
      doc.rect(MARGIN, footerY - 6, CONTENT_W, 22).fill(BLUE);
      doc
        .font(FONT)
        .fontSize(7.5)
        .fillColor(GOLD)
        .text(
          `\u0642\u0631\u0637\u0628\u0629 \u0644\u0644\u062a\u0648\u0631\u064a\u062f\u0627\u062a | INFO@CORTOBA-SUPPLIES.COM | ${opts.exportDate}${opts.closeDate ? " | \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0625\u063a\u0644\u0627\u0642: " + opts.closeDate : ""} | \u062c\u0645\u064a\u0639 \u0627\u0644\u0642\u064a\u0645 \u0628\u0627\u0644\u062c\u0646\u064a\u0647 \u0627\u0644\u0645\u0635\u0631\u064a | \u0636.q.\u0645 14%`,
          MARGIN + 4,
          footerY + 2,
          { width: CONTENT_W - 8, align: "center", lineBreak: false },
        );

      doc.end();
    } catch (err) {
      settle(() => reject(err));
    }
  });
}

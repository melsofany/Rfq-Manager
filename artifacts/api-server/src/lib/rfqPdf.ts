import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

// When built (runs from dist/index.mjs):
//   ../src/assets/fonts → artifacts/api-server/src/assets/fonts  ✓ (dev + build)
//   assets/fonts        → artifacts/api-server/dist/assets/fonts  ✓ (after build copies fonts)
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_PATHS = [
  path.resolve(BASE_DIR, "../src/assets/fonts/Amiri-Regular.ttf"),
  path.resolve(BASE_DIR, "assets/fonts/Amiri-Regular.ttf"),
];

function resolveFontPath(): string {
  for (const p of CANDIDATE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Amiri font not found. Checked:\n  ${CANDIDATE_PATHS.join("\n  ")}`);
}

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

export function generateRfqPdf(opts: RfqPdfOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const fontPath = resolveFontPath();

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 40, bottom: 50, left: 40, right: 40 },
      info: {
        Title: `RFQ ${opts.rfqNo}`,
        Author: "Cortoba Supplies",
        Subject: `Request for Quotation — ${opts.customerRfqNo}`,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.registerFont("Amiri", fontPath);

    const W = 515;
    const PRIMARY = "#1a3a5c";
    const ACCENT = "#c8a84b";
    const LIGHT_GRAY = "#f7f7f7";
    const MED_GRAY = "#dddddd";
    const DARK_TEXT = "#1a1a1a";
    const MID_TEXT = "#666666";

    // ─── HEADER ──────────────────────────────────────────────────────────
    doc.rect(40, 40, W, 68).fill(PRIMARY);

    doc.font("Amiri").fontSize(22).fillColor("#ffffff");
    doc.text("قرطبة للتوريدات", 40, 52, { width: W, align: "right", rtl: true });

    doc.font("Amiri").fontSize(10).fillColor(ACCENT);
    doc.text("CORTOBA SUPPLIES", 40, 78, { width: W, align: "right" });

    doc.font("Amiri").fontSize(15).fillColor("#ffffff");
    doc.text("طلب عرض سعر", 40, 52, { width: W / 2, align: "left", rtl: true });

    doc.font("Amiri").fontSize(9).fillColor(ACCENT);
    doc.text("REQUEST FOR QUOTATION", 40, 78, { width: W / 2, align: "left" });

    let y = 122;

    // ─── INFO BAND ────────────────────────────────────────────────────────
    doc.rect(40, y, W, 52).fill(LIGHT_GRAY).stroke(MED_GRAY);

    const infoCols = W / 4;
    const infoItems = [
      { label: "رقم الطلب الداخلي", value: opts.rfqNo },
      { label: "رقم RFQ العميل", value: opts.customerRfqNo },
      { label: "تاريخ الإصدار", value: opts.rfqDate ? formatDate(opts.rfqDate) : formatDate(new Date().toISOString()) },
      { label: "آخر موعد للتقديم", value: formatDate(opts.closeDate) },
    ];

    infoItems.forEach((item, i) => {
      const x = 40 + i * infoCols;
      doc.font("Amiri").fontSize(7).fillColor(MID_TEXT);
      doc.text(item.label, x, y + 8, { width: infoCols - 4, align: "center", rtl: true });
      doc.font("Amiri").fontSize(10).fillColor(DARK_TEXT);
      doc.text(item.value, x, y + 22, { width: infoCols - 4, align: "center" });
    });

    y += 62;

    // ─── TO / SUPPLIER ───────────────────────────────────────────────────
    doc.font("Amiri").fontSize(9).fillColor(MID_TEXT);
    doc.text("إلى المورّد:", 40, y, { width: W, align: "right", rtl: true });
    y += 14;

    doc.font("Amiri").fontSize(13).fillColor(DARK_TEXT);
    const supplierLine = opts.contactPerson
      ? `${opts.supplierName}  —  ${opts.contactPerson}`
      : opts.supplierName;
    doc.text(supplierLine, 40, y, { width: W, align: "right", rtl: true });
    y += 22;

    doc.font("Amiri").fontSize(9.5).fillColor(MID_TEXT);
    doc.text(
      "يسرنا الاستفسار عن أسعار الأصناف التالية، ونرجو التفضل بتزويدنا بأفضل عروض الأسعار قبل التاريخ المحدد أعلاه.",
      40, y,
      { width: W, align: "right", rtl: true, lineGap: 2 }
    );
    y += 30;

    // ─── ITEMS TABLE ─────────────────────────────────────────────────────
    const colNo = 28;
    const colUom = 48;
    const colQty = 55;
    const colPart = 90;
    const colDesc = W - colNo - colUom - colQty - colPart;

    doc.rect(40, y, W, 22).fill(PRIMARY);
    doc.font("Amiri").fontSize(9).fillColor("#ffffff");

    const drawHeaderCell = (text: string, x: number, w: number, rtl = false) => {
      doc.text(text, x, y + 7, { width: w, align: "center", rtl });
    };

    drawHeaderCell("#", 40, colNo);
    drawHeaderCell("رقم القطعة", 40 + colNo, colPart, true);
    drawHeaderCell("الوصف", 40 + colNo + colPart, colDesc, true);
    drawHeaderCell("الكمية", 40 + colNo + colPart + colDesc, colQty, true);
    drawHeaderCell("الوحدة", 40 + colNo + colPart + colDesc + colQty, colUom, true);

    y += 22;

    opts.items.forEach((item, idx) => {
      const rowH = 22;
      const bg = idx % 2 === 0 ? "#ffffff" : LIGHT_GRAY;
      doc.rect(40, y, W, rowH).fill(bg).stroke(MED_GRAY);

      doc.font("Amiri").fontSize(9).fillColor(DARK_TEXT);

      doc.text(String(idx + 1), 40, y + 7, { width: colNo, align: "center" });
      doc.text(item.partNo || "—", 40 + colNo, y + 7, { width: colPart, align: "center" });

      const descX = 40 + colNo + colPart;
      doc.text(item.description, descX, y + 7, {
        width: colDesc - 4,
        align: "right",
        rtl: true,
        ellipsis: true,
      });

      const qtyVal = item.qty ? String(item.qty) : "—";
      doc.text(qtyVal, descX + colDesc, y + 7, { width: colQty, align: "center" });
      doc.text(item.uom || "—", descX + colDesc + colQty, y + 7, { width: colUom, align: "center" });

      y += rowH;

      if (y > 720) {
        doc.addPage();
        y = 60;
      }
    });

    y += 14;

    // ─── PRICING LINK ────────────────────────────────────────────────────
    doc.rect(40, y, W, 48).fill("#eef4fb").stroke("#b3d1f0");
    y += 8;

    doc.font("Amiri").fontSize(10).fillColor(PRIMARY);
    doc.text("رابط تقديم عرض السعر — يرجى الضغط على الرابط أو نسخه في المتصفح:", 40, y, {
      width: W,
      align: "right",
      rtl: true,
    });
    y += 16;

    doc.font("Amiri").fontSize(9).fillColor("#1a5fb4");
    doc.text(opts.pricingUrl, 40, y, {
      width: W,
      align: "center",
      link: opts.pricingUrl,
      underline: true,
    });
    y += 32;

    // ─── NOTES ────────────────────────────────────────────────────────────
    if (opts.notes?.trim()) {
      doc.rect(40, y, W, 1).fill(MED_GRAY);
      y += 8;
      doc.font("Amiri").fontSize(9).fillColor(MID_TEXT);
      doc.text("ملاحظات:", 40, y, { width: W, align: "right", rtl: true });
      y += 13;
      doc.font("Amiri").fontSize(9).fillColor(DARK_TEXT);
      doc.text(opts.notes.trim(), 40, y, { width: W, align: "right", rtl: true, lineGap: 2 });
      y += 25;
    }

    // ─── FOOTER ───────────────────────────────────────────────────────────
    doc.rect(40, 778, W, 1).fill(ACCENT);
    doc.font("Amiri").fontSize(8).fillColor(MID_TEXT);
    const footerParts = [
      opts.employeeName,
      opts.employeePhone,
      "INFO@CORTOBA-SUPPLIES.COM",
    ]
      .filter(Boolean)
      .join("   |   ");
    doc.text(footerParts, 40, 783, { width: W, align: "center" });

    doc.end();
  });
}

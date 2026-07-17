import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const VAT_RATE = 0.14; // Egyptian standard VAT 14%

export interface PoPdfOptions {
  poNo: string;
  poDate?: string | null;
  supplierName: string;
  contactPerson?: string | null;
  receiverName?: string | null;
  receiverPhone?: string | null;
  employeeName: string;
  employeePhone?: string | null;
  notes?: string | null;
  items: Array<{
    lineItem?: string | null;
    partNo?: string | null;
    description: string;
    qty?: string | number | null;
    uom?: string | null;
    unitPrice?: string | number | null;
    taxIncluded?: boolean;
  }>;
}

// ─── RTL helper ─────────────────────────────────────────────────────────────
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function rtl(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (!ARABIC_RE.test(trimmed)) return trimmed;
  const words = trimmed.split(/\s+/);
  if (words.length <= 1) return trimmed;
  return words.reverse().join(" ");
}

function formatDate(d?: string | null): string {
  try {
    const dt = new Date(d ?? new Date().toISOString());
    if (isNaN(dt.getTime())) return d ?? "";
    const dd = String(dt.getDate()).padStart(2, "0");
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${dt.getFullYear()}`;
  } catch {
    return d ?? "";
  }
}

function fmt(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const s = String(v).trim();
  if (!s) return "—";
  if (/^-?\d+(\.\d+)?$/.test(s)) return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return s;
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getFontPath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return resolve(dir, "assets/fonts/Amiri-Regular.ttf");
}

function getLogoPath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return resolve(dir, "assets/logo.png");
}

export function generatePoPdf(opts: PoPdfOptions): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    try {
      const fontPath = getFontPath();
      const logoPath = getLogoPath();
      const hasLogo = existsSync(logoPath);

      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        autoFirstPage: true,
        compress: false,
      });

      const chunks: Buffer[] = [];
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => settle(() => resolvePromise(Buffer.concat(chunks))));
      doc.on("error", (e: Error) => settle(() => reject(e)));

      doc.registerFont("Amiri", fontPath);

      const PAGE_W = doc.page.width;
      const M = 28;
      const CW = PAGE_W - M * 2;
      const BLUE = "#1a3a5c";
      const GOLD = "#c8a84b";
      const LGREY = "#eef2f7";

      const poDate = formatDate(opts.poDate);

      // ════════════════════════════════════════════════════════════════
      // HEADER
      // ════════════════════════════════════════════════════════════════
      const HDR_H = 88;
      doc.rect(0, 0, PAGE_W, HDR_H).fill(BLUE);
      doc.rect(0, HDR_H - 3, PAGE_W, 3).fill(GOLD);

      const TITLE_X = PAGE_W / 2;
      const TITLE_W = PAGE_W / 2 - M;

      doc
        .font("Amiri")
        .fontSize(24)
        .fillColor("#ffffff")
        .text(rtl("أمر شراء"), TITLE_X, 14, { width: TITLE_W, align: "right", lineBreak: false });
      doc
        .font("Amiri")
        .fontSize(9)
        .fillColor(GOLD)
        .text("PURCHASE ORDER", TITLE_X, 48, { width: TITLE_W, align: "right", lineBreak: false });
      doc
        .font("Amiri")
        .fontSize(8)
        .fillColor("#aaccee")
        .text(`رقم: ${opts.poNo}`, TITLE_X, 63, {
          width: TITLE_W,
          align: "right",
          lineBreak: false,
        });

      const LOGO_SIZE = 52;
      const LOGO_X = M;
      const LOGO_Y = (HDR_H - LOGO_SIZE) / 2;
      const CO_TEXT_X = M + LOGO_SIZE + 8;
      const CO_TEXT_W = PAGE_W / 2 - LOGO_SIZE - M - 16;

      if (hasLogo) {
        doc.image(logoPath, LOGO_X, LOGO_Y, {
          width: LOGO_SIZE,
          height: LOGO_SIZE,
          fit: [LOGO_SIZE, LOGO_SIZE],
        });
      } else {
        doc.roundedRect(LOGO_X, LOGO_Y, LOGO_SIZE, LOGO_SIZE, 6).fill(GOLD);
        doc
          .font("Amiri")
          .fontSize(22)
          .fillColor(BLUE)
          .text("ق", LOGO_X, LOGO_Y + LOGO_SIZE / 2 - 14, {
            width: LOGO_SIZE,
            align: "center",
            lineBreak: false,
          });
      }

      doc
        .font("Amiri")
        .fontSize(11)
        .fillColor(GOLD)
        .text(rtl("قرطبة للتوريدات"), CO_TEXT_X, 12, {
          width: CO_TEXT_W,
          align: "left",
          lineBreak: false,
        });
      doc
        .font("Amiri")
        .fontSize(8)
        .fillColor("#c0d8f0")
        .text("CORTOBA SUPPLIES", CO_TEXT_X, 30, {
          width: CO_TEXT_W,
          align: "left",
          lineBreak: false,
        });
      doc
        .font("Amiri")
        .fontSize(7)
        .fillColor("#8aaec8")
        .text(rtl("ش.الإسكندرية - برج نجمة مطروح، الدور الرابع"), CO_TEXT_X, 46, {
          width: CO_TEXT_W,
          align: "left",
          lineBreak: false,
        });
      doc
        .font("Amiri")
        .fontSize(7)
        .fillColor("#8aaec8")
        .text(rtl("مرسي مطروح  |  ت: 432-972-587"), CO_TEXT_X, 59, {
          width: CO_TEXT_W,
          align: "left",
          lineBreak: false,
        });
      doc
        .font("Amiri")
        .fontSize(7)
        .fillColor("#8aaec8")
        .text("INFO@CORTOBA-SUPPLIES.COM", CO_TEXT_X, 72, {
          width: CO_TEXT_W,
          align: "left",
          lineBreak: false,
        });

      // ════════════════════════════════════════════════════════════════
      // INFO BAND
      // ════════════════════════════════════════════════════════════════
      const IY = HDR_H;
      const IH = 50;
      doc.rect(0, IY, PAGE_W, IH).fill(LGREY);

      const infoCells = [
        { label: rtl("رقم أمر الشراء"), value: opts.poNo },
        { label: rtl("تاريخ الإصدار"), value: poDate },
      ];
      const cellW = CW / infoCells.length;

      infoCells.forEach((cell, i) => {
        const cx = M + (infoCells.length - 1 - i) * cellW;
        doc
          .font("Amiri")
          .fontSize(7.5)
          .fillColor("#7a90a8")
          .text(cell.label, cx, IY + 7, { width: cellW, align: "center", lineBreak: false });
        doc
          .font("Amiri")
          .fontSize(12)
          .fillColor(BLUE)
          .text(cell.value, cx, IY + 24, { width: cellW, align: "center", lineBreak: false });
      });

      // ════════════════════════════════════════════════════════════════
      // BODY
      // ════════════════════════════════════════════════════════════════
      let y = IY + IH + 12;

      const supplierLine = opts.contactPerson
        ? `${opts.supplierName} — ${opts.contactPerson}`
        : opts.supplierName;

      doc
        .font("Amiri")
        .fontSize(8.5)
        .fillColor("#8899aa")
        .text(rtl("إلى المورّد:"), M, y, { width: CW, align: "right", lineBreak: false });
      y += 15;

      doc
        .font("Amiri")
        .fontSize(14)
        .fillColor(BLUE)
        .text(rtl(supplierLine), M, y, { width: CW, align: "right", lineBreak: false });
      y += 24;

      doc
        .font("Amiri")
        .fontSize(9.5)
        .fillColor("#555555")
        .text(
          rtl(
            "يسرنا إحاطتكم بأننا نرغب في الشراء منكم وفقاً للأصناف والكميات المدرجة أدناه، ونرجو التكرم بتوريدها في أقرب وقت ممكن.",
          ),
          M,
          y,
          { width: CW, align: "right" },
        );
      y += 28;

      // ════════════════════════════════════════════════════════════════
      // ITEMS TABLE
      // Columns (RTL, right→left): # | رقم القطعة | الوصف | الكمية | الوحدة | سعر الوحدة | الإجمالي | ض.ق.م
      // Physical order (left→right): ض.ق.م | الإجمالي | السعر | الوحدة | الكمية | الوصف | رقم القطعة | #
      // ════════════════════════════════════════════════════════════════
      const C_NUM = 26;
      const C_PART = 80;
      const C_QTY = 44;
      const C_UOM = 40;
      const C_PRICE = 64;
      const C_TOTAL = 70;
      const C_TAX = 46; // "شامل ض.ق.م" badge column
      const C_DESC = CW - C_NUM - C_PART - C_QTY - C_UOM - C_PRICE - C_TOTAL - C_TAX;

      const colWArr = [C_NUM, C_PART, C_DESC, C_QTY, C_UOM, C_PRICE, C_TOTAL, C_TAX];
      const colLbls = [
        "#",
        rtl("رقم القطعة"),
        rtl("الوصف"),
        rtl("الكمية"),
        rtl("الوحدة"),
        rtl("سعر الوحدة"),
        rtl("الإجمالي"),
        rtl("ض.ق.م"),
      ];

      function colX(idx: number): number {
        let x = M + CW;
        for (let k = 0; k <= idx; k++) x -= colWArr[k];
        return x;
      }

      const ROW_H = 22;
      const ROW_PAD_V = 6;
      const FONT_SIZE = 9;

      // Header row
      doc.rect(M, y, CW, ROW_H).fill(BLUE);
      colLbls.forEach((lbl, i) => {
        doc
          .font("Amiri")
          .fontSize(FONT_SIZE - 0.5)
          .fillColor("#ffffff")
          .text(lbl, colX(i) + 2, y + 6, {
            width: colWArr[i] - 4,
            align: "center",
            lineBreak: false,
          });
      });
      y += ROW_H;

      // Data rows
      opts.items.forEach((item, idx) => {
        const descText = rtl(item.description);
        const descWidth = colWArr[2] - 6;

        doc.font("Amiri").fontSize(FONT_SIZE);
        const descTextH = doc.heightOfString(descText, { width: descWidth });
        const rowH = Math.max(ROW_H, descTextH + ROW_PAD_V * 2);

        const bg = idx % 2 === 0 ? "#ffffff" : "#f4f7fb";
        doc.rect(M, y, CW, rowH).fill(bg).stroke("#d8e2ee");

        // Calculate line total
        const qty = parseFloat(String(item.qty ?? 0)) || 0;
        const price = parseFloat(String(item.unitPrice ?? 0)) || 0;
        const lineTotal = qty * price;
        const hasTax = !!item.taxIncluded;

        const vals: string[] = [
          String(idx + 1),
          fmt(item.partNo),
          descText,
          fmt(item.qty),
          fmt(item.uom),
          fmt(item.unitPrice),
          lineTotal > 0 ? fmtMoney(lineTotal) : "—",
          "", // tax badge drawn separately
        ];

        vals.forEach((v, i) => {
          if (i === 7) return; // drawn separately below
          const isDesc = i === 2;
          const cellY = isDesc ? y + ROW_PAD_V : y + (rowH - FONT_SIZE) / 2 - 1;
          doc
            .font("Amiri")
            .fontSize(FONT_SIZE)
            .fillColor("#2c3e50")
            .text(v, colX(i) + 3, cellY, {
              width: colWArr[i] - 6,
              align: isDesc ? "right" : "center",
              lineBreak: isDesc,
            });
        });

        // Tax badge in last column
        if (hasTax) {
          const badgeX = colX(7) + 4;
          const badgeW = colWArr[7] - 8;
          const badgeH = 13;
          const badgeY = y + (rowH - badgeH) / 2;
          doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 3).fill("#e8f5e9");
          doc
            .font("Amiri")
            .fontSize(7)
            .fillColor("#2e7d32")
            .text(rtl("شامل ض.ق.م"), badgeX, badgeY + 2.5, {
              width: badgeW,
              align: "center",
              lineBreak: false,
            });
        } else {
          // dash
          doc
            .font("Amiri")
            .fontSize(FONT_SIZE)
            .fillColor("#aaaaaa")
            .text("—", colX(7) + 3, y + (rowH - FONT_SIZE) / 2 - 1, {
              width: colWArr[7] - 6,
              align: "center",
              lineBreak: false,
            });
        }

        y += rowH;
      });

      // ════════════════════════════════════════════════════════════════
      // TOTALS SECTION
      // For items with taxIncluded=true:  price already contains 14% VAT
      //   → preTax = price / 1.14,  vat = price - preTax
      // For items with taxIncluded=false: no VAT in price
      //   → preTax = price,          vat = 0
      // ════════════════════════════════════════════════════════════════
      let grandTotal = 0;
      let totalVat = 0;

      for (const item of opts.items) {
        const qty = parseFloat(String(item.qty ?? 0)) || 0;
        const price = parseFloat(String(item.unitPrice ?? 0)) || 0;
        const lineTotal = qty * price;
        grandTotal += lineTotal;
        if (item.taxIncluded && lineTotal > 0) {
          // Extract VAT already embedded in price
          totalVat += lineTotal - lineTotal / (1 + VAT_RATE);
        }
      }
      const preTaxTotal = grandTotal - totalVat;

      const TOTALS_W = 220;
      const TOTALS_X = M + CW - TOTALS_W;
      const T_ROW_H = 20;
      y += 4;

      type TotalRow = { label: string; value: string; bold?: boolean; highlight?: boolean };
      const totalRows: TotalRow[] = [];

      if (totalVat > 0) {
        totalRows.push({ label: rtl("الإجمالي قبل الضريبة"), value: fmtMoney(preTaxTotal) });
        totalRows.push({
          label: `${rtl("ضريبة القيمة المضافة")} (14%)`,
          value: fmtMoney(totalVat),
        });
      }
      totalRows.push({
        label: rtl("الإجمالي الكلي"),
        value: fmtMoney(grandTotal),
        bold: true,
        highlight: true,
      });

      for (const row of totalRows) {
        const bg = row.highlight ? BLUE : row.bold ? LGREY : "#ffffff";
        const fg = row.highlight ? "#ffffff" : row.bold ? BLUE : "#333333";

        doc.rect(TOTALS_X, y, TOTALS_W, T_ROW_H).fill(bg).stroke("#d8e2ee");

        // Label (right side)
        doc
          .font("Amiri")
          .fontSize(9)
          .fillColor(fg)
          .text(row.label, TOTALS_X + 4, y + (T_ROW_H - 9) / 2, {
            width: TOTALS_W - 70,
            align: "right",
            lineBreak: false,
          });

        // Value (left side)
        doc
          .font("Amiri")
          .fontSize(row.bold ? 10 : 9)
          .fillColor(row.highlight ? GOLD : fg)
          .text(row.value, TOTALS_X + TOTALS_W - 70, y + (T_ROW_H - 9) / 2, {
            width: 66,
            align: "center",
            lineBreak: false,
          });

        y += T_ROW_H;
      }

      y += 4;

      // ════════════════════════════════════════════════════════════════
      // RECEIVER BOX
      // ════════════════════════════════════════════════════════════════
      if (opts.receiverName || opts.receiverPhone) {
        y += 8;
        const RH = 46;
        doc.rect(M, y, CW, RH).fill("#f0f5fa");
        doc.rect(M + CW - 4, y, 4, RH).fill(GOLD);

        doc
          .font("Amiri")
          .fontSize(8.5)
          .fillColor("#7a90a8")
          .text(rtl("المندوب المستلم:"), M + 6, y + 7, {
            width: CW - 18,
            align: "right",
            lineBreak: false,
          });

        const receiverLine = [opts.receiverName, opts.receiverPhone]
          .filter(Boolean)
          .join("   |   ");
        doc
          .font("Amiri")
          .fontSize(10.5)
          .fillColor("#2c3e50")
          .text(rtl(receiverLine), M + 6, y + 24, {
            width: CW - 18,
            align: "right",
            lineBreak: false,
          });
        y += RH;
      }

      // ════════════════════════════════════════════════════════════════
      // NOTES
      // ════════════════════════════════════════════════════════════════
      if (opts.notes?.trim()) {
        y += 10;
        const NH = 46;
        doc.rect(M, y, CW, NH).fill("#f0f5fa");
        doc.rect(M + CW - 4, y, 4, NH).fill(BLUE);
        doc
          .font("Amiri")
          .fontSize(8.5)
          .fillColor("#7a90a8")
          .text(rtl("ملاحظات:"), M + 6, y + 7, {
            width: CW - 18,
            align: "right",
            lineBreak: false,
          });
        doc
          .font("Amiri")
          .fontSize(10.5)
          .fillColor("#2c3e50")
          .text(rtl(opts.notes.trim()), M + 6, y + 24, {
            width: CW - 18,
            align: "right",
            lineBreak: false,
          });
        y += NH;
      }

      // ════════════════════════════════════════════════════════════════
      // FOOTER
      // ════════════════════════════════════════════════════════════════
      const FY = Math.max(y + 20, doc.page.height - 58);
      doc.rect(M, FY, CW, 1.5).fill(GOLD);

      const contactParts = [
        opts.employeeName ? rtl(opts.employeeName) : null,
        opts.employeePhone ?? null,
        "INFO@CORTOBA-SUPPLIES.COM",
      ].filter(Boolean);

      doc
        .font("Amiri")
        .fontSize(9.5)
        .fillColor("#555555")
        .text(contactParts.join("   |   "), M, FY + 8, {
          width: CW,
          align: "center",
          lineBreak: false,
        });

      doc
        .font("Amiri")
        .fontSize(7.5)
        .fillColor("#999999")
        .text(
          rtl("ش.الإسكندرية - برج نجمة مطروح، الدور الرابع - مرسي مطروح") +
            "   |   ت: 432-972-587   |   س-ت: 21618",
          M,
          FY + 24,
          { width: CW, align: "center", lineBreak: false },
        );

      doc
        .font("Amiri")
        .fontSize(7)
        .fillColor("#aaaaaa")
        .text(rtl("قرطبة للتوريدات") + " — CORTOBA SUPPLIES", M, FY + 38, {
          width: CW,
          align: "center",
          lineBreak: false,
        });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

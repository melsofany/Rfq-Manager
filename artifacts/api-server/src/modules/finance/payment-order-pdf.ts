import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { rtlSlotX, flowRows, type FlowRow } from "./pdf-layout";
import { rtl, rtlLabelValue } from "./rtl-text";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

// Payment order (أمر دفع) PDF — the document the operator prints and hands to
// the bank / signs, so a supplier is paid.
//
// It deliberately carries NO line items: a payment order is an instruction to
// pay an AMOUNT, not a re-statement of the order's contents. What it must show
// is the reference (which purchase order the money is against), the amount, the
// supplier's bank account, and who prepared / reviewed / approved it.
//
// Brand, fonts and layout match the quotation and purchase-order PDFs
// (see customer-rfq/quotation-pdf.ts, po/po-pdf.ts).

export const COMPANY_PHONE = "432-972-587";
export const COMPANY_ADDRESS = "ش.الإسكندرية - برج نجمة مطروح، الدور الرابع - مرسي مطروح";
export const COMPANY_CR = "س-ت: 21618";
export const COMPANY_EMAIL = "INFO@CORTOBA-SUPPLIES.COM";

export interface PaymentOrderOptions {
  /** `PAY-YYYY-NNNNNN` — allocated at confirm time, never reused. */
  paymentNo: string;
  paymentDate: string;
  supplierName: string;
  /** The purchase order the payment is against. */
  internalPoNo?: string | null;
  sheetPoNo?: string | null;
  bank: {
    bankName?: string | null;
    bankAccountHolder?: string | null;
    bankAccountNumber?: string | null;
    iban?: string | null;
    swiftCode?: string | null;
    bankBranch?: string | null;
  };
  /** What is being paid on THIS document. */
  amount: number;
  /** The order's own money, so a partial payment is visible as such. */
  poTotal: number;
  paidBefore: number;
  remainingAfter: number;
  method: string;
  reference?: string | null;
  notes?: string | null;
  /** The employee who recorded the payment. */
  preparedBy?: string | null;
}

function formatDate(d?: string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Bundle: dist/assets (copied by build.mjs). Source/tests: src/assets.
function assetPath(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(here, rel);
  if (existsSync(bundled)) return bundled;
  return resolve(here, "../..", rel);
}

/**
 * The amount in Arabic words. A payment order is signed by hand, so a
 * mistyped digit is caught by reading the words — this is why banks require
 * it, and why it is not optional here.
 */
const ONES = [
  "",
  "واحد",
  "اثنان",
  "ثلاثة",
  "أربعة",
  "خمسة",
  "ستة",
  "سبعة",
  "ثمانية",
  "تسعة",
  "عشرة",
  "أحد عشر",
  "اثنا عشر",
  "ثلاثة عشر",
  "أربعة عشر",
  "خمسة عشر",
  "ستة عشر",
  "سبعة عشر",
  "ثمانية عشر",
  "تسعة عشر",
];
const TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
const HUNDREDS = [
  "",
  "مائة",
  "مائتان",
  "ثلاثمائة",
  "أربعمائة",
  "خمسمائة",
  "ستمائة",
  "سبعمائة",
  "ثمانمائة",
  "تسعمائة",
];

function below1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (rest) {
    if (rest < 20) parts.push(ONES[rest]);
    else {
      const t = Math.floor(rest / 10);
      const o = rest % 10;
      parts.push(o ? `${ONES[o]} و${TENS[t]}` : TENS[t]);
    }
  }
  return parts.join(" و");
}

/** Group a number into Arabic scale words (ألف / مليون). */
function toArabicWords(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return "صفر";
  const groups: Array<[number, string, string]> = [
    [1_000_000_000, "مليار", "مليار"],
    [1_000_000, "مليون", "مليون"],
    [1_000, "ألف", "ألف"],
  ];
  const out: string[] = [];
  let rest = n;
  for (const [size, singular, plural] of groups) {
    const count = Math.floor(rest / size);
    if (!count) continue;
    rest %= size;
    if (count === 1) out.push(singular);
    else if (count === 2) out.push(`${singular}ان`);
    else if (count <= 10) out.push(`${below1000(count)} ${plural}`);
    else out.push(`${below1000(count)} ${singular}`);
  }
  if (rest) out.push(below1000(rest));
  return out.join(" و");
}

/** «فقط اثنا عشر ألفًا وخمسمائة جنيه مصري لا غير» */
export function amountInArabicWords(value: number): string {
  const piasters = Math.round((Math.abs(value) - Math.floor(Math.abs(value))) * 100);
  const whole = toArabicWords(Math.floor(Math.abs(value)));
  const tail = piasters > 0 ? ` و${below1000(piasters)} قرشًا` : "";
  return `فقط ${whole}${tail} جنيهًا مصريًا لا غير`;
}

export function generatePaymentOrderPdf(opts: PaymentOrderOptions): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    try {
      const fontPath = assetPath("assets/fonts/Amiri-Regular.ttf");
      const logoPath = assetPath("assets/logo.png");
      const hasLogo = existsSync(logoPath);

      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 36, left: 36, right: 36, bottom: 0 },
        autoFirstPage: true,
        compress: true,
      });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolvePromise(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.registerFont("Amiri", fontPath);

      const PAGE_W = doc.page.width;
      const M = 36;
      const CW = PAGE_W - M * 2;
      const BLUE = "#1a3a5c";
      const GOLD = "#c8a84b";
      const LGREY = "#eef2f7";

      // ── Header band ──
      const HDR_H = 96;
      doc.rect(0, 0, PAGE_W, HDR_H).fill(BLUE);
      doc.rect(0, HDR_H - 3, PAGE_W, 3).fill(GOLD);
      if (hasLogo) doc.image(logoPath, M, 14, { fit: [64, 64] });
      doc
        .font("Amiri")
        .fontSize(11)
        .fillColor(GOLD)
        .text(rtl("قرطبة للتوريدات"), M + 76, 22, { width: 200, align: "left", lineBreak: false });
      doc
        .fontSize(8)
        .fillColor("#c0d8f0")
        .text("CORTOBA SUPPLIES", M + 76, 40, { width: 200, align: "left", lineBreak: false });
      doc
        .fontSize(7.5)
        .fillColor("#8aaec8")
        .text(rtl(COMPANY_ADDRESS), M + 76, 56, { width: 260, align: "left", lineBreak: false });
      doc
        .fontSize(8)
        .fillColor("#dfe9f5")
        .text(rtlLabelValue("ت:", `${COMPANY_PHONE}   |   ${COMPANY_EMAIL}`), M + 76, 70, {
          width: 320,
          align: "left",
          lineBreak: false,
        });

      doc
        .font("Amiri")
        .fontSize(22)
        .fillColor("#ffffff")
        .text(rtl("أمر دفع"), PAGE_W - M - 200, 18, {
          width: 200,
          align: "right",
          lineBreak: false,
        });
      doc
        .fontSize(9)
        .fillColor(GOLD)
        .text("PAYMENT ORDER", PAGE_W - M - 200, 46, {
          width: 200,
          align: "right",
          lineBreak: false,
        });
      doc
        .fontSize(9)
        .fillColor("#aaccee")
        .text(rtlLabelValue("رقم:", opts.paymentNo), PAGE_W - M - 200, 64, {
          width: 200,
          align: "right",
          lineBreak: false,
        });

      // ── Reference block ──
      let y = HDR_H + 16;
      const refRows: Array<[string, string]> = [
        ["رقم أمر الشراء", opts.internalPoNo || "—"],
        ["رقم أمر الشراء (المورد)", opts.sheetPoNo || "—"],
        ["تاريخ أمر الدفع", formatDate(opts.paymentDate)],
        ["طريقة السداد", opts.method],
      ];
      const LABEL_W = 170;
      doc.font("Amiri").fontSize(10).fillColor("#111111");
      const refItems: FlowRow[] = refRows.map(([label, value]) => ({
        value: rtl(value),
        label: rtl(label),
      }));
      // Measured, not stepped: a value that wraps must push the next row down.
      const refFlow = flowRows(doc, refItems, {
        top: y,
        valueWidth: CW - LABEL_W - 10,
        labelWidth: LABEL_W,
      });
      refItems.forEach((row, i) => {
        doc.fillColor("#111111").text(row.value, M, refFlow.ys[i], {
          width: CW - LABEL_W - 10,
          align: "right",
        });
        doc.fillColor("#555555").text(row.label, M + CW - LABEL_W, refFlow.ys[i], {
          width: LABEL_W,
          align: "right",
        });
      });
      doc.fillColor("#111111");
      y = refFlow.nextY + 12;

      // ── Supplier + bank block ──
      const bankRows: Array<[string, string | null | undefined]> = [
        ["البنك", opts.bank.bankName],
        ["اسم صاحب الحساب", opts.bank.bankAccountHolder],
        ["رقم الحساب", opts.bank.bankAccountNumber],
        ["IBAN", opts.bank.iban],
        ["SWIFT", opts.bank.swiftCode],
        ["الفرع", opts.bank.bankBranch],
      ];
      const shown = bankRows.filter(([, v]) => v);
      const title = rtl("يُدفع إلى:");
      const supplierName = rtl(opts.supplierName);
      const rows: FlowRow[] = shown.map(([label, value]) => ({
        value: rtl(String(value)),
        label: rtl(label),
      }));

      // The box is drawn BEHIND its text, so its height must be known first.
      // Rows are measured, not stepped: a long account holder name wraps and
      // must push the rows below it down instead of overprinting them.
      doc.font("Amiri").fontSize(9);
      const titleH = doc.heightOfString(title, { width: CW - 16 });
      doc.fontSize(12);
      const nameH = doc.heightOfString(supplierName, { width: CW - 16 });
      doc.fontSize(9);
      const titleY = y + 6;
      const nameY = titleY + titleH + 6;
      const flow = flowRows(doc, rows, {
        top: nameY + nameH + 6,
        valueWidth: CW - LABEL_W - 24,
        labelWidth: LABEL_W,
      });
      const boxH = Math.max(104, flow.nextY - y + 10);

      doc.rect(M, y, CW, boxH).fill(LGREY);
      doc.fillColor(BLUE).text(title, M + 8, titleY, {
        width: CW - 16,
        align: "right",
        lineBreak: false,
      });
      doc
        .fillColor("#111111")
        .fontSize(12)
        .text(supplierName, M + 8, nameY, {
          width: CW - 16,
          align: "right",
        });

      doc.fontSize(9);
      rows.forEach((row, i) => {
        // A Latin/digit value (account number, IBAN, SWIFT) has no Arabic words
        // to reorder, so rtl() leaves it untouched; an Arabic bank name or
        // branch is laid out right-to-left like every other value.
        doc.fillColor("#111111").text(row.value, M + 8, flow.ys[i], {
          width: CW - LABEL_W - 24,
          align: "right",
        });
        doc.fillColor("#666666").text(row.label, M + CW - LABEL_W, flow.ys[i], {
          width: LABEL_W,
          align: "right",
        });
      });
      if (shown.length === 0) {
        doc
          .fillColor("#a33")
          .fontSize(9)
          .text(rtl("لا توجد بيانات بنكية مسجلة لهذا المورد"), M + 8, y + 44, {
            width: CW - 16,
            align: "right",
            lineBreak: false,
          });
      }
      y += boxH + 16;

      // ── Amount block — the reason the document exists ──
      // Measured, not fixed: the words-of-amount line wraps for a large sum and
      // must grow the block rather than overprint the amount above it.
      doc.font("Amiri").fontSize(9);
      const amtTitleH = doc.heightOfString(rtl("المبلغ المطلوب سداده"), { width: CW });
      const amountText = rtl(`${money(opts.amount)} ج.م`);
      doc.fontSize(26);
      const amountH = doc.heightOfString(amountText, { width: CW });
      const wordsText = rtl(amountInArabicWords(opts.amount));
      doc.fontSize(8.5);
      const wordsH = doc.heightOfString(wordsText, { width: CW - 20 });

      const amtTitleY = y + 10;
      const amountY = amtTitleY + amtTitleH + 6;
      const wordsY = amountY + amountH + 6;
      const amtH = Math.max(92, wordsY + wordsH - y + 8);

      doc.rect(M, y, CW, amtH).fill(BLUE);
      doc.fontSize(9).fillColor("#aaccee").text(rtl("المبلغ المطلوب سداده"), M, amtTitleY, {
        width: CW,
        align: "center",
      });
      doc
        .fontSize(26)
        .fillColor("#ffffff")
        .text(amountText, M, amountY, { width: CW, align: "center" });
      doc
        .fontSize(8.5)
        .fillColor(GOLD)
        .text(wordsText, M + 10, wordsY, { width: CW - 20, align: "center" });
      y += amtH + 14;

      // ── Order money context — what makes a PARTIAL payment legible ──
      const ctxRows: Array<[string, string]> = [
        ["إجمالي أمر الشراء", `${money(opts.poTotal)} ج.م`],
        ["المسدد قبل أمر الدفع", `${money(opts.paidBefore)} ج.م`],
        ["المتبقي بعد أمر الدفع", `${money(opts.remainingAfter)} ج.م`],
      ];
      doc.rect(M, y, CW, 20).fill(BLUE);
      doc.fontSize(9).fillColor("#ffffff");
      ctxRows.forEach(([label], i) => {
        doc.text(rtl(label), rtlSlotX(i, ctxRows.length, M, CW), y + 6, {
          width: CW / 3,
          align: "center",
          lineBreak: false,
        });
      });
      doc.fontSize(11).fillColor("#111111");
      ctxRows.forEach(([, value], i) => {
        doc.text(rtl(value), rtlSlotX(i, ctxRows.length, M, CW), y + 26, {
          width: CW / 3,
          align: "center",
          lineBreak: false,
        });
      });
      y += 20 + 22 + 12;

      if (opts.reference || opts.notes) {
        doc.fontSize(9).fillColor("#444444");
        if (opts.reference) {
          const refText = rtlLabelValue("المرجع:", opts.reference);
          doc.text(refText, M, y, { width: CW, align: "right" });
          y += doc.heightOfString(refText, { width: CW });
        }
        if (opts.notes) {
          doc.text(rtlLabelValue("ملاحظات:", opts.notes), M, y, {
            width: CW,
            align: "right",
          });
          y = doc.y + 8;
        }
      }

      // ── Signature block ──
      const sigY = Math.max(y + 24, doc.page.height - 150);
      const sigCols: Array<[string, string | null | undefined]> = [
        ["أعدّه", opts.preparedBy],
        ["راجعه", null],
        ["اعتمده", null],
      ];
      const colW = CW / 3;
      doc.font("Amiri").fontSize(10);
      const labelH = doc.heightOfString(rtl("أعدّه"), { width: colW });
      doc.fontSize(8.5);
      const maxNameH = Math.max(
        0,
        ...sigCols.map(([, v]) => (v ? doc.heightOfString(rtl(v), { width: colW }) : 0)),
      );
      const sigGap = labelH + 4;
      const ruleY = sigY + sigGap + maxNameH + 8;
      sigCols.forEach(([label, value], i) => {
        const x = rtlSlotX(i, sigCols.length, M, CW);
        doc
          .fontSize(10)
          .fillColor(BLUE)
          .text(rtl(label), x, sigY, { width: colW, align: "center", lineBreak: false });
        if (value) {
          doc
            .fontSize(8.5)
            .fillColor("#333333")
            .text(rtl(value), x, sigY + sigGap, { width: colW, align: "center" });
        }
        doc
          .moveTo(x + 14, ruleY)
          .lineTo(x + colW - 14, ruleY)
          .strokeColor("#999999")
          .lineWidth(0.6)
          .stroke();
        doc
          .fontSize(7.5)
          .fillColor("#888888")
          .text(rtl("التوقيع"), x, ruleY + 4, {
            width: colW,
            align: "center",
            lineBreak: false,
          });
      });

      // ── Footer ──
      const fy = doc.page.height - 54;
      doc.rect(0, fy, PAGE_W, 54).fill(BLUE);
      doc
        .font("Amiri")
        .fontSize(8)
        .fillColor("#dfe9f5")
        .text(
          rtl(`${COMPANY_ADDRESS}  |  ${COMPANY_CR}  |  ${COMPANY_PHONE}  |  ${COMPANY_EMAIL}`),
          M,
          fy + 12,
          { width: CW, align: "center", lineBreak: false },
        );
      doc
        .fontSize(8)
        .fillColor(GOLD)
        .text(
          rtlLabelValue("أمر دفع رقم", `${opts.paymentNo} — ${formatDate(opts.paymentDate)}`),
          M,
          fy + 28,
          {
            width: CW,
            align: "center",
            lineBreak: false,
          },
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

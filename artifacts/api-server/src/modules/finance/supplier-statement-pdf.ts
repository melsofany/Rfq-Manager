import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { rtlColumnX, rtlSlotX } from "./pdf-layout";
import { rtl, rtlLabelValue } from "./rtl-text";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

// Supplier statement (كشف حساب مورد) PDF — every open purchase order for one
// supplier, with one grand total. Printed on its own, WITHOUT recording a
// payment, so the operator can send it to the supplier to agree the balance
// before any money moves.
//
// Brand, fonts and layout match the payment order (payment-order-pdf.ts).

import { COMPANY_PHONE, COMPANY_ADDRESS, COMPANY_CR, COMPANY_EMAIL } from "./payment-order-pdf";

export interface SupplierStatementRow {
  internalPoNo?: string | null;
  sheetPoNo?: string | null;
  selectedAt?: string | null;
  dueAmount: number;
  paidAmount: number;
  remainingAmount: number;
  status: string;
}

export interface SupplierStatementOptions {
  /** `STM-YYYY-NNNNNN` — allocated per print run. */
  statementNo: string;
  generatedAt: string;
  supplierName: string;
  bank: {
    bankName?: string | null;
    bankAccountHolder?: string | null;
    bankAccountNumber?: string | null;
    iban?: string | null;
    swiftCode?: string | null;
    bankBranch?: string | null;
  };
  rows: SupplierStatementRow[];
  totals: { due: number; paid: number; remaining: number };
  /** The employee who printed the statement. */
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

function assetPath(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(here, rel);
  if (existsSync(bundled)) return bundled;
  return resolve(here, "../..", rel);
}

/**
 * Column widths for the orders table. They MUST sum to the usable width: the
 * first cut left the last column unaccounted for, so «المتبقي» overflowed the
 * page and every figure in it was clipped to «12,5».
 */
export function statementColumnWidths(contentWidth: number) {
  const sheet = 96;
  const date = 78;
  const due = 78;
  const paid = 78;
  const remaining = 76;
  const po = contentWidth - (sheet + date + due + paid + remaining);
  return { po, sheet, date, due, paid, remaining };
}

export function generateSupplierStatementPdf(opts: SupplierStatementOptions): Promise<Buffer> {
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
        bufferPages: true,
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
      const HDR_H = 96;

      // ── Header band (repeated on every page) ──
      const drawHeader = () => {
        doc.rect(0, 0, PAGE_W, HDR_H).fill(BLUE);
        doc.rect(0, HDR_H - 3, PAGE_W, 3).fill(GOLD);
        if (hasLogo) doc.image(logoPath, M, 14, { fit: [64, 64] });
        doc
          .font("Amiri")
          .fontSize(11)
          .fillColor(GOLD)
          .text(rtl("قرطبة للتوريدات"), M + 76, 22, {
            width: 200,
            align: "left",
            lineBreak: false,
          });
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
          .fontSize(20)
          .fillColor("#ffffff")
          .text(rtl("كشف حساب مورد"), PAGE_W - M - 210, 18, {
            width: 210,
            align: "right",
            lineBreak: false,
          });
        doc
          .fontSize(9)
          .fillColor(GOLD)
          .text("SUPPLIER STATEMENT", PAGE_W - M - 210, 44, {
            width: 210,
            align: "right",
            lineBreak: false,
          });
        doc
          .fontSize(9)
          .fillColor("#aaccee")
          .text(rtlLabelValue("رقم:", opts.statementNo), PAGE_W - M - 210, 62, {
            width: 210,
            align: "right",
            lineBreak: false,
          });
      };
      drawHeader();

      let y = HDR_H + 16;

      // ── Supplier + bank block ──
      doc.rect(M, y, CW, 30).fill(LGREY);
      doc
        .font("Amiri")
        .fontSize(12)
        .fillColor("#111111")
        .text(rtl(opts.supplierName), M + 8, y + 9, {
          width: CW - 130,
          align: "right",
          lineBreak: false,
        });
      doc
        .fontSize(9)
        .fillColor("#555555")
        .text(formatDate(opts.generatedAt), M + 8, y + 11, {
          width: 120,
          align: "left",
          lineBreak: false,
        });
      y += 38;

      const bankRows: Array<[string, string | null | undefined]> = [
        ["البنك", opts.bank.bankName],
        ["اسم صاحب الحساب", opts.bank.bankAccountHolder],
        ["رقم الحساب", opts.bank.bankAccountNumber],
        ["IBAN", opts.bank.iban],
        ["SWIFT", opts.bank.swiftCode],
        ["الفرع", opts.bank.bankBranch],
      ];
      const shown = bankRows.filter(([, v]) => v);
      const BANK_LABEL_W = 150;
      if (shown.length) {
        doc.fontSize(8.5);
        shown.forEach(([label, value], i) => {
          const rowY = y + i * 11;
          doc.fillColor("#111111").text(rtl(String(value)), M, rowY, {
            width: CW - BANK_LABEL_W - 10,
            align: "right",
            lineBreak: false,
          });
          doc.fillColor("#666666").text(rtl(label), M + CW - BANK_LABEL_W, rowY, {
            width: BANK_LABEL_W,
            align: "right",
            lineBreak: false,
          });
        });
        y += shown.length * 11 + 12;
      }

      // ── Orders table ──
      const cols = statementColumnWidths(CW);
      // RTL column order: index 0 (أمر الشراء) sits at the RIGHT edge.
      const colWArr = [cols.po, cols.sheet, cols.date, cols.due, cols.paid, cols.remaining];

      const drawTableHeader = () => {
        doc.rect(M, y, CW, 22).fill(BLUE);
        doc.font("Amiri").fontSize(8.5).fillColor("#ffffff");
        const heads: Array<[string, number]> = [
          ["أمر الشراء", cols.po],
          ["رقم المورد", cols.sheet],
          ["التاريخ", cols.date],
          ["المستحق", cols.due],
          ["المسدد", cols.paid],
          ["المتبقي", cols.remaining],
        ];
        heads.forEach(([label, w], i) => {
          const x = rtlColumnX(colWArr, i, M);
          doc.text(rtl(label), x, y + 7, { width: w, align: "center", lineBreak: false });
        });
        y += 22;
      };
      drawTableHeader();

      const rowH = 20;
      opts.rows.forEach((r, i) => {
        if (y + rowH > doc.page.height - 150) {
          doc.addPage();
          drawHeader();
          y = HDR_H + 16;
          drawTableHeader();
        }
        if (i % 2 === 1) doc.rect(M, y, CW, rowH).fill("#f6f9fc");
        doc.fontSize(8.5).fillColor("#111111");
        const cells: Array<[string, number]> = [
          [r.internalPoNo || "—", cols.po],
          [r.sheetPoNo || "—", cols.sheet],
          [formatDate(r.selectedAt), cols.date],
          [money(r.dueAmount), cols.due],
          [money(r.paidAmount), cols.paid],
          [money(r.remainingAmount), cols.remaining],
        ];
        cells.forEach(([text, w], i) => {
          const x = rtlColumnX(colWArr, i, M);
          doc.text(rtl(text), x, y + 6, { width: w, align: "center", lineBreak: false });
        });
        y += rowH;
      });

      // ── Totals ──
      y += 6;
      doc.rect(M, y, CW, 24).fill(BLUE);
      doc.fontSize(10).fillColor("#ffffff");
      const totalCells: string[] = [
        rtlLabelValue("إجمالي المستحق:", money(opts.totals.due)),
        rtlLabelValue("إجمالي المسدد:", money(opts.totals.paid)),
        rtlLabelValue("إجمالي المتبقي:", money(opts.totals.remaining)),
      ];
      totalCells.forEach((text, i) => {
        doc.text(text, rtlSlotX(i, 3, M, CW), y + 8, {
          width: CW / 3,
          align: "center",
          lineBreak: false,
        });
      });
      y += 34;

      doc
        .fontSize(8.5)
        .fillColor("#555555")
        .text(rtl("هذا الكشف يعرض أوامر الشراء المفتوحة على المورد حتى تاريخ إصداره."), M, y, {
          width: CW,
          align: "center",
        });
      y = doc.y + 16;

      // ── Signature block ──
      const sigY = Math.max(y, doc.page.height - 140);
      const sigCols: Array<[string, string | null | undefined]> = [
        ["أعدّه", opts.preparedBy],
        ["راجعه", null],
        ["اعتمده", null],
      ];
      const colW = CW / 3;
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
            .text(rtl(value), x, sigY + 14, { width: colW, align: "center", lineBreak: false });
        }
        doc
          .moveTo(x + 14, sigY + 52)
          .lineTo(x + colW - 14, sigY + 52)
          .strokeColor("#999999")
          .lineWidth(0.6)
          .stroke();
        doc
          .fontSize(7.5)
          .fillColor("#888888")
          .text(rtl("التوقيع"), x, sigY + 56, {
            width: colW,
            align: "center",
            lineBreak: false,
          });
      });

      // ── Footer on every page ──
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
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
            rtlLabelValue(
              "كشف حساب رقم",
              `${opts.statementNo} — صفحة ${i - range.start + 1} من ${range.count}`,
            ),
            M,
            fy + 28,
            { width: CW, align: "center", lineBreak: false },
          );
      }

      doc.flushPages();
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

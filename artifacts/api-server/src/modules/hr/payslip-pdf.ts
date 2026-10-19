/**
 * Payslip PDF — كشف مرتب الموظف.
 *
 * One A4 page per employee, sent to that employee's own WhatsApp number. The
 * document carries the full money breakdown (gross, deductions, insurance, tax,
 * net) so the employee sees exactly what was deducted and why.
 *
 * Built the same way as `rfq/rfq-pdf.ts` and `po/po-pdf.ts`: PDFKit with the
 * Amiri font (Arabic), and the same `rtl()` word-reversal helper — PDFKit
 * lays out text left-to-right, so Arabic word order must be reversed by hand.
 */
import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

export interface PayslipPdfOptions {
  /** YYYY-MM */
  period: string;
  employeeNo: string;
  fullName: string;
  jobTitle?: string | null;
  department?: string | null;
  basic: number;
  allowances: number;
  bonuses: number;
  incentives: number;
  deductions: number;
  absenceDays: number;
  absenceAmount: number;
  finesApplied: number;
  finesDeferred: number;
  socialEmployee: number;
  healthEmployee: number;
  incomeTax: number;
  gross: number;
  net: number;
}

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function rtl(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (!ARABIC_RE.test(trimmed)) return trimmed;
  const words = trimmed.split(/\s+/);
  if (words.length <= 1) return trimmed;
  return words.reverse().join(" ");
}

function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** «2026-07» → «07/2026» (Western digits — Arabic-Indic numerals reverse in PDFKit). */
function periodLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  return m ? `${m[2]}/${m[1]}` : period;
}

function getFontPath(): string {
  return resolveAsset("fonts/Amiri-Regular.ttf");
}

function getLogoPath(): string {
  return resolveAsset("logo.png");
}

/**
 * Locate a shipped asset from either layout: the bundle puts `assets/` beside
 * the compiled entry (`dist/assets`), while a source run keeps it at
 * `src/assets` — two levels up from `src/modules/hr/`. First hit wins.
 */
function resolveAsset(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "assets", rel), resolve(here, "..", "..", "assets", rel)];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

export function generatePayslipPdf(opts: PayslipPdfOptions): Promise<Buffer> {
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

      // The Arabic font ships in `assets/` (copied into dist by the build). When
      // it is missing — a source-run, or a bundle that lost the asset — fall back
      // to a built-in font rather than throwing, so the payslip is still produced.
      const hasFont = existsSync(fontPath);
      if (hasFont) {
        doc.registerFont("Amiri", fontPath);
        doc.font("Amiri");
      } else {
        doc.font("Helvetica");
      }

      const PAGE_W = doc.page.width;
      const M = 28;
      const CW = PAGE_W - M * 2;
      const BLUE = "#1a3a5c";
      const GOLD = "#c8a84b";
      const LGREY = "#eef2f7";
      const RED = "#a02020";

      // ── Header ───────────────────────────────────────────────────────────
      const HDR_H = 88;
      doc.rect(0, 0, PAGE_W, HDR_H).fill(BLUE);
      doc.rect(0, HDR_H - 3, PAGE_W, 3).fill(GOLD);

      const TITLE_X = PAGE_W / 2;
      const TITLE_W = PAGE_W / 2 - M;
      doc.font("Amiri").fontSize(22).fillColor("#ffffff").text(rtl("كشف مرتب"), TITLE_X, 16, {
        width: TITLE_W,
        align: "right",
        lineBreak: false,
      });
      doc.font("Amiri").fontSize(9).fillColor(GOLD).text("PAYSLIP", TITLE_X, 48, {
        width: TITLE_W,
        align: "right",
        lineBreak: false,
      });
      doc
        .font("Amiri")
        .fontSize(9)
        .fillColor("#aaccee")
        .text(rtl(`عن شهر ${periodLabel(opts.period)}`), TITLE_X, 64, {
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
      doc.font("Amiri").fontSize(11).fillColor(GOLD).text(rtl("قرطبة للتوريدات"), CO_TEXT_X, 14, {
        width: CO_TEXT_W,
        align: "left",
        lineBreak: false,
      });
      doc.font("Amiri").fontSize(8).fillColor("#c0d8f0").text("CORTOBA SUPPLIES", CO_TEXT_X, 32, {
        width: CO_TEXT_W,
        align: "left",
        lineBreak: false,
      });
      doc
        .font("Amiri")
        .fontSize(7)
        .fillColor("#8aaec8")
        .text(rtl("مرسي مطروح  |  ت: 432-972-587"), CO_TEXT_X, 50, {
          width: CO_TEXT_W,
          align: "left",
          lineBreak: false,
        });

      // ── Employee band ────────────────────────────────────────────────────
      const IY = HDR_H;
      const IH = 50;
      doc.rect(0, IY, PAGE_W, IH).fill(LGREY);
      const infoCells = [
        { label: rtl("الموظف"), value: opts.fullName },
        { label: rtl("الرقم الوظيفي"), value: opts.employeeNo },
        { label: rtl("الشهر"), value: periodLabel(opts.period) },
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
          .fontSize(11)
          .fillColor(BLUE)
          .text(cell.value, cx, IY + 24, { width: cellW, align: "center", lineBreak: false });
      });

      // ── Tables ───────────────────────────────────────────────────────────
      let y = IY + IH + 16;

      const earnings: [string, number][] = [
        [rtl("الراتب الأساسي"), opts.basic],
        [rtl("بدلات"), opts.allowances],
        [rtl("مكافآت"), opts.bonuses],
        [rtl("حوافز إنتاج"), opts.incentives],
      ];
      const deductions: [string, number][] = [
        [rtl("خصومات"), opts.deductions],
        [rtl(`غياب (${opts.absenceDays} يوم)`), opts.absenceAmount],
        [rtl("جزاءات"), opts.finesApplied],
        [rtl("تأمينات اجتماعية (حصة الموظف)"), opts.socialEmployee],
        [rtl("تأمين صحي (حصة الموظف)"), opts.healthEmployee],
        [rtl("ضريبة الدخل"), opts.incomeTax],
      ];

      const drawTable = (title: string, rows: [string, number][], accent: string) => {
        doc.rect(M, y, CW, 20).fill(accent);
        doc
          .font("Amiri")
          .fontSize(10)
          .fillColor("#ffffff")
          .text(title, M, y + 5, { width: CW - 10, align: "right", lineBreak: false });
        y += 20;
        rows.forEach(([label, value], i) => {
          if (i % 2 === 1) doc.rect(M, y, CW, 18).fill("#f7f9fb");
          doc
            .font("Amiri")
            .fontSize(9)
            .fillColor("#33404d")
            .text(label, M, y + 4, { width: CW - 10, align: "right", lineBreak: false });
          doc
            .font("Amiri")
            .fontSize(9)
            .fillColor("#33404d")
            .text(money(value), M + 10, y + 4, { width: CW - 20, align: "left", lineBreak: false });
          y += 18;
        });
        y += 12;
      };

      drawTable(rtl("الاستحقاقات"), earnings, BLUE);
      drawTable(rtl("الاستقطاعات"), deductions, "#7a6a45");

      // ── Totals ───────────────────────────────────────────────────────────
      doc.rect(M, y, CW, 22).fill(LGREY);
      doc
        .font("Amiri")
        .fontSize(10)
        .fillColor(BLUE)
        .text(rtl("إجمالي الاستحقاقات"), M, y + 6, {
          width: CW - 10,
          align: "right",
          lineBreak: false,
        });
      doc
        .font("Amiri")
        .fontSize(10)
        .fillColor(BLUE)
        .text(money(opts.gross), M + 10, y + 6, {
          width: CW - 20,
          align: "left",
          lineBreak: false,
        });
      y += 22;
      doc.rect(M, y, CW, 26).fill(BLUE);
      doc
        .font("Amiri")
        .fontSize(12)
        .fillColor("#ffffff")
        .text(rtl("صافي المستحق"), M, y + 7, { width: CW - 10, align: "right", lineBreak: false });
      doc
        .font("Amiri")
        .fontSize(13)
        .fillColor(GOLD)
        .text(money(opts.net), M + 10, y + 6, { width: CW - 20, align: "left", lineBreak: false });
      y += 40;

      if (opts.finesDeferred > 0) {
        doc
          .font("Amiri")
          .fontSize(8)
          .fillColor(RED)
          .text(rtl(`جزاءات مؤجلة (فوق الحد الشهري): ${money(opts.finesDeferred)}`), M, y, {
            width: CW,
            align: "right",
            lineBreak: false,
          });
        y += 16;
      }

      // ── Footer ───────────────────────────────────────────────────────────
      doc
        .font("Amiri")
        .fontSize(7.5)
        .fillColor("#7a90a8")
        .text(
          rtl(
            "هذا المستند صادر إلكترونيًا من نظام قرطبة للتوريدات، ويُعد كشف المرتب الرسمي عن الشهر المذكور أعلاه. للاستفسار يُرجى مراجعة إدارة الموارد البشرية.",
          ),
          M,
          y + 6,
          { width: CW, align: "right" },
        );

      doc.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}

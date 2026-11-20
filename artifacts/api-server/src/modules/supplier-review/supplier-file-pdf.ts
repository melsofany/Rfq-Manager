/**
 * ملف اعتماد المورد — the printable supplier file.
 *
 * What a reviewer hands to an approver, a bank, or an auditor: the supplier's
 * declared data, the categories they were approved for, every attachment they
 * uploaded, and the reviewer's own verification with a signature block.
 *
 * Built with PDFKit + Noto Kufi Arabic and the Cortoba identity (see
 * `shared/brand.ts`). Two structural decisions matter:
 *
 * 1. **A page per document, with the image inside a frame.** Production
 *    attachments are photographs (image/jpeg), so rendering the bytes as an
 *    image reproduces the supplier's document faithfully. A PDF attachment is
 *    reproduced by its metadata and a clear notice rather than silently
 *    dropped — a missing attachment in an "approved" file is a lie by omission.
 * 2. **The cover states the verdict.** An approver reading page one must see
 *    the decision, who took it, when, and what was verified — not just the
 *    company's name.
 */
import PDFDocument from "pdfkit";
import jpeg from "jpeg-js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { BRAND, BRAND_FONTS, COMPANY, hasArabic, rtl, rtlLabelValue } from "../../shared/brand";
import { CATEGORY_VERDICT_LABELS, type CategoryVerdict } from "./review-routes";

export interface SupplierFileDocument {
  id: number;
  slot: string;
  label: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  /**
   * Raw bytes — rendered for images, described otherwise.
   *
   * Accepts base64 TEXT as well, because that is how this schema stores it
   * (`supplier_documents.content` is TEXT). Passing the string straight to
   * PDFKit throws inside `doc.image()`, and a `try/catch` around it turns every
   * attachment into a "could not display" placeholder in an otherwise
   * complete-looking file — so the normalisation happens HERE, at the one
   * boundary every caller crosses.
   */
  content: Buffer | string | null;
}

export interface SupplierFileCategory {
  name: string;
  /** Reviewer's verdict: confirmed / partial / unproven / pending. */
  verdict?: string | null;
  note?: string | null;
  /** Employee who owns this category (the future contact for this line of work). */
  owner?: string | null;
}

export interface SupplierFileSignature {
  /** Printed name of the reviewer who verified the file. */
  verifierName?: string | null;
  verifierRole?: string | null;
  verifiedAt?: string | null;
  /** Printed name of the employee who took the final decision. */
  approverName?: string | null;
  approverRole?: string | null;
  decidedAt?: string | null;
}

export interface SupplierFileOptions {
  reference: string;
  statusLabel: string;
  supplier: {
    name: string;
    contactPerson?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    commercialRegister?: string | null;
    taxRegistration?: string | null;
    bankName?: string | null;
    bankAccountHolder?: string | null;
    bankAccountNumber?: string | null;
    iban?: string | null;
    swiftCode?: string | null;
    bankBranch?: string | null;
    suppliedItems?: string[] | null;
    brandNames?: string[] | null;
  };
  categories: SupplierFileCategory[];
  documents: SupplierFileDocument[];
  signature: SupplierFileSignature;
  /** Free-text decision reason / reviewer notes. */
  decisionReason?: string | null;
  /** ISO timestamp printed in the footer. */
  generatedAt: string;
}

/**
 * The verdict vocabulary lives in `review-routes.ts` (the writer). Importing it
 * here rather than re-declaring it is the difference between one rule and two
 * that drift: a second map silently stops labelling a value the reviewer sets.
 */
function verdictLabel(v: string | null | undefined): string {
  if (!v) return "لم يُفحص";
  return CATEGORY_VERDICT_LABELS[v as CategoryVerdict] ?? v;
}

function verdictColor(v: string | null | undefined): string {
  switch (v) {
    case "proven":
      return "#1a6b3c";
    case "partial":
      return "#8a6d1f";
    case "not_proven":
      return BRAND.red;
    case "needs_document":
      return "#8a6d1f";
    default:
      return "#6b7280";
  }
}

/** «2026-11-20T10:00:00Z» → «2026-11-20 10:00» (Latin digits, no locale drift). */
function stamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Locate a shipped asset from either layout: the bundle puts `assets/` beside
 * the compiled entry (`dist/assets`), while a source run keeps it at
 * `src/assets` — two levels up from `src/modules/supplier-review/`.
 */
function resolveAsset(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "assets", rel), resolve(here, "..", "..", "assets", rel)];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/** Normalise stored attachment content to bytes. */
function toBytes(content: Buffer | string | null | undefined): Buffer | null {
  if (!content) return null;
  if (Buffer.isBuffer(content)) return content;
  return Buffer.from(content, "base64");
}

/** Longest edge kept for an embedded attachment page. */
const MAX_IMAGE_EDGE = 1600;
/** JPEG quality for re-encoded attachments. */
const IMAGE_QUALITY = 72;

/**
 * Shrink an attachment before embedding it.
 *
 * A phone photograph of a commercial register is 3-4 MB; eight of them produce a
 * 25 MB PDF that mail servers reject and phones open slowly — and the operator
 * wants to send this file. Downscaling to 1600px keeps every field readable
 * (the page frame is ~500pt wide, so 1600px is well above print resolution)
 * while cutting the file by an order of magnitude.
 *
 * Only JPEG is re-encoded. Anything else is passed through untouched: guessing
 * at a PNG/HEIC's internal format risks corrupting the supplier's document, and
 * a corrupted evidence page is worse than a large one.
 */
function compressImage(buf: Buffer, mimeType: string): Buffer {
  if (!/^image\/jpe?g$/i.test(mimeType)) return buf;
  try {
    const raw = jpeg.decode(buf, { useTArray: true }) as {
      width: number;
      height: number;
      data: Uint8Array;
    };
    const longest = Math.max(raw.width, raw.height);
    if (longest <= MAX_IMAGE_EDGE) return buf;

    const scale = MAX_IMAGE_EDGE / longest;
    const w = Math.max(1, Math.round(raw.width * scale));
    const h = Math.max(1, Math.round(raw.height * scale));
    const out = new Uint8Array(w * h * 4);

    // Box-filter downscale: averaging the source pixels inside each destination
    // pixel keeps small print legible. Nearest-neighbour sampling would drop
    // thin strokes from Arabic text on a scanned card.
    const xRatio = raw.width / w;
    const yRatio = raw.height / h;
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y * yRatio);
      const y1 = Math.min(raw.height, Math.floor((y + 1) * yRatio));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * xRatio);
        const x1 = Math.min(raw.width, Math.floor((x + 1) * xRatio));
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let sy = y0; sy < y1; sy++) {
          for (let sx = x0; sx < x1; sx++) {
            const i = (sy * raw.width + sx) * 4;
            r += raw.data[i];
            g += raw.data[i + 1];
            b += raw.data[i + 2];
            n++;
          }
        }
        const o = (y * w + x) * 4;
        out[o] = n ? r / n : 0;
        out[o + 1] = n ? g / n : 0;
        out[o + 2] = n ? b / n : 0;
        out[o + 3] = 255;
      }
    }
    return Buffer.from(jpeg.encode({ data: out, width: w, height: h }, IMAGE_QUALITY).data);
  } catch {
    // A re-encode failure must fall back to the original bytes: a large page is
    // better than a blank one.
    return buf;
  }
}

export function generateSupplierFilePdf(opts: SupplierFileOptions): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        autoFirstPage: true,
        compress: false,
        bufferPages: true,
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

      // Noto Kufi is the identity font. A missing file must not lose the
      // document, so fall back to the built-in font rather than throwing.
      const kufi = resolveAsset("fonts/NotoKufiArabic-Regular.ttf");
      const kufiBold = resolveAsset("fonts/NotoKufiArabic-Bold.ttf");
      const hasKufi = existsSync(kufi);
      if (hasKufi) {
        doc.registerFont(BRAND_FONTS.arabic, kufi);
        if (existsSync(kufiBold)) doc.registerFont(BRAND_FONTS.arabicBold, kufiBold);
        doc.font(BRAND_FONTS.arabic);
      } else {
        doc.font("Helvetica");
      }
      const AR = hasKufi ? BRAND_FONTS.arabic : "Helvetica";
      const ARB = hasKufi && existsSync(kufiBold) ? BRAND_FONTS.arabicBold : AR;

      const PAGE_W = doc.page.width;
      const PAGE_H = doc.page.height;
      const M = 40;
      const CW = PAGE_W - M * 2;
      const logoPath = resolveAsset("logo.png");
      const hasLogo = existsSync(logoPath);

      // ── Cover ────────────────────────────────────────────────────────────
      // Maroon field, gold rule, logo on a light panel: on a dark background the
      // identity rules require the logo to sit on a light plate, never directly.
      const HDR_H = 132;
      doc.rect(0, 0, PAGE_W, HDR_H).fill(BRAND.maroon);
      doc.rect(0, HDR_H, PAGE_W, 4).fill(BRAND.gold);

      const panelX = M;
      const panelY = 22;
      const panelH = 86;
      doc.rect(panelX, panelY, 132, panelH).fill("#FFFFFF");
      if (hasLogo) {
        try {
          doc.image(logoPath, panelX + 12, panelY + 8, { fit: [108, 70], align: "center" });
        } catch {
          /* a logo that fails to draw must not lose the file */
        }
      }

      doc
        .font(BRAND_FONTS.latinBold)
        .fontSize(21)
        .fillColor("#FFFFFF")
        .text(COMPANY.nameEn, panelX + 150, panelY + 6, { width: CW - 150, align: "right" });
      doc
        .font(ARB)
        .fontSize(15)
        .fillColor(BRAND.sand)
        .text(rtl(COMPANY.display), panelX + 150, panelY + 34, {
          width: CW - 150,
          align: "right",
        });
      doc
        .font(AR)
        .fontSize(9)
        .fillColor("#E8D6C8")
        .text(`${COMPANY.city} — ${COMPANY.phone} — ${COMPANY.email}`, panelX + 150, panelY + 58, {
          width: CW - 150,
          align: "right",
        });

      // Document title band
      let y = HDR_H + 22;
      doc.font(ARB).fontSize(19).fillColor(BRAND.red);
      doc.text(rtl("ملف اعتماد مورد"), M, y, { width: CW, align: "center" });
      y += 28;
      doc.font(AR).fontSize(11).fillColor(BRAND.ink);
      doc.text(rtlLabelValue("رقم الطلب:", opts.reference), M, y, {
        width: CW,
        align: "center",
      });
      y += 20;

      // Verdict chip
      const verdictText = rtl(`الحالة: ${opts.statusLabel}`);
      doc.font(ARB).fontSize(11);
      const chipW = doc.widthOfString(verdictText) + 26;
      doc.roundedRect(PAGE_W / 2 - chipW / 2, y, chipW, 26, 13).fill(BRAND.red);
      doc.fillColor("#FFFFFF").text(verdictText, PAGE_W / 2 - chipW / 2, y + 8, {
        width: chipW,
        align: "center",
      });
      y += 44;

      // ── Section helper ───────────────────────────────────────────────────
      const sectionTitle = (title: string) => {
        if (y > PAGE_H - 120) {
          doc.addPage();
          y = 56;
        }
        doc.rect(M, y, 4, 18).fill(BRAND.red);
        doc.font(ARB).fontSize(12).fillColor(BRAND.red);
        doc.text(rtl(title), M + 10, y + 3, { width: CW - 10, align: "right" });
        y += 26;
        doc
          .moveTo(M, y - 6)
          .lineTo(PAGE_W - M, y - 6)
          .lineWidth(0.6)
          .strokeColor(BRAND.gold)
          .stroke();
      };

      /** A label/value row whose height follows the taller cell — never fixed. */
      const row = (label: string, value: string, opts2: { mono?: boolean } = {}) => {
        if (y > PAGE_H - 90) {
          doc.addPage();
          y = 56;
        }
        const labelW = 130;
        const valueW = CW - labelW - 12;
        doc.font(AR).fontSize(10);
        const labelText = rtl(label);
        const valueText = opts2.mono ? value : rtl(value);
        const h = Math.max(
          doc.heightOfString(labelText, { width: labelW }),
          doc.heightOfString(valueText, { width: valueW }),
        );
        doc.fillColor("#6b7280").text(labelText, M, y, { width: labelW, align: "right" });
        doc
          .fillColor(BRAND.ink)
          .font(opts2.mono ? BRAND_FONTS.latin : AR)
          .text(valueText, M + labelW + 12, y, { width: valueW, align: "right" });
        y += h + 6;
      };

      // ── Supplier data ────────────────────────────────────────────────────
      sectionTitle("بيانات المورد");
      const s = opts.supplier;
      row("اسم الشركة", s.name || "—");
      if (s.contactPerson) row("مسؤول التواصل", s.contactPerson);
      if (s.phone) row("الهاتف", s.phone, { mono: true });
      if (s.email) row("البريد الإلكتروني", s.email, { mono: true });
      if (s.address) row("العنوان", s.address);
      if (s.commercialRegister) row("رقم السجل التجاري", s.commercialRegister, { mono: true });
      if (s.taxRegistration) row("الرقم الضريبي", s.taxRegistration, { mono: true });
      if (s.bankName) row("البنك", s.bankName);
      if (s.bankBranch) row("الفرع", s.bankBranch);
      if (s.bankAccountHolder) row("صاحب الحساب", s.bankAccountHolder);
      if (s.bankAccountNumber) row("رقم الحساب", s.bankAccountNumber, { mono: true });
      if (s.iban) row("IBAN", s.iban, { mono: true });
      if (s.swiftCode) row("SWIFT", s.swiftCode, { mono: true });
      if (s.suppliedItems?.length) row("البنود المورَّدة", s.suppliedItems.join("، "));
      if (s.brandNames?.length) row("الماركات", s.brandNames.join("، "));
      y += 6;

      // ── Categories with verdicts ─────────────────────────────────────────
      if (opts.categories.length) {
        sectionTitle("التصنيفات وحكم المراجع");
        const colW = [CW * 0.34, CW * 0.22, CW * 0.26, CW * 0.18];
        const headerY = y;
        doc.font(ARB).fontSize(9).fillColor("#FFFFFF");
        doc.rect(M, headerY, CW, 20).fill(BRAND.maroon);
        const headers = ["التصنيف", "الحكم", "المسؤول", "ملاحظة"];
        let cx = PAGE_W - M;
        headers.forEach((h, i) => {
          cx -= colW[i];
          doc.fillColor("#FFFFFF").text(rtl(h), cx, headerY + 6, {
            width: colW[i] - 8,
            align: "right",
          });
        });
        y = headerY + 22;
        opts.categories.forEach((c, idx) => {
          if (y > PAGE_H - 80) {
            doc.addPage();
            y = 56;
          }
          doc.font(AR).fontSize(9);
          const cells = [c.name, verdictLabel(c.verdict), c.owner || "—", c.note || "—"];
          const heights = cells.map((t, i) => doc.heightOfString(rtl(t), { width: colW[i] - 8 }));
          const h = Math.max(...heights, 12) + 8;
          if (idx % 2 === 1) doc.rect(M, y - 2, CW, h).fill(BRAND.page);
          let rx = PAGE_W - M;
          cells.forEach((t, i) => {
            rx -= colW[i];
            const color = i === 1 ? verdictColor(c.verdict) : BRAND.ink;
            doc
              .fillColor(color)
              .font(i === 1 ? ARB : AR)
              .text(rtl(t), rx, y + 2, { width: colW[i] - 8, align: "right" });
          });
          y += h;
        });
        y += 8;
      }

      // ── Reviewer notes ───────────────────────────────────────────────────
      if (opts.decisionReason?.trim()) {
        sectionTitle("ملاحظات المراجعة");
        doc.font(AR).fontSize(10).fillColor(BRAND.ink);
        const noteText = rtl(opts.decisionReason.trim());
        const h = doc.heightOfString(noteText, { width: CW - 24 });
        if (y + h > PAGE_H - 120) {
          doc.addPage();
          y = 56;
        }
        doc.rect(M, y, CW, h + 20).fill(BRAND.beige);
        doc.fillColor(BRAND.ink).text(noteText, M + 12, y + 10, { width: CW - 24 });
        y += h + 30;
      }

      // ── Signature block ──────────────────────────────────────────────────
      if (y > PAGE_H - 210) {
        doc.addPage();
        y = 56;
      }
      sectionTitle("التوقيع والاعتماد");
      const boxW = (CW - 16) / 2;
      const boxH = 108;
      const drawBox = (
        x: number,
        title: string,
        name?: string | null,
        role?: string | null,
        at?: string | null,
      ) => {
        doc.roundedRect(x, y, boxW, boxH, 6).lineWidth(0.8).strokeColor(BRAND.gold).stroke();
        doc.font(ARB).fontSize(10).fillColor(BRAND.red);
        doc.text(rtl(title), x + 10, y + 10, { width: boxW - 20, align: "right" });
        doc
          .moveTo(x + 14, y + 46)
          .lineTo(x + boxW - 14, y + 46)
          .lineWidth(0.5)
          .strokeColor("#c9c2bd")
          .stroke();
        doc.font(AR).fontSize(9).fillColor("#6b7280");
        doc.text(rtl("التوقيع"), x + 10, y + 50, { width: boxW - 20, align: "right" });
        doc.font(ARB).fontSize(10).fillColor(BRAND.ink);
        doc.text(rtl(name || "—"), x + 10, y + 66, { width: boxW - 20, align: "right" });
        doc.font(AR).fontSize(8.5).fillColor("#6b7280");
        const meta = [role, stamp(at)].filter(Boolean).join(" — ");
        doc.text(rtl(meta), x + 10, y + 82, { width: boxW - 20, align: "right" });
      };
      drawBox(
        M,
        "المراجع (الفحص)",
        opts.signature.verifierName,
        opts.signature.verifierRole,
        opts.signature.verifiedAt,
      );
      drawBox(
        M + boxW + 16,
        "المعتمِد (القرار)",
        opts.signature.approverName,
        opts.signature.approverRole,
        opts.signature.decidedAt,
      );
      y += boxH + 16;

      // ── Attachments ──────────────────────────────────────────────────────
      doc.addPage();
      y = 56;
      doc.font(ARB).fontSize(15).fillColor(BRAND.red);
      doc.text(rtl("المرفقات"), M, y, { width: CW, align: "center" });
      y += 24;
      doc
        .moveTo(M, y)
        .lineTo(PAGE_W - M, y)
        .lineWidth(1)
        .strokeColor(BRAND.gold)
        .stroke();
      y += 14;
      doc.font(AR).fontSize(9.5).fillColor("#6b7280");
      doc.text(rtl(`عدد المرفقات: ${opts.documents.length}`), M, y, { width: CW, align: "center" });
      y += 24;

      const footerOn = (pageDoc: typeof doc) => {
        pageDoc
          .font(AR)
          .fontSize(8)
          .fillColor("#8a8a8a")
          .text(
            rtlLabelValue("ملف اعتماد المورد — تم الإنشاء في", stamp(opts.generatedAt)),
            M,
            PAGE_H - 34,
            { width: CW, align: "center", lineBreak: false },
          );
      };

      opts.documents.forEach((d, i) => {
        doc.addPage();
        const top = 52;
        doc.font(ARB).fontSize(12).fillColor(BRAND.red);
        doc.text(rtl(`${i + 1}. ${d.label}`), M, top, { width: CW, align: "right" });
        doc.font(AR).fontSize(8.5).fillColor("#6b7280");
        doc.text(`${d.originalName} — ${d.mimeType} — ${bytes(d.sizeBytes)}`, M, top + 18, {
          width: CW,
          align: "right",
        });
        const frameY = top + 40;
        const frameH = PAGE_H - frameY - 54;
        doc.rect(M, frameY, CW, frameH).lineWidth(0.8).strokeColor(BRAND.sand).stroke();

        const bytesOf = toBytes(d.content);
        const isImage = /^image\//.test(d.mimeType) && bytesOf && bytesOf.length > 0;
        if (isImage) {
          try {
            doc.image(compressImage(bytesOf as Buffer, d.mimeType), M + 8, frameY + 8, {
              fit: [CW - 16, frameH - 16],
              align: "center",
              valign: "center",
            });
          } catch {
            doc.font(AR).fontSize(11).fillColor(BRAND.red);
            doc.text(rtl("تعذّر عرض صورة المستند"), M, frameY + frameH / 2, {
              width: CW,
              align: "center",
            });
          }
        } else {
          // A non-image attachment is reproduced by its identity, and the file
          // says so. Silently omitting it would make an "approved" file claim a
          // document set it does not contain.
          doc.font(AR).fontSize(11).fillColor(BRAND.ink);
          doc.text(
            rtl("هذا المرفق ليس صورة، ولا يمكن ضمه كصفحة مصوّرة."),
            M + 16,
            frameY + frameH / 2 - 24,
            { width: CW - 32, align: "center" },
          );
          doc.font(AR).fontSize(9.5).fillColor("#6b7280");
          doc.text(
            rtl(`الملف: ${d.originalName} (${d.mimeType}, ${bytes(d.sizeBytes)})`),
            M + 16,
            frameY + frameH / 2 + 4,
            { width: CW - 32, align: "center" },
          );
          doc
            .font(AR)
            .fontSize(9)
            .fillColor("#6b7280")
            .text(
              rtl("الملف الأصلي محفوظ في النظام ويمكن تنزيله."),
              M + 16,
              frameY + frameH / 2 + 26,
              {
                width: CW - 32,
                align: "center",
              },
            );
        }
        footerOn(doc);
      });

      // Number every page once the total is known — a page with no identity
      // cannot be attributed to a file or a column.
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc
          .font(BRAND_FONTS.latin)
          .fontSize(7.5)
          .fillColor("#9a9a9a")
          .text(`Page ${i + 1} / ${range.count}`, PAGE_W - M - 90, PAGE_H - 20, {
            width: 90,
            align: "right",
            lineBreak: false,
          });
      }

      doc.flushPages();
      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Exported for tests: the identity's own verdict wording. */
export { verdictLabel, verdictColor, hasArabic };

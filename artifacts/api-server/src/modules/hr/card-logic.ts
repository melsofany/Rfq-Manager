/**
 * Employee ID cards — بطاقات الموظفين.
 *
 * A card has two sides, front and back. Each side is an HTML template stored in Settings
 * (card_front / card_back). HR can upload their own design; placeholders such as {{fullName}}
 * are replaced with the employee's data. If no design is uploaded, a built-in default is used.
 */

export const CARD_PLACEHOLDERS = [
  "fullName",
  "nationalId",
  "employeeNo",
  "jobTitle",
  "department",
  "hireDate",
  "photo",
  "managerName",
  "managerSignature",
  "validUntil",
] as const;
export type CardPlaceholder = (typeof CARD_PLACEHOLDERS)[number];

export const CARD_MAX_HTML_CHARS = 300_000;

// 1×1 transparent PNG, used when an employee has no photo yet.
export const BLANK_PHOTO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export const DEFAULT_CARD_FRONT = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
@page { size: 85.6mm 54mm; margin: 0; }
html, body { margin: 0; padding: 0; }
.card { width: 85.6mm; height: 54mm; box-sizing: border-box; padding: 4mm; font-family: Arial, sans-serif; background: #fff; color: #111; border: 0.3mm solid #1f4e79; display: flex; gap: 3mm; align-items: center; }
.photo { width: 22mm; height: 28mm; object-fit: cover; border: 0.2mm solid #999; }
.info { flex: 1; }
.name { font-size: 4.2mm; font-weight: bold; margin-bottom: 1.5mm; }
.row { font-size: 2.8mm; margin: 0.8mm 0; }
.label { color: #555; }
</style></head>
<body><div class="card">
<img class="photo" src="{{photo}}" alt="">
<div class="info">
<div class="name">{{fullName}}</div>
<div class="row"><span class="label">الرقم الوظيفي: </span>{{employeeNo}}</div>
<div class="row"><span class="label">الوظيفة: </span>{{jobTitle}}</div>
<div class="row"><span class="label">الإدارة: </span>{{department}}</div>
<div class="row"><span class="label">تاريخ التعيين: </span>{{hireDate}}</div>
</div></div></body></html>`;

export const DEFAULT_CARD_BACK = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
@page { size: 85.6mm 54mm; margin: 0; }
html, body { margin: 0; padding: 0; }
.card { width: 85.6mm; height: 54mm; box-sizing: border-box; padding: 4mm; font-family: Arial, sans-serif; background: #fff; color: #111; border: 0.3mm solid #1f4e79; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
.text { font-size: 3mm; line-height: 1.5; }
</style></head>
<body><div class="card">
<div class="text">هذه البطاقة ملك الشركة، وتُسلم عند انتهاء الخدمة.</div>
</div></body></html>`;

export function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface CardData {
  fullName: string;
  nationalId: string | null;
  employeeNo: string;
  jobTitle: string | null;
  department: string | null;
  hireDate: string | null;
  photo: string | null;
  managerName: string;
  managerSignature: string | null;
  /** Text shown for "valid until": a formatted date, "غير محدد" for open-ended contracts, or null. */
  validUntil: string | null;
}

/** Replace every {{placeholder}} in the template with the escaped employee value. */
export function renderCardHtml(template: string, data: CardData): string {
  const values: Record<CardPlaceholder, string> = {
    fullName: escapeHtml(data.fullName),
    nationalId: escapeHtml(data.nationalId ?? ""),
    employeeNo: escapeHtml(data.employeeNo),
    jobTitle: escapeHtml(data.jobTitle ?? ""),
    department: escapeHtml(data.department ?? ""),
    hireDate: escapeHtml(data.hireDate ?? ""),
    // Photo is a data URL we built ourselves (or a blank image); it is placed in src="" only.
    photo: data.photo ?? BLANK_PHOTO,
    managerName: escapeHtml(data.managerName),
    // Signature is a validated image data URL (see validateCardManager); it is placed in src="" only.
    managerSignature: data.managerSignature ?? BLANK_PHOTO,
    validUntil: escapeHtml(data.validUntil ?? ""),
  };
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, key: string) =>
    (CARD_PLACEHOLDERS as readonly string[]).includes(key) ? values[key as CardPlaceholder] : match,
  );
}

type Result = { error: string } | { value: { html: string } | null };

/** A card side is either unset (null) or { html } with a non-empty page that contains no scripts. */
export function validateCardTemplate(v: unknown): Result {
  if (v === null || v === undefined) return { value: null };
  if (typeof v !== "object" || Array.isArray(v)) return { error: "ملف التصميم غير صالح" };
  const html = (v as { html?: unknown }).html;
  if (typeof html !== "string" || !html.trim()) return { error: "ملف التصميم فاضي" };
  if (html.length > CARD_MAX_HTML_CHARS)
    return { error: "ملف التصميم كبير أوي (الحد 300 ألف حرف)" };
  if (/<script[\s>]/i.test(html) || /\son[a-z]+\s*=/i.test(html))
    return { error: "شيل أي كود JavaScript من التصميم (script أو on...) قبل الرفع" };
  return { value: { html } };
}

export const CARD_MANAGER_SIGNATURE_MAX_CHARS = 300_000;
const SIGNATURE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * General manager shown on every card: { name, signature }. Signature is an optional image data URL.
 * Both fields may be null (name blank, signature blank image).
 */
type ManagerResult =
  { error: string } | { value: { name: string; signature: string | null } | null };

export function validateCardManager(v: unknown): ManagerResult {
  if (v === null || v === undefined) return { value: null };
  if (typeof v !== "object" || Array.isArray(v)) return { error: "بيانات المدير غير صالحة" };
  const { name, signature } = v as { name?: unknown; signature?: unknown };
  const cleanName = typeof name === "string" ? name.trim() : "";
  if (cleanName.length > 100) return { error: "اسم المدير طويل أوي (الحد 100 حرف)" };
  if (signature !== null && signature !== undefined) {
    if (typeof signature !== "string" || !SIGNATURE_RE.test(signature))
      return { error: "التوقيع لازم يكون صورة PNG أو JPG أو WebP" };
    if (signature.length > CARD_MANAGER_SIGNATURE_MAX_CHARS)
      return { error: "صورة التوقيع كبيرة أوي (الحد حوالي 200 كيلوبايت)" };
  }
  return {
    value: { name: cleanName, signature: typeof signature === "string" ? signature : null },
  };
}

/** Uploaded designs are drawn at 1060px wide (see CARD_DESIGN_WIDTH). */
export const CARD_DESIGN_WIDTH = 1060;
const CARD_DESIGN_HEIGHT = 668.6916;

/** Fixed print frame: 85.6 × 54 mm ≈ 323.5 × 204 px. */
export const PRINT_CARD_SIZE = { scale: 0.3052, width: 323.5, height: 204 } as const;

export interface CardFrameSize {
  scale: number;
  width: number;
  height: number;
}

/** On-screen preview size for a given frame width in px, clamped to 240–517 px. */
export function previewCardSize(width: number): CardFrameSize {
  const w = Math.round(Math.min(517, Math.max(240, width)));
  return {
    scale: w / CARD_DESIGN_WIDTH,
    width: w,
    height: Math.round((w * CARD_DESIGN_HEIGHT) / CARD_DESIGN_WIDTH),
  };
}

/**
 * Put an uploaded design into a fixed frame and scale its .card to fit, from the top-left corner.
 * The frame is a wrapper div (not zoom) so right-to-left layout doesn't shift the card.
 */
export function scaleForPrint(html: string, size: CardFrameSize = PRINT_CARD_SIZE): string {
  const { scale, width, height } = size;
  const style =
    "<style>html,body{margin:0!important;padding:0!important;background:#fff!important}" +
    `.hr-card-frame{width:${width}px;height:${height}px;overflow:hidden;position:relative}` +
    `.hr-card-frame .card{position:absolute!important;left:0!important;top:0!important;margin:0!important;transform:scale(${scale});transform-origin:0 0}` +
    "</style>";
  let out = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${style}</head>`) : style + html;
  out = out.replace(/<body([^>]*)>/i, '<body$1><div class="hr-card-frame">');
  out = out.replace(/<\/body>/i, "</div></body>");
  return out;
}

/** "2026-12-31" → "31/12/2026". Returns null for anything that isn't a YYYY-MM-DD date. */
export function formatCardDate(ymd: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/**
 * Stop mobile browsers from turning numbers and addresses into blue links on the printed/previewed card.
 */
export function withoutAutoLinks(html: string): string {
  const meta = '<meta name="format-detection" content="telephone=no,email=no,address=no,date=no">';
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head([^>]*)>/i, `<head$1>${meta}`)
    : meta + html;
}

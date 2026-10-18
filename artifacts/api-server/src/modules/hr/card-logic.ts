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

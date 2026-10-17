/** Pure validation for hiring: national ID, IBAN, account, contract dates and salary. */

export const CONTRACT_TYPES = ["indefinite", "fixed", "probation", "part_time"] as const;

/** Egyptian national ID: exactly 14 digits. */
export function isValidNationalId(v: string): boolean {
  return /^\d{14}$/.test(v);
}

/**
 * Birth date (YYYY-MM-DD) read from an Egyptian national ID:
 * digit 1 = century (2 → 1900s, 3 → 2000s), digits 2–3 = year, 4–5 = month, 6–7 = day.
 * Returns null when the ID is malformed or the encoded date does not exist.
 */
export function birthDateFromNationalId(v: string): string | null {
  if (!isValidNationalId(v)) return null;
  const century = v[0] === "2" ? 1900 : v[0] === "3" ? 2000 : null;
  if (century === null) return null;
  const year = century + Number(v.slice(1, 3));
  const month = Number(v.slice(3, 5));
  const day = Number(v.slice(5, 7));
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Egyptian IBAN: "EG" + 27 digits (29 characters). */
export function isValidEgyptianIban(v: string): boolean {
  return /^EG\d{27}$/.test(v.replace(/\s+/g, "").toUpperCase());
}

/** Bank account number: 6–30 digits. */
export function isValidAccountNo(v: string): boolean {
  return /^\d{6,30}$/.test(v.replace(/[\s-]/g, ""));
}

export function normalizeAccountNo(v: string): string {
  return v.replace(/[\s-]/g, "");
}

export function normalizeIban(v: string): string {
  return v.replace(/\s+/g, "").toUpperCase();
}

/** Contract dates: fixed needs end after start; probation needs a probation end inside the contract. */
export function contractDatesError(
  type: string,
  startDate: string,
  endDate: string | null,
  probationEndDate: string | null,
): string | null {
  if (type === "fixed") {
    if (!endDate) return "العقد محدد المدة يحتاج تاريخ انتهاء";
    if (endDate <= startDate) return "تاريخ انتهاء العقد لازم يكون بعد تاريخ البداية";
  }
  if (type === "probation") {
    if (!probationEndDate) return "عقد التجربة يحتاج تاريخ انتهاء فترة التجربة";
    if (probationEndDate < startDate) return "فترة التجربة لا يمكن أن تنتهي قبل بدء العقد";
    if (endDate && probationEndDate > endDate) return "فترة التجربة لا يمكن أن تتجاوز مدة العقد";
  }
  return null;
}

/** Salary: non-negative with at most two decimals. */
export function isValidSalary(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && Math.round(v * 100) === v * 100;
}

/** Employee photo: JPEG, PNG or WebP as a base64 data URL, at most 300 KB. */
export const PHOTO_MAX_BYTES = 300 * 1024;
const PHOTO_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export type ParsedPhoto = { mime: string; data: string };

/** Returns null when no photo was sent, an Arabic error, or the parsed photo. */
export function parsePhoto(v: unknown): { error: string } | { photo: ParsedPhoto } | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return { error: "صيغة الصورة غير صالحة" };
  const m = PHOTO_RE.exec(v);
  if (!m) return { error: "الصورة لازم تكون JPEG أو PNG أو WebP" };
  const data = m[2];
  if (data.length % 4 !== 0) return { error: "الصورة غير صالحة" };
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const bytes = (data.length / 4) * 3 - padding;
  if (bytes > PHOTO_MAX_BYTES) return { error: "حجم الصورة يتجاوز 300 KB" };
  return { photo: { mime: m[1], data } };
}

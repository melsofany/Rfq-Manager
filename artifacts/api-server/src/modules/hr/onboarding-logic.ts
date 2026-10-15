/** Pure validation for hiring: national ID, IBAN, account, contract dates and salary. */

export const CONTRACT_TYPES = ["indefinite", "fixed", "probation", "part_time"] as const;

/** Egyptian national ID: exactly 14 digits. */
export function isValidNationalId(v: string): boolean {
  return /^\d{14}$/.test(v);
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

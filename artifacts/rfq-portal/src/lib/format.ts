/**
 * Formatting helpers for money / numeric values coming from the API.
 *
 * The accounting endpoints return NUMERIC columns as strings ("1234.5000") and
 * the screens repeatedly parse + localise them. Centralising the rules here
 * keeps every tab consistent: two decimals, Arabic-Indic grouping, and a dash
 * for absent values.
 */

/** Format a money value (string | number) as `1,234.50`, "-" when absent. */
export function money(v: string | number | null | undefined): string {
  if (v == null || v === "") return "-";
  const n = typeof v === "number" ? v : Number(v);
  if (!isFinite(n)) return "-";
  return n.toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Same as `money` but for numeric callers that already hold a number. */
export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "-";
  return n.toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const AR_MONTHS = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

/** Format a YYYY-MM period as "سبتمبر 2026". */
export function periodLabel(period: string): string {
  const [y, m] = period.split("-");
  return `${AR_MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/**
 * Formatting helpers for money / numeric values coming from the API.
 *
 * The accounting endpoints return NUMERIC columns as strings ("1234.5000") and
 * the screens repeatedly parse + localise them. Centralising the rules here
 * keeps every tab consistent: two decimals, thousands grouping, and a dash for
 * absent values.
 *
 * Digits are deliberately Latin (en-US, not ar-EG): accountants read, key and
 * compare these figures against bank/e-invoice statements, so ١٬٢٣٤٫٥٠ would
 * fight the source documents. Arabic stays for labels, English for the numbers.
 */

/** Format a money value (string | number) as `1,234.50`, "-" when absent. */
export function money(v: string | number | null | undefined): string {
  if (v == null || v === "") return "-";
  const n = typeof v === "number" ? v : Number(v);
  if (!isFinite(n)) return "-";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Same as `money` but for numeric callers that already hold a number. */
export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "-";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

/**
 * Format a clock time as 12-hour `hh:mm AM/PM` (Latin digits, en-US).
 *
 * Accepts either a full timestamp ("2026-10-16 09:05:00") or a bare "HH:MM".
 * Uses fixed AM/PM markers rather than `toLocaleTimeString` so the output is
 * identical regardless of the browser locale — operators compare these times
 * against the device and the shift table.
 */
export function clockTime(v: string | null | undefined): string {
  if (v == null || v === "") return "—";
  const m = /(?:^|\s|T)(\d{1,2}):(\d{2})/.exec(v);
  if (!m) return "—";
  const h = Number(m[1]);
  if (h > 23) return "—";
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

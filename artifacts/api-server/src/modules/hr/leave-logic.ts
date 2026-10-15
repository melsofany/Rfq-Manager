/** Pure leave rules — kept free of DB access so they can be unit-tested. */

const DAY_MS = 86_400_000;

function toUtc(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Inclusive calendar-day count between two YYYY-MM-DD dates; 0 if end < start. */
export function inclusiveDays(startYmd: string, endYmd: string): number {
  const diff = Math.round((toUtc(endYmd) - toUtc(startYmd)) / DAY_MS);
  return diff < 0 ? 0 : diff + 1;
}

/** Two inclusive date ranges overlap? */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** Remaining annual balance; never negative. */
export function remainingBalance(annualDays: number, usedDays: number): number {
  return Math.max(0, annualDays - usedDays);
}

export function isValidYmd(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = toUtc(s);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** Days in a range that fall inside a given calendar year. */
export function daysInYear(startYmd: string, endYmd: string, year: number): number {
  const ys = `${year}-01-01`;
  const ye = `${year}-12-31`;
  const s = startYmd > ys ? startYmd : ys;
  const e = endYmd < ye ? endYmd : ye;
  return inclusiveDays(s, e);
}

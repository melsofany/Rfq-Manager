/**
 * Date integrity for the free-text date columns.
 *
 * Measured on production: `customer_rfqs.expiry_date` holds 54 values and
 * `entry_date` 31 — 85 in total — shaped `2025-17-09`, `2025-20-09`, … i.e. the
 * DAY and MONTH are swapped. `2025-17-09` means 17 September. They were written
 * before any validation existed (`POST /customer-rfq` stored `r.entryDate`
 * verbatim), and they are not cosmetic:
 *
 *   SELECT count(*) FROM customer_rfqs WHERE expiry_date::date >= '2025-01-01';
 *   -- ERROR: date/time field value out of range: "2025-17-09"
 *
 * A single malformed row makes a WHOLE query throw, so any report that touches
 * those columns fails rather than returning a slightly-off number. That is a
 * capability reporting an error where it should report data — the failure the
 * operator experiences as «يفشل».
 *
 * Two halves, both needed:
 *   1. `normalizeIsoDate` at WRITE time, so no new bad value enters.
 *   2. A repair of the existing rows (init-db.ts), because the guard alone
 *      leaves the 85 that are already there throwing every query.
 */

/** Shape of a value we consider a real ISO date: YYYY-MM-DD. */
const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const max = DAYS_IN_MONTH[m - 1];
  if (d > max) return false;
  if (m === 2 && d === 29) {
    // Leap year: divisible by 4, except centuries not divisible by 400.
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }
  return true;
}

/**
 * The canonical `YYYY-MM-DD` form of a date the operator entered, or `null` if
 * it is not a date at all.
 *
 * Handles the swap that production actually contains: when the MONTH is out of
 * range but the DAY would be a valid month, the two are exchanged
 * (`2025-17-09` → `2025-09-17`). This is unambiguous — there is no year in which
 * a 17th month exists — so it is a repair, not a guess.
 *
 * A value that cannot be read as a date returns `null`. The caller decides
 * whether that means "reject the write" or "store nothing": inventing a date
 * would be worse than storing none, because a wrong date silently mis-sorts
 * every report that uses it.
 */
export function normalizeIsoDate(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // Accept `2025/09/17` and `17-09-2025` only when the reading is unambiguous.
  const m = raw.match(ISO_RE);
  if (m) {
    const y = Number(m[1]);
    let mo = Number(m[2]);
    let d = Number(m[3]);
    if (isRealDate(y, mo, d)) {
      return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    // The swap: a month above 12 cannot be a month, but can be a day.
    if (mo > 12 && mo <= 31 && d <= 12) {
      const swappedMonth = d;
      const swappedDay = mo;
      if (isRealDate(y, swappedMonth, swappedDay)) {
        return `${m[1]}-${String(swappedMonth).padStart(2, "0")}-${String(swappedDay).padStart(2, "0")}`;
      }
    }
    return null;
  }

  // Anything else (a natural-language date, an empty cell) is not stored as a
  // date column value. `Date` is not used here on purpose: `new Date("17/09/2025")`
  // resolves by runtime locale, which makes the same input store differently on
  // two machines.
  return null;
}

/** True when the stored value is a date PostgreSQL can cast (`::date`). */
export function isCastableDate(input: unknown): boolean {
  const raw = input === null || input === undefined ? "" : String(input).trim();
  if (!raw) return false;
  const m = raw.match(ISO_RE);
  if (!m) return false;
  return isRealDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

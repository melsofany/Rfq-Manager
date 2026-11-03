// Quotation validity date.
//
// The operator's rule: the offer is valid for a period stated in the terms
// ("صلاحية أسبوع", "10 أيام", "شهر"…) counted from the day the offer is SENT.
// When the terms state no period at all, a one-week default applies.
//
// Pure (no database, no request) so the rule is unit-testable on its own, and
// so the same answer can be reused by the PDF and the WhatsApp message.

/** Fallback when the terms state no validity period. */
export const DEFAULT_VALIDITY_DAYS = 7;

const AR_DIGITS: Record<string, string> = {
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
  "۰": "0",
  "۱": "1",
  "۲": "2",
  "۳": "3",
  "۴": "4",
  "۵": "5",
  "۶": "6",
  "۷": "7",
  "۸": "8",
  "۹": "9",
};

function toLatinDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (c) => AR_DIGITS[c] ?? c);
}

/**
 * Folds the Arabic spelling variants that would otherwise hide a duration word
 * («إسبوع» vs «اسبوع», «سنه» vs «سنة»). Same normalisation family used elsewhere
 * in the codebase for Arabic matching.
 */
function normalizeArabic(text: string): string {
  return text
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/\u0640/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

/** Days contributed by one unit word (after normalisation). */
const AR_UNIT_DAYS: Record<string, number> = {
  يوم: 1,
  ايام: 1,
  اسبوع: 7,
  اسابيع: 7,
  شهر: 30,
  اشهر: 30,
  شهور: 30,
  سنه: 365,
  سنوات: 365,
};

/** Dual forms carry their own number («أسبوعين» = two weeks). */
const AR_DUAL_DAYS: Record<string, number> = {
  يومين: 2,
  اسبوعين: 14,
  شهرين: 60,
  سنتين: 730,
};

const EN_UNIT_DAYS: Record<string, number> = {
  day: 1,
  days: 1,
  week: 7,
  weeks: 7,
  month: 30,
  months: 30,
  year: 365,
  years: 365,
};

export interface ValidityPeriod {
  days: number;
  /** Whether the period came from the operator's terms or from the default. */
  source: "terms" | "default";
}

function tokensOf(text: string): string[] {
  return toLatinDigits(normalizeArabic(text).toLowerCase())
    .split(/[^0-9a-z\u0600-\u06FF]+/)
    .filter(Boolean);
}

function isNumber(token: string): boolean {
  return /^\d+$/.test(token);
}

/**
 * Reads the validity period from the operator's terms.
 *
 * Explicit numbers win over bare unit words: "أسبوع" alone is one week, but
 * "10 أيام" in the same terms must not be reduced to the vague word.
 */
export function validityPeriodFromTerms(terms: string[]): ValidityPeriod {
  const tokens = tokensOf(terms.filter(Boolean).join(" \n "));

  // Pass 1 — an explicit number next to a unit ("10 أيام", "weeks 2").
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (isNumber(a) && AR_UNIT_DAYS[b])
      return { days: Number(a) * AR_UNIT_DAYS[b], source: "terms" };
    if (isNumber(b) && AR_UNIT_DAYS[a])
      return { days: Number(b) * AR_UNIT_DAYS[a], source: "terms" };
    if (isNumber(a) && EN_UNIT_DAYS[b])
      return { days: Number(a) * EN_UNIT_DAYS[b], source: "terms" };
    if (isNumber(b) && EN_UNIT_DAYS[a])
      return { days: Number(b) * EN_UNIT_DAYS[a], source: "terms" };
  }

  // Pass 2 — dual forms that already carry the number.
  for (const t of tokens) {
    if (AR_DUAL_DAYS[t]) return { days: AR_DUAL_DAYS[t], source: "terms" };
  }

  // Pass 3 — a bare unit word ("صلاحية أسبوع").
  for (const t of tokens) {
    if (AR_UNIT_DAYS[t]) return { days: AR_UNIT_DAYS[t], source: "terms" };
    if (EN_UNIT_DAYS[t]) return { days: EN_UNIT_DAYS[t], source: "terms" };
  }

  return { days: DEFAULT_VALIDITY_DAYS, source: "default" };
}

function toIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local calendar day of `now` as YYYY-MM-DD (never the UTC day — Cairo is +2/+3). */
export function todayIso(now: Date = new Date()): string {
  return toIso(now);
}

/** Adds whole days to a YYYY-MM-DD date, staying on local calendar days. */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return toIso(dt);
}

/**
 * The «صالح حتى» date: the send day plus the period stated in the terms, or the
 * default week when the terms state none.
 */
export function computeValidityDate(sendDate: Date | string, terms: string[]): string {
  const base = typeof sendDate === "string" ? sendDate.slice(0, 10) : todayIso(sendDate);
  const { days } = validityPeriodFromTerms(terms);
  return addDaysIso(base, days);
}

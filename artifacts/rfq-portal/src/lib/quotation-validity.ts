// Quotation validity date — the browser-side twin of the server rule in
// `artifacts/api-server/src/modules/customer-rfq/quotation-validity.ts`.
//
// It exists so the print page can PREVIEW the same «صالح حتى» date the server
// will stamp on the PDF and put in the WhatsApp message. The server remains the
// authority (it recomputes on download/send); this copy only avoids showing the
// operator a date that differs from what the customer receives.
//
// Keep the two implementations in step — the rules are pinned by tests on the
// server side.

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

function tokensOf(text: string): string[] {
  return toLatinDigits(normalizeArabic(text).toLowerCase())
    .split(/[^0-9a-z\u0600-\u06FF]+/)
    .filter(Boolean);
}

function isNumber(token: string): boolean {
  return /^\d+$/.test(token);
}

/** Days of validity stated in the terms, or the one-week default. */
export function validityPeriodDays(terms: string[]): number {
  const tokens = tokensOf(terms.filter(Boolean).join(" \n "));

  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (isNumber(a) && AR_UNIT_DAYS[b]) return Number(a) * AR_UNIT_DAYS[b];
    if (isNumber(b) && AR_UNIT_DAYS[a]) return Number(b) * AR_UNIT_DAYS[a];
    if (isNumber(a) && EN_UNIT_DAYS[b]) return Number(a) * EN_UNIT_DAYS[b];
    if (isNumber(b) && EN_UNIT_DAYS[a]) return Number(b) * EN_UNIT_DAYS[a];
  }
  for (const t of tokens) if (AR_DUAL_DAYS[t]) return AR_DUAL_DAYS[t];
  for (const t of tokens) {
    if (AR_UNIT_DAYS[t]) return AR_UNIT_DAYS[t];
    if (EN_UNIT_DAYS[t]) return EN_UNIT_DAYS[t];
  }
  return DEFAULT_VALIDITY_DAYS;
}

function toIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The «صالح حتى» date: the issue day plus the period stated in the terms. */
export function computeValidityDate(sendDate: Date, terms: string[]): string {
  const dt = new Date(sendDate.getFullYear(), sendDate.getMonth(), sendDate.getDate());
  dt.setDate(dt.getDate() + validityPeriodDays(terms));
  return toIso(dt);
}

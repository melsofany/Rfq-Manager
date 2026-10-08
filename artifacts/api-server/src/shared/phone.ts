/**
 * WhatsApp / SMS phone normalisation, shared by every send path.
 *
 * Suppliers often store more than one number in the phone field, separated by
 * `/`, `,`, `;`, `|`, or the word «أو»/«or». Live (RFQ CRQ-2026-000256) the whole
 * string `201147498505/201006110550` was handed to the WhatsApp API, which
 * rejected it with code 131009 on every template attempt. One normaliser, used
 * everywhere, makes that impossible to reintroduce on one path and not another.
 */

const INVISIBLE_MARKS = /[⁦⁧⁨⁩‎‏‪‫‬‭‮]/g;

/** Split a raw phone field into its candidate numbers, in the order written. */
export function splitPhoneCandidates(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(INVISIBLE_MARKS, "")
    .split(/[\/,;|]|\s+or\s+|\s+أو\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Normalise ONE number to digits in international form (Egypt: 20…). */
export function normalizeSinglePhone(raw: string): string {
  let cleaned = raw
    .replace(INVISIBLE_MARKS, "")
    .replace(/[\s\-()\.]/g, "")
    .replace(/\+/g, "");
  if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);
  if (cleaned.length === 11 && cleaned.startsWith("0")) cleaned = "2" + cleaned;
  if (cleaned.length === 10 && cleaned.startsWith("1")) cleaned = "20" + cleaned;
  return cleaned;
}

/** A number WhatsApp can address: digits only, E.164-sized. */
export function isSendablePhone(normalized: string): boolean {
  return /^\d{10,15}$/.test(normalized);
}

export interface SendablePhone {
  /** The number to send to, or null when no candidate is sendable. */
  phone: string | null;
  /** Other numbers present in the field that were NOT used. */
  ignored: string[];
}

/**
 * Pick the number to send to from a raw phone field.
 *
 * The first sendable candidate wins (suppliers list their primary line first).
 * The rest are reported so the caller can log them — a silent drop would hide a
 * second contact the operator may need.
 */
export function pickSendablePhone(raw: string | null | undefined): SendablePhone {
  const normalized = splitPhoneCandidates(raw).map(normalizeSinglePhone);
  const phone = normalized.find(isSendablePhone) ?? null;
  const ignored = normalized.filter((n) => n !== phone);
  return { phone, ignored };
}

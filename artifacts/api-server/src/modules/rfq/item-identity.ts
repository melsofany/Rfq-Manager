/**
 * Item classification identity — هوية البند للتصنيف
 *
 * The recorded defect: the SAME item (same Line Item / Part No / description)
 * received DIFFERENT categories across RFQs. The cause was not the classifier's
 * accuracy — it was that each item was classified INDEPENDENTLY, at insert time,
 * with no shared memory of a prior decision. The same physical item could be
 * «كهرباء» on one request, «إضاءة» on another, and «غير مصنّف» on the rest.
 *
 * This module computes a CANONICAL identity key for an item so a decision made
 * once can be reused everywhere. The key is deliberately conservative, following
 * the operator's rules:
 *
 *  • A Part Number is a STRONG identity — but only when present. Two DIFFERENT
 *    part numbers are never the same item.
 *  • Otherwise the item is identified by its DESCRIPTION signature: the wording
 *    folded (Arabic spelling variants, units, punctuation) and its content
 *    tokens sorted, so the same item worded slightly differently still matches.
 *    A signature needs enough CONTENT tokens (>= MIN_SIGNATURE_TOKENS); a two
 *    word generic description is not an identity, because «CABLE» alone says
 *    nothing about which cable.
 *  • Numbers and units are KEPT in the signature (they are distinguishing): a
 *    50 MM cable and a 70 MM cable are different items, not the same one.
 *  • The Line Item is a HELPER only — used as a last-resort discriminator when
 *    neither a part number nor a usable description exists. It is never the
 *    sole identity of a real item.
 */
import { normalizeText } from "./classification";

/** Below this many content tokens a description is not a usable identity. */
export const MIN_SIGNATURE_TOKENS = 3;

/**
 * Words that carry no identity — document/filler vocabulary. Removing them stops
 * two unrelated items from looking identical merely because both say «مطلوب» or
 * «as per». Deliberately small and domain-neutral.
 */
const IDENTITY_STOPWORDS = new Set([
  "the",
  "and",
  "with",
  "for",
  "from",
  "per",
  "as",
  "of",
  "to",
  "no",
  "not",
  "qty",
  "quantity",
  "item",
  "pcs",
  "pc",
  "في",
  "من",
  "على",
  "الى",
  "مع",
  "او",
  "ال",
  "نوع",
  "عدد",
  "كميه",
  "سعر",
  "اجمالي",
  "بند",
  "مطلوب",
  "صنف",
  "حسب",
  "قطعه",
  "قطعه غيار",
]);

/**
 * Fold an already-normalised token: Arabic letter variants are handled by
 * `normalizeText`; here we only unify a few unit spellings so «LITERS»/«LTR»
 * compare equal. Numbers are left untouched — they distinguish items.
 */
function foldToken(token: string): string {
  const map: Record<string, string> = {
    liters: "l",
    liter: "l",
    ltr: "l",
    ltrs: "l",
    mm2: "mm2",
    pcs: "pc",
    nos: "pc",
    each: "pc",
  };
  return map[token] ?? token;
}

/**
 * The description signature: content tokens, folded, deduped and SORTED so word
 * order never matters. Returns null when there are too few content tokens to be
 * a reliable identity.
 */
export function descriptionSignature(description: string | null | undefined): string | null {
  const normalized = normalizeText(description);
  if (!normalized) return null;
  const tokens = normalized
    .split(" ")
    .map(foldToken)
    .filter((t) => t.length > 0 && !IDENTITY_STOPWORDS.has(t));
  // Dedupe (a repeated word adds no identity) but keep numbers.
  const unique = [...new Set(tokens)];
  if (unique.length < MIN_SIGNATURE_TOKENS) return null;
  return [...unique].sort().join(" ");
}

/**
 * Does a value look like a structured CATALOG code rather than free prose? The
 * operator's data identifies an item by its Line Item (`5720.010.GENRAL.7054`,
 * `1001.001.USED.0360`), and that code is STABLE across RFQs while the printed
 * description drifts (`EL SEWEEDY` vs `ELSEWEEDY`) — so the code is the identity
 * that unifies the copies, and the description is not.
 *
 * Accepted shapes: a single glued alphanumeric code (`p26e13477`), or 2+ pure
 * numeric segments with at most two word segments (`5720 010 genral 7054`). A
 * sentence («CABLE 3X2.5 MM COPPER») has too many word segments and no repeated
 * numeric run, so it is never mistaken for a code.
 */
export function looksLikeCatalogCode(value: string | null | undefined): boolean {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  const tokens = normalized.split(" ").filter(Boolean);
  const digits = tokens.filter((t) => /^\d+$/.test(t));
  const words = tokens.filter((t) => /[a-z]/.test(t) && !/\d/.test(t));
  const mixed = tokens.filter((t) => /[a-z]/.test(t) && /\d/.test(t));
  // A single glued alphanumeric token («p26e13477», «26r000367»).
  if (tokens.length === 1 && mixed.length === 1 && normalized.replace(/ /g, "").length >= 6) {
    return true;
  }
  // A segmented code: at least two pure-numeric parts and at most two words.
  return digits.length >= 2 && words.length <= 2 && normalized.replace(/ /g, "").length >= 6;
}

/**
 * The canonical identity key for an item. Returns null when the item carries no
 * usable identity at all — such an item must NOT be remembered (a key built from
 * nothing would merge unrelated items).
 *
 * Precedence: part number → Line Item (a structured catalog code) → description
 * signature. The Line Item ranks ABOVE the description because it is the code the
 * operator assigns the item by, and it does not drift the way free text does; a
 * Line Item that is not a structured code falls back to the description, and only
 * then to the raw line item as a last resort.
 */
export function classificationIdentityKey(item: {
  partNo?: string | null;
  description?: string | null;
  lineItem?: string | null;
}): string | null {
  const pn = normalizeText(item.partNo).replace(/ /g, "");
  if (pn.length >= 4) return `pn:${pn}`;

  const li = normalizeText(item.lineItem).replace(/ /g, "");
  if (li.length >= 6 && looksLikeCatalogCode(item.lineItem)) return `li:${li}`;

  const sig = descriptionSignature(item.description);
  if (sig) return `ds:${sig}`;

  // Last resort: a line item is a helper, not a real identity. Kept so an item
  // that ONLY carries a line item still gets a stable key (never merged with a
  // differently-identified item, because the key is namespaced).
  if (li.length >= 6) return `li:${li}`;

  return null;
}

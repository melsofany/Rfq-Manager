/**
 * Part / brand alias resolution (P5).
 *
 * The same manufacturer appears in operator mail spelled several ways, and the
 * part numbers carry the brand inside them: EDC prints `0600.000.GENRAL.0005`
 * (their own spelling of GENERAL), and the operator asks about «السخانات
 * الأريستون» for a part coded `...ARSTON...`. A plain substring filter therefore
 * reports "not found" for a part that IS in the data — the false negative the
 * operator cannot distinguish from a genuine absence.
 *
 * This module folds the spellings onto a canonical brand and expands a query so
 * «أريستون» (Arabic), `ariston` and `arston` (the printed form) all match the
 * same rows. It is deliberately a small curated table plus a normalisation rule,
 * not fuzzy search: a wrong match silently attributes one brand's part to
 * another, which is worse than no match at all for a purchasing decision.
 */

import { normalizeText } from "./email";
import {
  canonicalPartNo,
  itemTokens,
  itemAttributes,
  hasConflictingAttributes,
} from "./item-identity";

/**
 * Canonical brand → the spellings seen in operator data and questions.
 * Arabic transliterations are included because the questions are Arabic even
 * when the documents are English.
 *
 * Additions must be brands actually seen in the data — an over-broad list turns
 * a lookup into a guess.
 */
export const BRAND_ALIASES: Record<string, string[]> = {
  ariston: ["ariston", "arston", "اريستون", "ارستون"],
  general: ["general", "genral", "gen", "جنرال", "جينرال"],
  schneider: ["schneider", "schnider", "شنايدر"],
  siemens: ["siemens", "siemins", "سيمنز"],
  legrand: ["legrand", "لجراند", "ليجراند"],
  philips: ["philips", "phillips", "فيليبس"],
  abb: ["abb", "ايه بي بي"],
  bosch: ["bosch", "بوش"],
  honeywell: ["honeywell", "honywell", "هونيويل"],
  grohe: ["grohe", "جروهي"],
};

/** variant (normalised) → canonical brand. Built once; brands are static. */
const VARIANT_TO_BRAND = new Map<string, string>();
for (const [brand, variants] of Object.entries(BRAND_ALIASES)) {
  for (const v of variants) VARIANT_TO_BRAND.set(normalizeText(v), brand);
}

/**
 * The canonical brand for a free-text word, or null when it is not a known
 * brand. Used both to canonicalise a query and to recognise a brand inside a
 * part number (which has the brand as a `.`-separated segment).
 */
export function canonicalBrand(word: string): string | null {
  const key = normalizeText(word);
  if (!key) return null;
  const direct = VARIANT_TO_BRAND.get(key);
  if (direct) return direct;
  // Arabic writes the brand with the definite article («الأريستون») far more
  // often than bare, and normalisation keeps «ال». Fold it off so the article
  // does not turn a real brand into an unknown word.
  if (key.startsWith("ال")) {
    const stripped = key.slice(2);
    return VARIANT_TO_BRAND.get(stripped) ?? null;
  }
  return null;
}

/**
 * Every spelling of a brand, normalised. Given «أريستون» this returns the set
 * that includes `arston`, so a filter built from it matches the printed part
 * number. Returns an empty array for a non-brand word, which tells the caller to
 * fall back to the literal match.
 */
export function brandVariants(word: string): string[] {
  const brand = canonicalBrand(word);
  if (!brand) return [];
  return BRAND_ALIASES[brand].map((v) => normalizeText(v));
}

/**
 * Split a query into tokens and expand each brand token to its variants.
 *
 * Returns one alternative-list per token: `[["ariston","arston","اريستون"]]` for
 * «أريستون», and a single-element list for an ordinary word. The caller ORs
 * within a token's list and ANDs across tokens, which is the same semantics as
 * the existing token match — so a multi-word query («سخان أريستون 50 لتر»)
 * narrows as the operator expects rather than matching any word.
 */
export function expandQueryTokens(term: string): string[][] {
  const tokens = normalizeText(term).split(" ").filter(Boolean);
  return tokens.map((t) => {
    const variants = brandVariants(t);
    // The literal token first: an exact match is always preferred and this keeps
    // the behaviour identical when the word is not a known brand.
    return variants.length ? [t, ...variants.filter((v) => v !== t)] : [t];
  });
}

/**
 * True when `haystack` matches the query under brand-aware token matching.
 *
 * This is the function the part/item filter uses instead of `includes`, so
 * «أريستون» finds `...ARSTON...` while a non-brand query behaves exactly as
 * before. Matching is on normalised text and requires EVERY query token to be
 * satisfied (any one of that token's variants), preserving the existing
 * all-tokens rule.
 */
export function matchesWithAliases(haystack: string, term: string): boolean {
  const groups = expandQueryTokens(term);
  if (!groups.length) return false;
  const hay = normalizeText(haystack);
  return groups.every((variants) => variants.some((v) => hay.includes(v)));
}

/**
 * Alias-aware match for one parser field (description, part number, …).
 *
 * Wraps {@link matchesWithAliases} so the call sites read as intent rather than
 * mechanism, and so a future field-level rule (e.g. ignoring a location tag)
 * has one place to live.
 */
export function matchesPartQuery(field: unknown, term: string): boolean {
  return matchesWithAliases(String(field ?? ""), term);
}

/** Minimum length of a query token worth matching — shorter ones are noise. */
const MIN_QUERY_TOKEN = 2;

/**
 * The share of the operator's identity tokens that must be found in a row.
 *
 * Deliberately below 1: the operator describes an item in their own words and
 * adds specifications the document does not carry («… MAX. AMBIENT TEMPERATURE
 * +55 DEG C» over a row that stops at «HAZARDOU»), so requiring EVERY token
 * reports «not found» for an item that is right there — the live failure. A
 * measured 12 of 18 tokens matched that row; 0.6 accepts it while a query whose
 * distinguishing values belong to ANOTHER item still fails, and the
 * attribute-conflict rule below is the second, stricter guard.
 */
const MATCH_MIN_SHARE = 0.6;

/**
 * True when ONE parsed row matches the operator's `contains` term.
 *
 * The operator's term is free text and may be ANY of the ways the same item is
 * known: a part number, a model code, a brand («أريستون»), or the description
 * copied whole — wrapped across as many lines as the PDF used, often with extra
 * specifications typed alongside. A single-field `includes` cannot serve that: a
 * full description names the part number in one column and the prose in another,
 * so requiring every token in ONE field reports «not found» for an item that is
 * present. The operator's Maico fan was only the EXAMPLE — the defect is
 * generality, and the next item they type must work too.
 *
 * Three independent signals, none of them fuzzy:
 *  1. a punctuation-stripped part-number match (`1000108319`);
 *  2. the brand-aware token match over the row's joined fields (short phrases);
 *  3. a share of the row's identity tokens, REJECTED when the query and the row
 *     disagree on a distinguishing value (a size, model, capacity, power).
 *
 * Signal 3 is what makes a whole pasted description work without letting a
 * different size through: `itemTokens` keeps a number glued to its unit, and
 * `hasConflictingAttributes` refuses `CABLE 70 MM` against a `CABLE 50 MM` row
 * even though every other word matches.
 */
export function matchesItemQuery(
  it: {
    description?: unknown;
    partNo?: unknown;
    lineItemNo?: unknown;
  },
  rawTerm: string,
): boolean {
  const term = String(rawTerm ?? "").trim();
  if (!term) return false;

  // 1. An exact punctuation-stripped part-number match. This is what makes a
  //    bare `1000108319` find the row even when the operator spaces it.
  const flatTerm = canonicalPartNo(term);
  if (flatTerm.length >= 4) {
    const flatPart = canonicalPartNo(it.partNo);
    const flatLine = canonicalPartNo(it.lineItemNo);
    if (flatPart && flatPart.includes(flatTerm)) return true;
    if (flatLine && flatLine.includes(flatTerm)) return true;
  }

  // 2. Every field in one haystack: a description naming the part number in a
  //    different column must still match as one row.
  const haystack = `${it.description ?? ""} ${it.partNo ?? ""} ${it.lineItemNo ?? ""}`;
  if (matchesWithAliases(haystack, term)) return true;

  // 3. Token coverage over the row's identity tokens, guarded by the rule that a
  //    different measured value means a different item — a wrong match
  //    misreports a purchasing decision, which is worse than an honest miss.
  const rowTokens = itemTokens(it.description, it.partNo, it.lineItemNo);
  const wanted = itemTokens(term).filter((t) => t.length >= MIN_QUERY_TOKEN);
  if (!wanted.length) return false;
  if (hasConflictingAttributes(itemAttributes(wanted), itemAttributes(rowTokens))) return false;
  const found = wanted.filter((t) => rowTokens.some((r) => r.includes(t) || t.includes(r))).length;
  return found / wanted.length >= MATCH_MIN_SHARE;
}

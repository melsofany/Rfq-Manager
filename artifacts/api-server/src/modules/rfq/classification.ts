/**
 * Item classification engine — تصنيف البنود
 *
 * Deterministic, model-free classifier: given an item's text (description,
 * part number, line item) it suggests ONE item category with a confidence
 * score. It never invents a category: a weak or tied signal returns
 * `categoryId: null`, and the caller leaves the item unclassified (and thus
 * unassigned) rather than guessing — the same rule that keeps a sample from
 * being reported as a total elsewhere in this codebase.
 *
 * The seeds are intentionally small and explicit. When the classifier misses,
 * the operator confirms the right category in the UI and that confirmation is
 * what the next version should learn from (kept out of this pure module).
 */

export interface CategorySeed {
  /** Item category id (from `item_categories`). */
  id: number;
  /** Stable code, e.g. `breakers`. */
  code: string | null;
  /** Arabic display name (used only for the message). */
  name: string;
}

export interface ClassifyInput {
  description?: string | null;
  partNo?: string | null;
  lineItem?: string | null;
}

export interface ClassifyResult {
  categoryId: number | null;
  confidence: number;
  /** Normalised term that produced the match, for UI/audit display. */
  matchedTerm: string | null;
  /** True when two categories scored equally — treated as "unknown". */
  ambiguous: boolean;
}

/** One classifier term. `weight` null/0 ⇒ the default weight for its type. */
export interface ClassifierKeyword {
  term: string;
  weight?: number | null;
}

/**
 * Classifier vocabulary keyed by category code. The DB table
 * `item_category_keywords` is loaded into this shape; the built-in constant
 * below is the SEED (inserted on boot) and the fallback when the table is empty.
 * Entries may be a bare string (seed) or a `{ term, weight }` object (DB).
 */
export type ClassifierVocabulary = Record<string, Array<string | ClassifierKeyword>>;

/** Minimum confidence for an automatic classification to be accepted. */
export const MIN_CONFIDENCE = 40;

// Evidence weights. A single domain keyword is enough to classify (the seeds
// are specific); a phrase is stronger; a part-number family ALONE is
// deliberately below the threshold — it only corroborates keyword evidence.
const W_PHRASE = 60;
const W_TOKEN = 45;
const W_FAMILY = 30;

// ── Text normalisation ──────────────────────────────────────────────────────
// Folds Arabic spelling variants (hamza/alef, taa marbuta, yaa), strips
// harakat/tatweel and lowercases Latin, so «مقاومة» == «مقاومه».
const ARABIC_FOLD: Array<[RegExp, string]> = [
  [/[\u064B-\u0652\u0670\u0640]/g, ""], // harakat + tatweel
  [/[إأآا]/g, "ا"],
  [/[ىي]/g, "ي"],
  [/ة/g, "ه"],
  [/[ؤئ]/g, "ء"],
];

export function normalizeText(value: unknown): string {
  if (value == null) return "";
  let s = String(value).toLowerCase();
  for (const [re, to] of ARABIC_FOLD) s = s.replace(re, to);
  // Collapse punctuation/whitespace runs to a single space, keep dots/dashes
  // inside part numbers by replacing them with a space for tokenisation.
  return s
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value: unknown): string[] {
  const n = normalizeText(value);
  return n ? n.split(" ") : [];
}

// ── Category seeds (keywords per category code) ─────────────────────────────
// Multi-word entries are matched as phrases against the normalised text.
// This is the SEED vocabulary: it is inserted into `item_category_keywords` on
// boot and used as the fallback when that table is empty, so moving the terms
// into the database can never silently drop a keyword and lower classifier
// accuracy.
export const CATEGORY_KEYWORDS: Record<string, string[]> = {
  equipment: [
    "pump",
    "motor",
    "fan",
    "blower",
    "compressor",
    "heater",
    "water heater",
    "chiller",
    "جهاز",
    "مضخه",
    "مروحه",
    "موتور",
    "كمبروسر",
    "سخان",
    "مبرد",
    "ماكينه",
  ],
  spare_parts: [
    "bearing",
    "seal",
    "gasket",
    "o ring",
    "filter",
    "valve",
    "impeller",
    "coupling",
    "بلي",
    "سيل",
    "جوان",
    "فلتر",
    "صمام",
    "ريشه",
    "كوبلن",
    "قطعه غيار",
    "قطع غيار",
  ],
  electrical: [
    "cable",
    "wire",
    "conduit",
    "terminal",
    "lug",
    "contactor",
    "relay",
    "coil",
    "lamp",
    "lighting",
    "كابل",
    "سلك",
    "مواسير",
    "طرفيه",
    "كونتاكتور",
    "ريلاي",
    "كويل",
    "لمبه",
    "اضاءه",
  ],
  breakers: [
    "circuit breaker",
    "breaker",
    "mcb",
    "mccb",
    "rcd",
    "elcb",
    "fuse",
    "disconnector",
    "قاطع",
    "قواطع",
    "فيوز",
    "مصهر",
  ],
  fire_resistance: [
    "fire resistance",
    "fire resistant",
    "fireproof",
    "fire retardant",
    "fire fighting",
    "fire alarm",
    "smoke",
    "حريق",
    "مقاوم للحريق",
    "مقاومه حريق",
    "اطفاء",
    "دخان",
  ],
};

// Part-number family hints: a prefix (normalised, dots/dashes stripped) that
// reliably belongs to a category. Deliberately short — only families whose
// meaning is unambiguous.
const PARTNO_FAMILIES: Array<{ prefix: string; code: string }> = [
  // EDC-style line-item groups (see email-items.ts): 5720.* is electrical.
  { prefix: "5720", code: "electrical" },
  { prefix: "0600", code: "equipment" },
];

interface Candidate {
  category: CategorySeed;
  score: number;
  term: string | null;
}

/**
 * Suggest a category for an item. Pure and synchronous so it can be unit
 * tested without a database.
 *
 * `vocabulary` is the classifier terms by category code. When omitted the
 * built-in seed is used, so existing callers and tests keep working. The DB
 * loader passes the admin-managed terms here.
 */
export function classifyItem(
  input: ClassifyInput,
  categories: CategorySeed[],
  vocabulary: ClassifierVocabulary = CATEGORY_KEYWORDS,
): ClassifyResult {
  const text = [input.description, input.partNo, input.lineItem]
    .filter((v): v is string => v != null && String(v).trim() !== "")
    .join(" \n ");
  const normalized = normalizeText(text);
  const textTokens = new Set(tokens(text));

  const candidates: Candidate[] = [];

  for (const cat of categories) {
    const code = cat.code ?? "";
    const keywords = vocabulary[code] ?? [];
    let score = 0;
    let term: string | null = null;

    for (const entry of keywords) {
      // Accept both the seed shape (a bare string) and the DB shape
      // ({ term, weight }) so the two vocabularies are interchangeable.
      const raw = typeof entry === "string" ? entry : entry.term;
      const customWeight = typeof entry === "string" ? 0 : (entry.weight ?? 0);
      const kw = normalizeText(raw);
      if (!kw) continue;
      const isPhrase = kw.includes(" ");
      const hit = isPhrase ? normalized.includes(kw) : textTokens.has(kw);
      if (hit) {
        // A custom weight adds to the default for the term type — it never
        // replaces it, so a seeded term cannot lose the weight it had in code.
        const base = isPhrase ? W_PHRASE : W_TOKEN;
        score += base + (customWeight > 0 ? customWeight : 0);
        term = term ?? raw;
      }
    }

    // Part-number family hint (adds to keyword evidence, never stands alone).
    for (const fam of PARTNO_FAMILIES) {
      if (fam.code !== code) continue;
      const pn = normalizeText(input.partNo);
      const li = normalizeText(input.lineItem);
      if ((pn && pn.replace(/ /g, "").startsWith(fam.prefix)) || li.startsWith(fam.prefix)) {
        score += W_FAMILY;
        term = term ?? fam.prefix;
      }
    }

    if (score > 0) candidates.push({ category: cat, score: Math.min(100, score), term });
  }

  if (candidates.length === 0) {
    return { categoryId: null, confidence: 0, matchedTerm: null, ambiguous: false };
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  const tie = candidates[1] && candidates[1].score === top.score;

  if (tie) {
    // Two categories matched equally well — do not pick one. Leave unclassified.
    return { categoryId: null, confidence: 0, matchedTerm: top.term, ambiguous: true };
  }
  if (top.score < MIN_CONFIDENCE) {
    return { categoryId: null, confidence: top.score, matchedTerm: top.term, ambiguous: false };
  }
  return {
    categoryId: top.category.id,
    confidence: top.score,
    matchedTerm: top.term,
    ambiguous: false,
  };
}

/** Exposed for tests: the keyword table by category code. */
export function categoryKeywords(): Record<string, string[]> {
  return CATEGORY_KEYWORDS;
}

/**
 * The seed vocabulary in DB shape — used by `init-db.ts` to populate
 * `item_category_keywords` idempotently. Kept here (next to the terms) so the
 * seed can never drift from the classifier's own fallback.
 */
export function seedKeywords(): Array<{ code: string; keyword: string; weight: number }> {
  const out: Array<{ code: string; keyword: string; weight: number }> = [];
  for (const [code, terms] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const term of terms) {
      out.push({ code, keyword: term, weight: 0 });
    }
  }
  return out;
}

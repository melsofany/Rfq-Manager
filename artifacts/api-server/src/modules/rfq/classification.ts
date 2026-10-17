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
  /** functional | subcategory | brand. Missing ⇒ functional (legacy rows). */
  kind?: string | null;
  /** The functional domain a subcategory belongs to (null for functional/brand). */
  parentId?: number | null;
  /**
   * Alternate names for the SAME category («ELEC», «Electrical» → «كهرباء»).
   * Matched like keywords and accepted by the AI as a valid answer, so the one
   * real domain is never duplicated under a second spelling.
   */
  aliases?: string[];
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
  /**
   * The domains that tied for the top score. Present ONLY when `ambiguous` is
   * true, so a reviewer can see WHICH categories are in doubt instead of a bare
   * "could not decide".
   */
  candidates?: Array<{ id: number; name: string }>;
  /**
   * The subcategories (قواطع/PLC/…) whose evidence supported the chosen domain.
   * A SUGGESTION only — the subcategory never owns responsibility, so it is
   * never used to pick the employee.
   */
  subcategoryIds?: number[];
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
// A subcategory match names a real product family (قواطع/إضاءة/Encoders) and is
// stronger than a bare domain token, so a specific technical domain beats the
// generic «قطع غيار» domain. It is a BONUS, not a replacement for the base
// weight, so an item that only matches a subcategory still clears MIN_CONFIDENCE.
const W_SUBCATEGORY = 25;

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
    "كابل",
    "سلك",
    "مواسير",
    "طرفيه",
    "كهرباء",
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

// The category codes that are SUB-categories: their vocabulary refines an item
// but their evidence belongs to the domain they sit under. Kept here so the
// deterministic classifier can attribute evidence correctly even when the DB
// loader only supplies `code`/`name` (a test, or a fresh table before seeds run).
const SUBCATEGORY_CODES = new Set([
  "breakers",
  "contactors",
  "cables",
  "panels",
  "plc",
  "automation",
  "encoders",
  "control_systems",
  "instruments",
  "lighting",
]);

/** Subcategory vocabulary (refines a domain; never owns responsibility). */
export const SUBCATEGORY_KEYWORDS: Record<string, string[]> = {
  lighting: [
    "lamp",
    "lighting",
    "light",
    "flood light",
    "led",
    "luminair",
    "tube lamp",
    "لمبه",
    "لمبات",
    "اضاءه",
    "إضاءة",
    "كشاف",
    "كشافات",
  ],
  breakers: [
    "circuit breaker",
    "breaker",
    "mcb",
    "mccb",
    "rcd",
    "elcb",
    "disconnector",
    "قاطع",
    "قواطع",
    "مصهر",
  ],
  contactors: ["contactor", "كونتاكتور", "كونتاكتورات", "overload relay", "اوفرلود"],
  cables: ["cable", "wire", "conduit", "كابل", "سلك", "مواسير", "كابلات"],
  panels: ["panel", "لوحه كهربائيه", "لوحات كهربائيه", "لوحه توزيع", "distribution board"],
  plc: ["plc", "programmable logic"],
  automation: ["automation", "scada", "hmi", "اوتوميشن", "تحكم الي"],
  encoders: ["encoder", "انكودر", "انكودرز"],
  control_systems: ["control system", "control panel", "نظام تحكم"],
  instruments: [
    "instrument",
    "multimeter",
    "ammeter",
    "voltmeter",
    "اجهزه قياس",
    "جهاز قياس",
    "عداد",
  ],
};

// Which functional DOMAIN each subcategory code belongs to. This is the fallback
// used when a caller supplies only `code`/`name` (a unit test, or a fresh table
// before the seeds have run), so evidence is still attributed to the domain.
const SUBCATEGORY_DOMAIN_CODE: Record<string, string> = {
  breakers: "electrical",
  contactors: "electrical",
  cables: "electrical",
  panels: "electrical",
  plc: "electrical",
  automation: "electrical",
  encoders: "electrical",
  control_systems: "electrical",
  instruments: "electrical",
};

/** The effective kind of a seed — explicit `kind`, else inferred from its code. */
function effectiveKind(cat: CategorySeed): string {
  if (cat.kind) return cat.kind;
  if (cat.code && SUBCATEGORY_CODES.has(cat.code)) return "subcategory";
  return "functional";
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

  const byId = new Map(categories.map((c) => [c.id, c]));
  const byCode = new Map(categories.filter((c) => c.code).map((c) => [c.code as string, c]));
  // The domain a category belongs to, resolved from the seed list (parentId) or,
  // when a caller supplies only codes, from the built-in subcategory map. Walks
  // the FULL parent chain so a nested subcategory (كهرباء ← Automation ← Encoders)
  // still resolves to its functional domain.
  const domainOf = (cat: CategorySeed): CategorySeed | null => {
    let current: CategorySeed | undefined = cat;
    for (let hop = 0; hop < 3 && current; hop += 1) {
      if (effectiveKind(current) !== "subcategory") return current;
      if (current.parentId != null) {
        const p = byId.get(current.parentId);
        if (p) {
          current = p;
          continue;
        }
      }
      const code = current.code ? SUBCATEGORY_DOMAIN_CODE[current.code] : undefined;
      return code ? (byCode.get(code) ?? current) : current;
    }
    return current ?? null;
  };
  // Every subcategory on the path from `cat` up to its domain, so a nested chain
  // records Automation AND Encoders, not only the leaf.
  const subChainOf = (cat: CategorySeed): number[] => {
    const out: number[] = [];
    let current: CategorySeed | undefined = cat;
    for (let hop = 0; hop < 3 && current; hop += 1) {
      if (effectiveKind(current) !== "subcategory") break;
      out.push(current.id);
      if (current.parentId != null) {
        current = byId.get(current.parentId);
      } else {
        break;
      }
    }
    return out;
  };
  // Evidence is aggregated by FUNCTIONAL DOMAIN, never by the category that
  // happened to match: a subcategory (قواطع/PLC/…) refines an item but its
  // responsibility belongs to its domain, and a brand is never a domain at all.
  interface DomainCandidate {
    category: CategorySeed;
    score: number;
    term: string | null;
    subIds: Set<number>;
  }
  const byDomain = new Map<number, DomainCandidate>();

  // Domain vocabulary + subcategory vocabulary. Subcategory evidence is what
  // produces the «تخصص فرعي» suggestion; it adds to its domain's score. A
  // category's own ALIASES («ELEC»/«Electrical» for كهرباء) are matched exactly
  // like keywords, so a text mentioning a deprecated spelling still resolves to
  // the ONE canonical category.
  const vocabFor = (cat: CategorySeed): Array<string | ClassifierKeyword> => {
    // The vocabulary key is the category's `code`, else `id:<id>` — a category
    // added from the admin UI without a code must still be reachable, or the
    // manager's keywords would silently never apply.
    const key = cat.code ? cat.code : `id:${cat.id}`;
    const base =
      effectiveKind(cat) === "subcategory"
        ? vocabulary[key]?.length
          ? vocabulary[key]
          : (SUBCATEGORY_KEYWORDS[cat.code ?? ""] ?? [])
        : (vocabulary[key] ?? []);
    return cat.aliases && cat.aliases.length > 0 ? [...base, ...cat.aliases] : base;
  };

  for (const cat of categories) {
    const kind = effectiveKind(cat);
    // A brand is a manufacturer, not a domain: its name must never decide the
    // classification (one maker ships products across several domains).
    if (kind === "brand") continue;
    const code = cat.code ?? "";
    const keywords = vocabFor(cat);
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

    if (score <= 0) continue;

    // A SUBCATEGORY match (قواطع/إضاءة/Encoders…) is stronger evidence than a
    // bare domain token: it names a real product family, whereas «قطع غيار» can
    // match almost anything. The bonus is what makes the specific technical
    // domain win over the generic spare-parts domain, per the operator's rule
    // «قطع الغيار ليست مجالًا عامًا — حدِّد المجال الفني أولًا».
    if (kind === "subcategory") score += W_SUBCATEGORY;

    // Attribute the evidence to the owning domain (a functional category owns
    // itself; a subcategory owns nothing and hands its evidence to its domain).
    const domain = domainOf(cat);
    if (!domain) continue;

    const subChain = kind === "subcategory" ? subChainOf(cat) : [];
    const existing = byDomain.get(domain.id);
    if (existing) {
      existing.score = Math.min(100, existing.score + score);
      existing.term = existing.term ?? term;
      for (const id of subChain) existing.subIds.add(id);
    } else {
      byDomain.set(domain.id, {
        category: domain,
        score: Math.min(100, score),
        term,
        subIds: new Set(subChain),
      });
    }
  }

  const candidates = [...byDomain.values()].map((c) => ({
    category: c.category,
    score: c.score,
    term: c.term,
    subIds: c.subIds,
  }));

  if (candidates.length === 0) {
    return { categoryId: null, confidence: 0, matchedTerm: null, ambiguous: false };
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  const tie = candidates[1] && candidates[1].score === top.score;

  if (tie) {
    // Two domains matched equally well — do not pick one. Leave unclassified.
    // Every domain sharing the top score is reported so the review queue can
    // show the manager WHICH categories are in doubt, not just that one is.
    const tied = candidates
      .filter((c) => c.score === top.score)
      .map((c) => ({ id: c.category.id, name: c.category.name }));
    return {
      categoryId: null,
      confidence: 0,
      matchedTerm: top.term,
      ambiguous: true,
      candidates: tied,
    };
  }
  if (top.score < MIN_CONFIDENCE) {
    return { categoryId: null, confidence: top.score, matchedTerm: top.term, ambiguous: false };
  }
  return {
    categoryId: top.category.id,
    confidence: top.score,
    matchedTerm: top.term,
    ambiguous: false,
    subcategoryIds: [...top.subIds],
  };
}

/** Exposed for tests: the keyword table by category code. */
export function categoryKeywords(): Record<string, string[]> {
  return CATEGORY_KEYWORDS;
}

/**
 * Resolve a category to the FUNCTIONAL domain that owns responsibility.
 *
 * A subcategory (قواطع, PLC, Encoders…) belongs to a domain via `parentId`; the
 * DOMAIN is what a procurement employee is responsible for, so responsibility is
 * ALWAYS resolved to the domain. A brand has no domain and therefore no owner —
 * a brand must never decide who handles an item. `functional` (and a legacy row
 * with no kind) resolves to itself.
 *
 * Follows at most three parent hops so a mis-configured cycle cannot loop.
 */
export function resolveDomainId(categoryId: number, categories: CategorySeed[]): number | null {
  const byId = new Map(categories.map((c) => [c.id, c]));
  let current = byId.get(categoryId);
  if (!current) return categoryId;
  // Walk the FULL parent chain (3 hops covers the deepest nesting here:
  // كهرباء ← Automation ← Encoders) so a nested subcategory resolves to its
  // functional domain, not to an intermediate subcategory.
  for (let hop = 0; hop < 3; hop += 1) {
    const kind = current.kind ?? "functional";
    if (kind === "brand") return null;
    if (kind === "functional" || current.parentId == null) return current.id;
    const parent = byId.get(current.parentId);
    if (!parent) return current.id;
    current = parent;
  }
  return current.id;
}

/**
 * True when a category is a FUNCTIONAL domain — the ONLY kind that may own
 * procurement responsibility or be an item's PRIMARY category. A subcategory
 * (قواطع/PLC/…) refines a domain and a brand is metadata; neither may ever own
 * work. A category with no recorded kind (a legacy row) is treated as
 * functional, which preserves the pre-`kind` behaviour.
 */
export function isFunctionalCategory(cat: CategorySeed | null | undefined): boolean {
  if (!cat) return false;
  return effectiveKind(cat) === "functional";
}

/**
 * True when an item may be recorded with `employeeId` as its owner for
 * `categoryId`. Only a FUNCTIONAL domain may own responsibility: a subcategory
 * refines a domain and a brand is metadata, so neither may carry an owner. When
 * there is no employee there is nothing to refuse (recording a category for
 * review is always allowed). This is the last line of defence for «الماركة لا
 * تكون مسؤولًا», applied wherever a category and an owner arrive together.
 */
export function isOwnableAssignment(
  categoryId: number | null,
  employeeId: number | null,
  categories: CategorySeed[],
): boolean {
  if (employeeId == null) return true;
  if (categoryId == null) return true;
  const cat = categories.find((c) => c.id === categoryId);
  if (!cat) return true;
  return isFunctionalCategory(cat);
}

// ── Learnable keyword extraction (from the manager's corrections) ───────────
// When a manager confirms a classification, the terms that were DECISIVE in the
// item's text become vocabulary for that category — no model call, so learning
// never spends the provider quota whose exhaustion is this system's recorded
// failure mode. The rule is deliberately conservative: a term must look like a
// product word and must not be a brand (a brand is a maker, not a domain, and
// teaching it would make every Siemens part «electrical»).

/** Domain words / generic procurement noise that must never become a rule. */
const STOPWORDS = new Set(
  [
    // English procurement noise
    "the",
    "and",
    "for",
    "with",
    "type",
    "model",
    "size",
    "unit",
    "each",
    "new",
    "old",
    "item",
    "part",
    "no",
    "code",
    "ref",
    "set",
    "kit",
    "pcs",
    "pc",
    "qty",
    "uom",
    "assy",
    "assembly",
    "spare",
    "spares",
    "supply",
    // Arabic generic words (normalised: ة→ه, ى→ي, أإآ→ا)
    "بند",
    "صنف",
    "قطعه",
    "قطعة",
    "قطع",
    "غيار",
    "توريد",
    "مطلوب",
    "مقاس",
    "موديل",
    "عدد",
    "كميه",
    "وحده",
    "جديد",
    "قديم",
    "نوع",
    "كود",
    "مرجع",
    "شركه",
    "مؤسسه",
    "للبيع",
    "المورد",
    "مورد",
  ].map((s) => normalizeText(s)),
);

/** Brand names never become keywords — checked against the live brand catalogue. */
function isBrandTerm(term: string, brandTerms: Set<string>): boolean {
  if (brandTerms.has(term)) return true;
  // Also refuse a term that is a token of a known brand ("schneider" from
  // "Schneider Electric"), so a brand variant cannot leak in.
  for (const b of brandTerms) {
    if (b && (b === term || b.split(" ").includes(term))) return true;
  }
  return false;
}

/**
 * Extract the candidate keywords from one item's text. Returns normalised,
 * de-duplicated terms of at least 3 characters that look like a product word
 * (contains a letter) — numbers-only tokens (voltages, sizes) are dropped.
 */
export function extractLearnableTerms(input: ClassifyInput, brandNames: string[] = []): string[] {
  const brandTerms = new Set(brandNames.map((b) => normalizeText(b)).filter(Boolean));
  const out = new Set<string>();
  for (const raw of [input.description, input.partNo, input.lineItem]) {
    if (raw == null) continue;
    // Split the raw text too: `normalizeText` collapses everything to spaces, so
    // a part number's own letters ("SFCTR3P30") stay a single learnable token.
    const source = String(raw);
    for (const token of source.split(/[^\p{L}\p{N}]+/u)) {
      const t = normalizeText(token);
      if (t.length < 3) continue;
      if (!/\p{L}/u.test(t)) continue; // drop pure numbers
      if (STOPWORDS.has(t)) continue;
      if (isBrandTerm(t, brandTerms)) continue;
      out.add(t);
    }
  }
  return [...out];
}

/**
 * The terms from a corrected item worth teaching to its category: at most
 * `limit`, longest-first (a longer term is more specific, so it is a safer rule
 * than a generic short word).
 */
export function pickLearnableKeywords(
  input: ClassifyInput,
  brandNames: string[] = [],
  limit = 5,
): string[] {
  return extractLearnableTerms(input, brandNames)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, Math.max(0, limit));
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
  // Subcategory terms are seeded too, so «قاطع» resolves to كهرباء (its domain)
  // AND suggests قواطع (its subcategory) — one vocabulary, both answers.
  for (const [code, terms] of Object.entries(SUBCATEGORY_KEYWORDS)) {
    for (const term of terms) {
      out.push({ code, keyword: term, weight: 0 });
    }
  }
  return out;
}

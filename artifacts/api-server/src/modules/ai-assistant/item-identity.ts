/**
 * AI Assistant — item identity and matching.
 *
 * The operator's rule, stated explicitly and repeatedly: a Part Number is NOT
 * the identity of an item. It may be absent, misspelled, present on one PO and
 * missing on the next, or simply different for the same physical item — and the
 * same item may appear twice with no Part Number at all. Grouping on it alone
 * therefore SPLITS one item into several (the recorded failure: the same part
 * counted as two because one PO printed `P/N : A9R41440` and the other only the
 * description) and, worse, MERGES nothing that should be merged.
 *
 * Identity here is the item's WHOLE data: part number when present, the full
 * description, model, brand, size, capacity, power rating, type, unit and any
 * other code — with the wording folded so spelling, word order, abbreviations
 * and unit spellings do not create a false distinction.
 *
 * The opposite error is just as costly: two genuinely different items merged
 * into one row silently misreports how often each was ordered, which is the
 * number the operator acts on. So the merge is deliberately conservative — any
 * CONFLICT in a distinguishing attribute (model, size, capacity, power, part
 * number) blocks it, even when the surrounding prose looks similar. Merging on
 * a shared word alone is never enough.
 */
import { normalizeText } from "./email";

/** Words that carry no identity — articles, prepositions, filler, and the
 *  document's own vocabulary. Removing them stops two unrelated items from
 *  looking similar merely because both say «مطلوب» or «as per». */
const STOPWORDS = new Set([
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
  "color",
  "colour",
  "qty",
  "quantity",
  "total",
  "price",
  "unit",
  "item",
  "pcs",
  "في",
  "من",
  "على",
  "الى",
  "مع",
  "او",
  "ال",
  "نوع",
  "عدد",
  "كمية",
  "سعر",
  "اجمالي",
  "بند",
  "مطلوب",
  "صنف",
  "حسب",
]);

/**
 * Unit / abbreviation spellings folded onto one canonical token, so «2 x 12
 * LITERS» and «2X12 LTR» compare equal. Applied to prose tokens only.
 */
const UNIT_FOLDS: Array<[RegExp, string]> = [
  [/\bmm\s*2\b/, "mm2"],
  [/\bmm²\b/, "mm2"],
  [/\bmet(er|re)s?\b/, "m"],
  [/\bmtrs?\b/, "m"],
  [/\bcentimet(er|re)s?\b/, "cm"],
  [/\bmillimet(er|re)s?\b/, "mm"],
  [/\blit(er|re)s?\b/, "l"],
  [/\bltrs?\b/, "l"],
  [/\bml\b/, "ml"],
  [/\bwatt?s?\b/, "w"],
  [/\bvolts?\b/, "v"],
  [/\bamp(ere)?s?\b/, "a"],
  [/\bkilowatt?s?\b/, "kw"],
  [/\bkilo\s*gram?s?\b/, "kg"],
  [/\bkgs?\b/, "kg"],
  [/\btons?\b/, "ton"],
  [/\bhorse\s*power\b/, "hp"],
  [/\binch(es)?\b/, "in"],
  [/\bpieces?\b/, "pc"],
  [/\bpcs\b/, "pc"],
  [/\bnos\b/, "pc"],
  [/\beach\b/, "pc"],
  [/\bsets?\b/, "set"],
  [/\bbox(es)?\b/, "box"],
  [/\brolls?\b/, "roll"],
  [/\bpairs?\b/, "pair"],
  [/\bbags?\b/, "bag"],
  [/\bdrums?\b/, "drum"],
];

/**
 * Unit suffix → the ATTRIBUTE it measures. Two items that both state a value
 * for the same attribute with different values are different items (a 50 mm
 * cable and a 70 mm cable), so this map is what makes the conflict check
 * meaningful rather than a fuzzy-text guess.
 */
const UNIT_ATTRIBUTE: Record<string, string> = {
  mm: "length",
  cm: "length",
  m: "length",
  in: "length",
  mm2: "section",
  l: "volume",
  ml: "volume",
  w: "power",
  kw: "power",
  hp: "power",
  v: "voltage",
  a: "current",
  hz: "frequency",
  kg: "mass",
  ton: "mass",
  g: "mass",
};

/**
 * A Part Number folded to its identity: uppercase, separators and spaces
 * dropped. `680632`, `680-632` and `680 632` are the same part number; `A.1`
 * and `A1` likewise.
 */
export function canonicalPartNo(value: unknown): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Fold unit spellings in an already-normalised token. */
function foldUnit(token: string): string {
  for (const [re, canonical] of UNIT_FOLDS) {
    if (re.test(token)) return canonical;
  }
  return token;
}

/**
 * The identity-bearing tokens of an item's prose: normalised, unit-folded,
 * stop-words and single characters removed, de-duplicated.
 *
 * Word ORDER is intentionally discarded (tokens are compared as a set): the same
 * item is written «LED 120 CM WATERPROOF» on one order and «WATERPROOF LED 120
 * CM» on another, and order carries no identity.
 *
 * A number glued to a unit («50 MM», «120CM», «3.5 LTR») is ONE token, because
 * it is a specification rather than a quantity: `50 MM CABLE` and `70 MM CABLE`
 * differ in a way a bare number never would, and dropping the number would merge
 * them. A standalone number is dropped — it is a quantity or a line number far
 * more often than it is identity.
 */
export function itemTokens(...fields: Array<unknown>): string[] {
  const raw = fields
    .map((f) => normalizeText(String(f ?? "")))
    .filter(Boolean)
    .join(" ");
  const words = raw.split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const t = words[i];
    if (!t || t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    // Glue a number to the unit that follows it, so a measured value survives as
    // one token instead of the number being dropped as a quantity.
    if (/^\d+(?:\.\d+)?$/.test(t) && i + 1 < words.length) {
      const folded = foldUnit(words[i + 1]);
      if (UNIT_ATTRIBUTE[folded]) {
        out.add(t + folded);
        i += 1;
        continue;
      }
      continue; // a bare number with no unit is not identity
    }
    if (/^\d+$/.test(t)) continue;
    out.add(foldUnit(t));
  }
  return [...out];
}

/** Numeric value + unit, e.g. `120cm` → { attribute: "length", value: "120cm" }. */
const VALUE_UNIT_RE = /^(\d+(?:\.\d+)?)([a-z0-9]{1,3})$/;

/**
 * A model-like token: letters AND digits together and long enough that it is a
 * code rather than a word (`av21240gc010ax0`, `lc1d32q7`, `psh5040n`). These are
 * the strongest identity signal an item has short of a part number, which is why
 * a mismatch between two of them blocks a merge.
 */
function isModelToken(t: string): boolean {
  return t.length >= 5 && /[a-z]/.test(t) && /\d/.test(t);
}

export interface ItemAttributes {
  /** Measured attribute (length, power, …) → its values, e.g. {length:["50mm"]}. */
  measured: Map<string, Set<string>>;
  /** Model-like codes found in the prose. */
  models: Set<string>;
}

/** Extract the measurable attributes and model codes from an item's tokens. */
export function itemAttributes(tokens: string[]): ItemAttributes {
  const measured = new Map<string, Set<string>>();
  const models = new Set<string>();
  for (const t of tokens) {
    const m = VALUE_UNIT_RE.exec(t);
    if (m) {
      const kind = UNIT_ATTRIBUTE[m[2]];
      if (kind) {
        if (!measured.has(kind)) measured.set(kind, new Set());
        measured.get(kind)!.add(t);
        continue;
      }
    }
    if (isModelToken(t)) models.add(t);
  }
  return { measured, models };
}

/**
 * Whether two items state CONFLICTING values for the same measured attribute, or
 * carry different model codes. A conflict is decisive: the merge is refused even
 * when every other token agrees, because a differing model/size/capacity is
 * exactly what distinguishes two products that read almost identically.
 */
export function hasConflictingAttributes(a: ItemAttributes, b: ItemAttributes): boolean {
  for (const [kind, aVals] of a.measured) {
    const bVals = b.measured.get(kind);
    if (!bVals) continue;
    // Disjoint value sets for the same attribute ⇒ a real difference. Overlap
    // (one order also printed the other's value) is not a conflict.
    let shared = false;
    for (const v of aVals) if (bVals.has(v)) shared = true;
    if (!shared) return true;
  }
  // Models are compared the same way: only a genuinely different code conflicts.
  if (a.models.size && b.models.size) {
    for (const m of a.models) if (b.models.has(m)) return false;
    return true;
  }
  return false;
}

/** Jaccard overlap of two token sets. */
function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let inter = 0;
  for (const t of a) if (setB.has(t)) inter += 1;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

/** How much of the SHORTER description the longer one contains (0…1). */
function containment(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const setLong = new Set(long);
  let inter = 0;
  for (const t of short) if (setLong.has(t)) inter += 1;
  return inter / short.length;
}

/** Shared content tokens between two token sets. */
function sharedCount(a: string[], b: string[]): number {
  const setB = new Set(b);
  let n = 0;
  for (const t of a) if (setB.has(t)) n += 1;
  return n;
}

export interface ItemIdentityInput {
  partNo?: string | null;
  description?: string | null;
  /** Any other field that carries identity (specs column, notes). */
  extra?: string | null;
}

/** Precomputed identity of one line, so a pairwise merge does not re-tokenise. */
export interface ItemIdentity {
  partNo: string;
  tokens: string[];
  attributes: ItemAttributes;
}

export function buildItemIdentity(it: ItemIdentityInput): ItemIdentity {
  const tokens = itemTokens(it.description, it.extra);
  return {
    partNo: canonicalPartNo(it.partNo),
    tokens,
    attributes: itemAttributes(tokens),
  };
}

/**
 * Whether two lines are the SAME item.
 *
 * Rules, in order — the first two are refusals, because a wrong merge is worse
 * than a missed one:
 *  1. Two different part numbers ⇒ different items (the operator's rule).
 *  2. A conflicting model/size/capacity/power ⇒ different items.
 *  3. Identical part number ⇒ same item, whatever the prose says.
 *  4. Otherwise the descriptions must agree strongly: either an exact match, or
 *     enough shared content tokens that the two are the same wording written
 *     differently. A single shared word is never enough.
 */
export function itemsEquivalent(a: ItemIdentity, b: ItemIdentity): boolean {
  if (a.partNo && b.partNo) return a.partNo === b.partNo;
  if (hasConflictingAttributes(a.attributes, b.attributes)) return false;

  const aText = a.tokens.join(" ");
  const bText = b.tokens.join(" ");
  if (aText && aText === bText) return true;

  const shared = sharedCount(a.tokens, b.tokens);
  if (shared < 2) return false;

  const jac = jaccard(a.tokens, b.tokens);
  const cont = containment(a.tokens, b.tokens);
  return jac >= 0.7 || cont >= 0.85;
}

/**
 * Group items into identity clusters with union-find.
 *
 * Pairwise comparison alone is not enough: identity is transitive within a real
 * item (the wording drifts PO by PO), so a line that matches cluster A and a
 * line that matches cluster B must all end up in ONE cluster. Union-find merges
 * the chains; the conflict rules above keep two genuinely different items apart
 * because they block the edge in the first place.
 *
 * `O(n²)` in the worst case, which is why it is bounded: items are compared
 * within a part-number bucket when they have one, and the caller only ever hands
 * it one scan's worth of rows.
 */
export function groupByItemIdentity<T extends ItemIdentityInput>(
  rows: T[],
): Array<{ rows: T[]; identity: ItemIdentity }> {
  const identities = rows.map((r) => buildItemIdentity(r));
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  };

  // A part-number bucket: identical part numbers are trivially one item, and
  // comparing only inside the bucket keeps the quadratic term small on a year of
  // mail (most rows carry a part number).
  const byPartNo = new Map<string, number[]>();
  const withoutPartNo: number[] = [];
  identities.forEach((id, i) => {
    if (!id.partNo) {
      withoutPartNo.push(i);
      return;
    }
    if (!byPartNo.has(id.partNo)) byPartNo.set(id.partNo, []);
    byPartNo.get(id.partNo)!.push(i);
  });
  for (const bucket of byPartNo.values()) {
    for (let k = 1; k < bucket.length; k++) union(bucket[0], bucket[k]);
  }

  // Rows without a part number can still belong to a part-numbered item (one PO
  // printed the code, the next did not) — that is the operator's exact case, so
  // they are compared against every part-numbered identity too.
  const partNoIdx = identities
    .map((id, i) => ({ id, i }))
    .filter((x) => x.id.partNo)
    .map((x) => x.i);
  for (const i of withoutPartNo) {
    for (const j of partNoIdx) {
      if (itemsEquivalent(identities[i], identities[j])) union(i, j);
    }
  }
  for (let i = 0; i < withoutPartNo.length; i++) {
    for (let j = i + 1; j < withoutPartNo.length; j++) {
      const a = withoutPartNo[i];
      const b = withoutPartNo[j];
      if (find(a) === find(b)) continue;
      if (itemsEquivalent(identities[a], identities[b])) union(a, b);
    }
  }

  const groups = new Map<number, { rows: T[]; identity: ItemIdentity }>();
  rows.forEach((row, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, { rows: [], identity: identities[root] });
    groups.get(root)!.rows.push(row);
  });
  return [...groups.values()];
}

/**
 * Whether an item's identity is CONFIDENT — a part number or a model code pins
 * it. A cluster identified only by prose is reported separately rather than
 * silently trusted, which is the operator's «عدد البنود التي لم يمكن تحديد
 * هويتها بشكل مؤكد».
 */
export function hasConfidentIdentity(id: ItemIdentity): boolean {
  return Boolean(id.partNo) || id.attributes.models.size > 0;
}

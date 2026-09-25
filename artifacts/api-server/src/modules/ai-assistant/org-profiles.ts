/**
 * AI Assistant — organization profiles (learning a counterparty).
 *
 * The operator's ask, verbatim: «شركة الحفر المصرية اسمها EDC … كل طلبات التسعير
 * الخاصة بهم تبدأ برقم السنة 26 ثم حرف R ثم رقم الطلب … رقم أمر الشراء يبدأ بحرف P
 * ثم 26 ثم E … كل هذا وأكثر يجب أن يتعلمه بالتحليل والمنطق ثم من المستخدم».
 *
 * So a profile carries three kinds of knowledge, learned three ways:
 *
 *  1. **Identity** — names, aliases («شركة الحفر المصرية» = EDC = Egyptian
 *     Drilling), mail domains, mailboxes. Learned from MAIL (the sender domain
 *     and the shared words in their subjects) and from the USER.
 *  2. **Number formats** — «26R####» is their RFQ, «P26E####» is their PO.
 *     Learned by ANALYTICAL INFERENCE (`deriveDocumentFormats`): a number is
 *     decomposed into a literal skeleton plus digit runs, and a skeleton seen at
 *     least twice becomes a rule. That is why the rule generalises
 *     (`^P\d{2}E\d{5}$`) instead of memorising `P26E11407` — a memorised
 *     instance cannot recognise tomorrow's document.
 *  3. **Free notes** — anything the operator states that does not fit the above.
 *
 * The inference here is PURE and synchronous: no model call, no database. The
 * dominant failure mode of this assistant is the 20-requests/day/model quota, so
 * anything that can be reasoned out locally must be — and a pure function is
 * also the only version that can be unit-tested properly.
 *
 * Deliberately NOT inferred: the order of the digit runs' meaning (that `26` is
 * the year). The layout alone cannot prove it; guessing would put a confident
 * wrong explanation in the prompt. The shape is learned from mail, the MEANING
 * is learned from the user and recorded as a `rule`.
 */
import { logger } from "../../shared/logger";

/** A document-number format, generalised from observed samples. */
export interface DocumentFormatRule {
  /** What the document is: a PO, an RFQ, an invoice … */
  kind: "po" | "rfq" | "invoice" | "quotation" | "other";
  /** Regex source matching the whole number, e.g. `^P\d{2}E\d{5}$`. */
  pattern: string;
  /** An observed sample that produced the rule (kept for a human to verify). */
  example: string;
  /** How many observed numbers supported the rule. */
  evidence: number;
  /** Human explanation, when the user taught what the parts mean. */
  meaning?: string;
}

export interface OrgProfile {
  /** Canonical identity key (a normalised name/alias). */
  slug: string;
  nameAr?: string;
  nameEn?: string;
  /** Every name the organization is known by, including learned ones. */
  aliases: string[];
  /** Mail domains that belong to this organization. */
  domains: string[];
  /** Mailboxes their documents land in (e.g. «info»). */
  mailboxes: string[];
  documentFormats: DocumentFormatRule[];
  notes?: string;
  /** 0-100; grows with corroborating evidence, never used to hide a rule. */
  confidence: number;
  /** Total observations behind the profile. */
  evidenceCount: number;
  /** Where the knowledge came from: "mail" and/or "user". */
  sources: string[];
  updatedAt?: string;
}

/* ── Identity normalisation ─────────────────────────────────────────────── */

/**
 * Corporate filler that says nothing about WHICH company it is. Dropping it is
 * what lets «شركة الحفر المصرية» and «الحفر المصرية» share one slug — and is the
 * same reasoning as the entity-name checker, which refuses to count a shared
 * «للتوريدات» as evidence of identity.
 */
const CORPORATE_STOPWORDS = new Set([
  "شركه",
  "شركة",
  "مؤسسه",
  "مؤسسة",
  "المصريه",
  "المصرية",
  "company",
  "co",
  "corp",
  "corporation",
  "ltd",
  "limited",
  "llc",
  "inc",
  "the",
  "group",
  "for",
  "and",
]);

/** Fold Arabic spelling variants so «شركة» and «شركه» are one token. */
export function normalizeOrgText(text: string): string {
  return (text ?? "")
    .toString()
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Canonical identity key for an organization name.
 *
 * Keeps the distinguishing words and drops the corporate filler, so two spellings
 * of the same company agree while two different companies do not. Falls back to
 * the full normalised text when every token is filler (a name like «الشركة
 * المصرية» alone still deserves a key).
 *
 * The original casing is PRESERVED (only comparison is case-insensitive): a slug
 * is also the profile's display name, and an acronym shown as «edc» in the prompt
 * reads as a typo.
 */
export function orgSlug(name: string): string {
  const raw = (name ?? "")
    .toString()
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .trim();
  const tokens = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const kept = tokens.filter((t) => !CORPORATE_STOPWORDS.has(normalizeOrgText(t)));
  const chosen = kept.length ? kept : tokens;
  const key = chosen.join(" ").trim() || raw;
  return key.slice(0, 120) || "org";
}

/** Case-insensitive equality for two identity keys. */
export function sameSlug(a: string, b: string): boolean {
  return normalizeOrgText(a) === normalizeOrgText(b);
}

/** A short uppercase alias when a name looks like an acronym (EDC, E.D.C.). */
export function acronymOf(name: string): string | null {
  const raw = (name ?? "").toString();
  const letters = raw.replace(/[^A-Za-z]/g, "");
  // A short all-caps token is already an acronym; `E.D.C.` folds to one too.
  if (letters.length >= 2 && letters.length <= 6 && raw === raw.toUpperCase()) {
    return letters.toUpperCase();
  }
  const words = raw.split(/[\s.]+/).filter((w) => /^[A-Za-z]/.test(w));
  if (words.length >= 2 && words.every((w) => w[0] === w[0].toUpperCase())) {
    return words
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  }
  return null;
}

/** The mail domain of an address (`noreply@edc-egypt.com` → `edc-egypt.com`). */
export function domainOf(address: string): string | null {
  const m = /@([^@\s>]+)/.exec(address ?? "");
  return m ? m[1].toLowerCase().replace(/[).,;>]+$/, "") : null;
}

/**
 * The registrable-ish label of a domain (`edc-egypt.com` → `edc`), used as a
 * last-resort identity when nothing else identifies the sender.
 *
 * Only the FIRST label is taken, and sub-domains are skipped, so
 * `mail.edc-egypt.com` and `edc-egypt.com` agree.
 */
export function domainLabel(domain: string): string | null {
  const clean = (domain ?? "").toLowerCase().replace(/^[a-z0-9-]+\.(?=[a-z0-9-]+\.[a-z]{2,}$)/, "");
  const label = clean.split(".")[0]?.replace(/[^a-z0-9]/g, "");
  return label && label.length >= 2 ? label : null;
}

/* ── Number-format inference ────────────────────────────────────────────── */

/**
 * Split a document number into its literal skeleton and its digit runs.
 *
 * `P26E11407` → literals `["P", "E"]`, runs `[2, 5]`, key `P|E|2`.
 * `26R011936` → literals `["", "R"]`, runs `[2, 6]`, key `|R|2`.
 *
 * The key is what decides whether two numbers share a FORMAT: the literals and
 * the number of runs must agree. Digit WIDTHS are allowed to vary (a serial
 * grows over the years), so they are collected separately rather than keyed on.
 */
export function numberShape(
  value: string,
): { key: string; literals: string[]; runs: number[] } | null {
  const n = (value ?? "").trim();
  if (!n || !/[0-9]/.test(n) || !/[A-Za-z]/.test(n)) return null;
  // Literals and runs are kept POSITIONALLY ALIGNED: `literals[i]` is the text
  // before run `i`, and it may be EMPTY (an RFQ number starts with its year, so
  // `26R011936` has a leading empty literal). Mis-aligning them is how
  // `26R011936` once produced the nonsense pattern `^R\d{2}$`.
  const literals: string[] = [];
  const runs: number[] = [];
  let lit = "";
  let cursor = 0;
  const re = /([0-9]+)|([A-Za-z]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(n))) {
    if (m.index > cursor) lit += n.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    if (m[1]) {
      literals.push(lit);
      runs.push(m[1].length);
      lit = "";
    } else {
      lit += m[2];
    }
  }
  // A number ends in its serial: a trailing literal (a `(RIG58)` suffix) is not
  // part of the format, so `lit` is deliberately dropped here.
  if (!literals.length || !runs.length) return null;
  const key = `${literals.join("|").toUpperCase()}|${runs.length}`;
  return { key, literals, runs };
}

/** Build the regex source for a set of numbers sharing one shape. */
function patternFromShape(literals: string[], observations: number[][]): string {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // No trailing boundary: the number is matched as a whole token by the caller,
  // and `\b` after a digit run would reject a number followed by `(`.
  let out = "^";
  for (let i = 0; i < literals.length; i++) {
    out += escape(literals[i]);
    if (i < observations.length) {
      const lens = observations[i];
      const min = Math.min(...lens);
      const max = Math.max(...lens);
      out += min === max ? `\\d{${min}}` : `\\d{${min},${max}}`;
    }
  }
  return out + "$";
}

/** Guess what a document is from its leading literal(s): `P`→PO, `R`→RFQ. */
export function guessFormatKind(pattern: string): DocumentFormatRule["kind"] {
  // Read the literals out of the pattern, so `^P\d{2}E\d{5}$` is judged on the
  // letters it actually carries rather than on the sample's spelling.
  const letters = (pattern.match(/[A-Za-z]+/g) ?? []).map((s) => s.toUpperCase());
  const joined = letters.join("");
  if (/^P.*E$|^PO/.test(joined) || letters[0] === "P") return "po";
  if (letters.includes("RFQ") || letters.includes("R")) return "rfq";
  if (letters.includes("INV")) return "invoice";
  if (letters.includes("QT") || letters.includes("QUO")) return "quotation";
  return "other";
}

/**
 * Derive document-format rules from observed numbers.
 *
 * This is the "analysis and logic" half of the operator's request: a number is
 * decomposed once (`numberShape`), numbers sharing a skeleton are grouped, and a
 * group with at least `minSupport` members becomes a rule. Anything seen once is
 * deliberately NOT promoted — one example cannot distinguish a format from a
 * coincidence, and a wrong rule in the prompt is worse than no rule.
 *
 * `kindHint` from the mail's own wording (`PO number:` / `RFQ number:`) always
 * beats the letter heuristic. EDC prints `26R…` for an RFQ whose first letter is
 * a digit, so the wording is the only reliable signal there.
 */
export function deriveDocumentFormats(
  observations: Array<{ number: string; kind?: DocumentFormatRule["kind"] }>,
  minSupport = 2,
): DocumentFormatRule[] {
  const groups = new Map<
    string,
    { literals: string[]; runs: number[][]; numbers: string[]; kinds: Map<string, number> }
  >();
  for (const obs of observations) {
    const shape = numberShape(obs.number);
    if (!shape) continue;
    const g = groups.get(shape.key) ?? {
      literals: shape.literals,
      runs: shape.literals.map(() => [] as number[]),
      numbers: [],
      kinds: new Map<string, number>(),
    };
    // Digit runs sit between consecutive literals, so run `i` belongs to the
    // gap after literal `i`.
    shape.runs.forEach((len, i) => {
      g.runs[i] = [...(g.runs[i] ?? []), len];
    });
    g.numbers.push(obs.number);
    if (obs.kind) g.kinds.set(obs.kind, (g.kinds.get(obs.kind) ?? 0) + 1);
    groups.set(shape.key, g);
  }

  const rules: DocumentFormatRule[] = [];
  for (const g of groups.values()) {
    if (g.numbers.length < minSupport) continue;
    const pattern = patternFromShape(g.literals, g.runs);
    // The most frequent wording wins; the letter heuristic is the fallback.
    const byWording = [...g.kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    rules.push({
      kind: (byWording as DocumentFormatRule["kind"]) ?? guessFormatKind(pattern),
      pattern,
      example: g.numbers[0],
      evidence: g.numbers.length,
    });
  }
  // Most-supported first, so the prompt leads with the formats mail proves.
  return rules.sort((a, b) => b.evidence - a.evidence || a.pattern.localeCompare(b.pattern));
}

/** Does a value match a learned rule? Used to verify a rule before trusting it. */
export function matchesFormat(value: string, rule: DocumentFormatRule): boolean {
  try {
    return new RegExp(rule.pattern).test((value ?? "").trim());
  } catch {
    return false;
  }
}

/* ── Identity matching ──────────────────────────────────────────────────── */

/** Every string a profile can be recognised by (names, aliases, slug, domain label). */
export function profileSearchTerms(profile: OrgProfile): string[] {
  const terms = new Set<string>();
  for (const a of [profile.nameAr, profile.nameEn, profile.slug, ...profile.aliases]) {
    if (!a) continue;
    terms.add(normalizeOrgText(a));
    const acronym = acronymOf(a);
    if (acronym) terms.add(acronym.toLowerCase());
  }
  for (const d of profile.domains) {
    const label = domainLabel(d);
    if (label) terms.add(label.toLowerCase());
  }
  return [...terms].filter((t) => t.length >= 2);
}

/**
 * The profile a piece of text refers to, or null.
 *
 * Longest term first, so «شركة الحفر المصرية» wins over a bare «المصرية» when
 * both appear. Matching is on normalised text, so spelling variants agree.
 */
export function matchOrgProfile(text: string, profiles: OrgProfile[]): OrgProfile | null {
  const hay = normalizeOrgText(text);
  if (!hay) return null;
  const domain = domainOf(text);
  let best: { profile: OrgProfile; len: number } | null = null;
  for (const profile of profiles) {
    for (const term of profileSearchTerms(profile)) {
      const hit =
        domain && profile.domains.some((d) => d.toLowerCase() === domain)
          ? true
          : hay.includes(term);
      if (hit && (!best || term.length > best.len)) best = { profile, len: term.length };
    }
  }
  return best?.profile ?? null;
}

/* ── Merging / learning ─────────────────────────────────────────────────── */

const uniq = (values: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = (v ?? "").toString().trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
};

/**
 * Merge newly-learned knowledge into an existing profile.
 *
 * Union, never replace: a second sighting of a domain must not erase an alias
 * the user taught earlier. Formats merge on (pattern) so re-learning the same
 * rule raises its evidence instead of duplicating it. `sources` accumulates, so
 * the profile always records whether it rests on mail, the user, or both.
 */
export function mergeProfile(
  existing: OrgProfile | null,
  patch: Partial<OrgProfile> & { slug?: string },
): OrgProfile {
  const base: OrgProfile = existing ?? {
    slug: "",
    aliases: [],
    domains: [],
    mailboxes: [],
    documentFormats: [],
    confidence: 0,
    evidenceCount: 0,
    sources: [],
  };
  const slug = orgSlug(patch.slug || patch.nameEn || patch.nameAr || base.slug || "");
  // Keep the existing slug's casing when the new one is only a different spelling
  // of the same identity; otherwise adopt the new one. An acronym must not drift
  // to «edc» just because a later patch was lower-cased.
  const resolvedSlug = base.slug && sameSlug(base.slug, slug) ? base.slug : slug;

  const formats = new Map<string, DocumentFormatRule>();
  for (const f of base.documentFormats) formats.set(f.pattern, { ...f });
  for (const f of patch.documentFormats ?? []) {
    const prev = formats.get(f.pattern);
    formats.set(f.pattern, {
      ...f,
      // Evidence accumulates; the meaning is kept unless the new one is explicit.
      evidence: Math.max(prev?.evidence ?? 0, f.evidence),
      meaning: f.meaning ?? prev?.meaning,
    });
  }

  const evidenceCount = base.evidenceCount + (patch.evidenceCount ?? 0);
  const sources = uniq([...base.sources, ...(patch.sources ?? [])]);
  // Confidence tracks corroboration, and combining mail with the user is a
  // stronger claim than either alone — the two are independent sources.
  const derivedConfidence = Math.min(
    95,
    40 +
      evidenceCount * 4 +
      (sources.length > 1 ? 15 : 0) +
      ((patch.documentFormats?.length ?? 0) > 0 ? 5 : 0),
  );

  return {
    slug: resolvedSlug,
    nameAr: patch.nameAr ?? base.nameAr,
    nameEn: patch.nameEn ?? base.nameEn,
    aliases: uniq([...base.aliases, ...(patch.aliases ?? [])]),
    domains: uniq([...base.domains, ...(patch.domains ?? [])]),
    mailboxes: uniq([...base.mailboxes, ...(patch.mailboxes ?? [])]),
    documentFormats: [...formats.values()].sort(
      (a, b) => b.evidence - a.evidence || a.pattern.localeCompare(b.pattern),
    ),
    notes: patch.notes ?? base.notes,
    confidence: Math.max(base.confidence, patch.confidence ?? 0, derivedConfidence),
    evidenceCount,
    sources,
    updatedAt: new Date().toISOString(),
  };
}

/* ── Prompt rendering ───────────────────────────────────────────────────── */

const KIND_LABEL: Record<DocumentFormatRule["kind"], string> = {
  po: "أمر شراء",
  rfq: "طلب تسعير",
  invoice: "فاتورة",
  quotation: "عرض سعر",
  other: "مستند",
};

/**
 * Render the profiles for the system prompt.
 *
 * Bounded (a handful of orgs, a handful of rules each) because the prompt must
 * not crowd out the conversation. Only identity and FORMATS are rendered — the
 * `pattern` is shown so the model can recognise a number it has never seen, and
 * the `example` is shown so a human reading a transcript can verify the rule.
 */
export function renderOrgProfilesBlock(profiles: OrgProfile[], limit = 6): string {
  const list = profiles.filter((p) => p.slug).slice(0, limit);
  if (!list.length) return "";
  const lines: string[] = [];
  for (const p of list) {
    const names = uniq([p.nameAr, p.nameEn, ...p.aliases])
      .slice(0, 5)
      .join(" = ");
    const bits = [`**${names || p.slug}**`];
    if (p.domains.length) bits.push(`بريد: ${p.domains.slice(0, 3).join("، ")}`);
    if (p.mailboxes.length) bits.push(`صندوق: ${p.mailboxes.slice(0, 3).join("، ")}`);
    lines.push(`- ${bits.join(" — ")}`);
    for (const f of p.documentFormats.slice(0, 6)) {
      const meaning = f.meaning ? ` (${f.meaning})` : "";
      lines.push(`  • ${KIND_LABEL[f.kind]}: النمط \`${f.pattern}\` — مثال ${f.example}${meaning}`);
    }
    if (p.notes) lines.push(`  • ملاحظة: ${p.notes}`);
  }
  return (
    "\n\nبروفايلات الجهات (تعلّمتها من البريد ومن المستخدم — استخدمها للتعرّف على " +
    "أرقام المستندات ومعانيها قبل أن تسأل):\n" +
    lines.join("\n") +
    "\nهذه الأنماط نتجت من ملاحظة فعلية؛ إن رأيت رقمًا لا يطابق أي نمط فلا تجبره على " +
    "نمط قريب، واذكر أنه غير معروف بدلًا من تخمين نوعه."
  );
}

/* ── Persistence ──────────────────────────────────────────────────────────
 *
 * The learned knowledge must OUTLIVE the process: a deploy, a crash or a Render
 * recycle would otherwise wipe everything the assistant had learned, and the
 * operator would have to teach EDC again. The database access is a LAZY import
 * for the same reason the scan-session mirror uses one — it keeps this module
 * importable (and its pure inference unit-testable) without a database.
 */

interface ProfileRow {
  slug: string;
  nameAr?: string | null;
  nameEn?: string | null;
  aliases?: unknown;
  domains?: unknown;
  mailboxes?: unknown;
  documentFormats?: unknown;
  notes?: string | null;
  confidence?: number | null;
  evidenceCount?: number | null;
  sources?: unknown;
  updatedAt?: Date | null;
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Row → domain object, tolerating a partially-populated record. */
export function profileFromRow(row: ProfileRow): OrgProfile {
  return {
    slug: row.slug,
    nameAr: row.nameAr ?? undefined,
    nameEn: row.nameEn ?? undefined,
    aliases: asStringArray(row.aliases),
    domains: asStringArray(row.domains),
    mailboxes: asStringArray(row.mailboxes),
    documentFormats: Array.isArray(row.documentFormats)
      ? (row.documentFormats as DocumentFormatRule[]).filter((f) => f && f.pattern)
      : [],
    notes: row.notes ?? undefined,
    confidence: row.confidence ?? 0,
    evidenceCount: row.evidenceCount ?? 0,
    sources: asStringArray(row.sources),
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : undefined,
  };
}

/** In-memory cache so the prompt does not read the table on every message. */
let profileCache: { at: number; profiles: OrgProfile[] } | null = null;
const PROFILE_TTL_MS = 5 * 60_000;

/** Test seam: drop the cached profiles. */
export function resetOrgProfilesCache(): void {
  profileCache = null;
}

/**
 * Load every learned profile.
 *
 * A read failure returns an EMPTY list rather than throwing: a database hiccup
 * must degrade to "nothing learned yet", never block the answer. Cached for a
 * few minutes because names and formats change on the order of days while the
 * assistant answers many messages.
 */
export async function loadOrgProfiles(force = false): Promise<OrgProfile[]> {
  if (!force && profileCache && Date.now() - profileCache.at < PROFILE_TTL_MS) {
    return profileCache.profiles;
  }
  try {
    const { db, aiAssistantOrgProfilesTable } = await import("@workspace/db");
    const rows = (await db
      .select()
      .from(aiAssistantOrgProfilesTable)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .orderBy((aiAssistantOrgProfilesTable as any).updatedAt)) as ProfileRow[];
    const profiles = rows.map(profileFromRow).filter((p) => p.slug);
    profileCache = { at: Date.now(), profiles };
    return profiles;
  } catch (err) {
    logger.warn({ err }, "AI assistant: org profile read failed");
    return profileCache?.profiles ?? [];
  }
}

/**
 * Persist a learned profile, MERGING with what is already stored.
 *
 * The merge (not an overwrite) is the whole point: mail may have taught the
 * domain while the user taught the alias, and a plain upsert would drop one of
 * them. `slug` is the identity key, so both paths converge on one row.
 */
export async function saveOrgProfile(patch: Partial<OrgProfile>): Promise<OrgProfile> {
  const existing = patch.slug
    ? ((await loadOrgProfiles(true)).find((p) => sameSlug(p.slug, patch.slug ?? "")) ?? null)
    : null;
  const merged = mergeProfile(existing, patch);
  try {
    const { db, aiAssistantOrgProfilesTable } = await import("@workspace/db");
    const values = {
      slug: merged.slug,
      nameAr: merged.nameAr ?? null,
      nameEn: merged.nameEn ?? null,
      aliases: merged.aliases,
      domains: merged.domains,
      mailboxes: merged.mailboxes,
      documentFormats: merged.documentFormats as unknown,
      notes: merged.notes ?? null,
      confidence: merged.confidence,
      evidenceCount: merged.evidenceCount,
      sources: merged.sources,
    };
    await db
      .insert(aiAssistantOrgProfilesTable)
      .values(values)
      .onConflictDoUpdate({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        target: (aiAssistantOrgProfilesTable as any).slug,
        set: { ...values, updatedAt: new Date() },
      });
    // The cache must reflect the write immediately, or the very next question
    // would be answered from the pre-teaching state.
    profileCache = null;
    logger.info(
      { slug: merged.slug, formats: merged.documentFormats.length, sources: merged.sources },
      "AI assistant: org profile saved",
    );
    return merged;
  } catch (err) {
    // Learning must never fail the reply. The learned value stays in the cache so
    // the current process still benefits; the next successful write persists it.
    logger.warn({ err, slug: merged.slug }, "AI assistant: org profile write failed");
    const next = [...(profileCache?.profiles ?? []).filter((p) => !sameSlug(p.slug, merged.slug))];
    next.push(merged);
    profileCache = { at: Date.now(), profiles: next };
    return merged;
  }
}

/* ── Learning from mail (analysis, no model call) ───────────────────────── */

/** One observed document number with the wording that named its type. */
export interface MailNumberObservation {
  number: string;
  kind?: DocumentFormatRule["kind"];
  /** Sender address or display name the number arrived with. */
  from?: string;
  subject?: string;
  mailbox?: string;
}

/**
 * The organization a batch of mail belongs to, inferred from the senders.
 *
 * A single sender address would be fragile (a company writes from `noreply@` and
 * from people's mailboxes), so the DOMAIN that appears most often wins, and its
 * label seeds the identity. The display-name words are added as aliases only when
 * they are shared by several messages — a word seen once is not a name.
 *
 * `minSupport` applies to the IDENTITY too, not just to the formats: one message
 * from an unrelated sender must not create an organization profile, which is how
 * a single stray email would otherwise turn into a learned "company".
 */
export function inferIdentityFromMail(
  obs: MailNumberObservation[],
  minSupport = 2,
): { slug: string; aliases: string[]; domains: string[]; mailboxes: string[] } | null {
  const domainCounts = new Map<string, number>();
  // Keyed by the NORMALISED word (so `EDC`/`edc` agree) but the ORIGINAL spelling
  // is remembered too: only the original casing can prove a word is an acronym,
  // and normalisation lower-cases it away.
  const wordCounts = new Map<string, { count: number; original: string }>();
  const mailboxes = new Set<string>();
  for (const o of obs) {
    const domain = domainOf(o.from ?? "");
    if (domain) domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    if (o.mailbox) mailboxes.add(o.mailbox);
    // Words that recur across subjects are the company's own name, not prose.
    for (const w of (o.subject ?? "").split(/[^\p{L}\p{N}]+/u)) {
      const norm = normalizeOrgText(w);
      if (norm.length < 3 || CORPORATE_STOPWORDS.has(norm)) continue;
      const prev = wordCounts.get(norm);
      wordCounts.set(norm, {
        count: (prev?.count ?? 0) + 1,
        // Prefer an ALL-CAPS spelling as the representative: `EDC` over `edc`.
        original: !prev || (w === w.toUpperCase() && w !== w.toLowerCase()) ? w : prev.original,
      });
    }
  }
  const topDomainEntry = [...domainCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const topDomain =
    topDomainEntry && topDomainEntry[1] >= minSupport ? topDomainEntry[0] : undefined;
  const label = topDomain ? domainLabel(topDomain) : null;
  const recurring = [...wordCounts.entries()]
    .filter(([, v]) => v.count >= minSupport)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8);
  // A recurring ALL-CAPS word is an acronym the company uses for itself (EDC),
  // which makes the best identity key; else the domain's label; else the most
  // frequent recurring word.
  const acronym = recurring
    .map(([, v]) => v.original)
    .find((w) => /^[A-Z]{2,6}$/.test(w) && w.length <= 6);
  const slug = acronym || label || recurring[0]?.[1].original;
  if (!slug) return null;
  return {
    slug,
    aliases: recurring.map(([, v]) => v.original).sort((a, b) => b.length - a.length),
    domains: topDomain ? [topDomain] : [],
    mailboxes: [...mailboxes],
  };
}

/**
 * Learn an organization profile from a document-number census.
 *
 * This is the "بالتحليل والمنطق" half, and it is where the operator's two EDC
 * examples come from: `26R…` recurs, `P26E…` recurs, and each becomes a rule.
 *
 * `minSupport` is what keeps a coincidence out of the prompt. Returns null when
 * nothing could be inferred, so the caller can log "nothing learned" rather than
 * writing an empty profile.
 */
export function learnProfileFromMail(
  obs: MailNumberObservation[],
  minSupport = 2,
): OrgProfile | null {
  if (!obs.length) return null;
  const formats = deriveDocumentFormats(
    obs.map((o) => ({ number: o.number, kind: o.kind })),
    minSupport,
  );
  const identity = inferIdentityFromMail(obs, minSupport);
  if (!formats.length && !identity) return null;
  const slug = identity?.slug ?? "غير معروف";
  return mergeProfile(null, {
    slug,
    aliases: identity?.aliases ?? [],
    domains: identity?.domains ?? [],
    mailboxes: identity?.mailboxes ?? [],
    documentFormats: formats,
    evidenceCount: obs.length,
    sources: ["mail"],
  });
}

/**
 * Learn an organization profile from the USER's own words.
 *
 * The user states things analysis cannot prove — most importantly what the parts
 * of a number MEAN («26 = السنة، R = طلب تسعير»). Whatever the operator names is
 * taken as an alias, and any explicitly quoted document number is added as a
 * format so a single authoritative example still becomes a rule (`minSupport 1`):
 * a user's statement outranks the "seen twice" heuristic that guards mail.
 */
export function learnProfileFromUser(input: {
  text: string;
  slug?: string;
  examples?: Array<{ number: string; kind?: DocumentFormatRule["kind"] }>;
  notes?: string;
}): OrgProfile | null {
  const text = (input.text ?? "").trim();
  const examples = input.examples ?? [];
  if (!text && !examples.length && !input.slug) return null;
  const slug = input.slug || (text ? orgSlug(text) : "غير معروف");
  const formats = examples.length ? deriveDocumentFormats(examples, 1) : [];
  return mergeProfile(null, {
    slug,
    aliases: input.slug ? [] : [text].filter(Boolean),
    documentFormats: formats,
    notes: input.notes,
    evidenceCount: examples.length || (text ? 1 : 0),
    sources: ["user"],
  });
}

/**
 * The document kind a learned pattern assigns to a number, or null.
 *
 * Used to answer "what is this number?" from knowledge instead of guessing, and
 * — importantly — to answer `null` when no rule matches. The prompt tells the
 * model not to force an unknown number into a near pattern; this is the code
 * that makes that possible.
 */
export function classifyByProfiles(
  value: string,
  profiles: OrgProfile[],
): { profile: OrgProfile; rule: DocumentFormatRule } | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  for (const profile of profiles) {
    for (const rule of profile.documentFormats) {
      if (matchesFormat(v, rule)) return { profile, rule };
    }
  }
  return null;
}

/**
 * AI item classifier — تصنيف بنود طلب العميل بالذكاء الاصطناعي
 *
 * The deterministic keyword classifier (`rfq/classification.ts`) requires an
 * exact vocabulary hit, so an item whose wording is not in the table is left
 * «غير مصنّف» even when a human would place it instantly. This module asks the
 * configured LLM (DeepSeek, a paid API — NOT subject to the Gemini free-tier
 * daily cap) to place every item into ONE of the operator's own categories.
 *
 * The model is given the categories it MUST choose from and is instructed to
 * return «غير معروف» when it cannot decide — an unclassified item stays
 * unassigned on purpose (the same rule as the keyword classifier: never invent
 * a responsibility nobody owns). It is a plain JSON completion, not a
 * tool-calling run, so it adds no tool surface and one provider request.
 *
 * Best-effort by design: a missing key, an API error or an unparsable reply
 * returns `null` and the caller falls back to the keyword classifier. A
 * classification failure must never fail the customer RFQ it is classifying.
 */
import { chatCompletion, type ChatMessage } from "../ai-assistant/llm";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEEPSEEK_FALLBACK_MODELS,
  isAiConfigured,
  isDeepSeekEndpoint,
  isGeminiModelId,
  loadSettings,
} from "../ai-assistant/config";
import { logger } from "../../shared/logger";
import type { CategorySeed } from "./classification";

/**
 * Reasoning-model detection. A reasoning model (deepseek-v4-pro / -r* /
 * -reasoner) charges its THINKING against the same `max_tokens` budget as the
 * reply, so a ceiling sized for the reply alone is spent before any text is
 * emitted (see PR #217). Classification is a closed-list choice that needs no
 * reasoning, so the batch is sent to the light model instead.
 */
const REASONING_RE = /deepseek-(v\d|r\d|reasoner)/i;
const CLASSIFY_MAX_TOKENS = 4000;
const REASONING_CLASSIFY_MAX_TOKENS = 8000;
/** One re-ask after a truncated reply — a smaller batch leaves room for it. */
const CLASSIFY_MAX_ATTEMPTS = 2;
/** Below this, a retry cannot get smaller — accept the batch as-is. */
const MIN_BATCH = 5;

/**
 * The model that classifies a batch. A DeepSeek reasoning primary is downgraded
 * to the light model (`deepseek-chat`): thinking is wasted on a closed-list
 * choice, and it is exactly what made the reply come back empty. Any other
 * operator choice (a Gemini primary, or a non-reasoning DeepSeek id) is kept.
 */
export function classifyModelFor(model: string, baseUrl?: string | null): string {
  const isDeepSeek =
    /^deepseek/i.test(model) ||
    (!isGeminiModelId(model) && isDeepSeekEndpoint(baseUrl || DEFAULT_BASE_URL));
  if (isDeepSeek && REASONING_RE.test(model)) {
    return DEEPSEEK_FALLBACK_MODELS[0] || model;
  }
  return model;
}

/** The output ceiling for the model actually used — thinking must not eat the reply. */
export function classifyMaxTokensFor(model: string): number {
  return REASONING_RE.test(model) ? REASONING_CLASSIFY_MAX_TOKENS : CLASSIFY_MAX_TOKENS;
}

export interface AiClassifyInput {
  description?: string | null;
  partNo?: string | null;
  lineItem?: string | null;
}

export interface AiClassifyResult {
  /** Chosen FUNCTIONAL domain id (the only dimension that owns responsibility). */
  categoryId: number | null;
  /** 0–100. The model's own confidence, clamped. Null when unclassified. */
  confidence: number | null;
  /** The domain name the model chose, for the audit trail. */
  matchedTerm: string | null;
  /** Subcategories (قواطع/PLC/…) the model recognised — a suggestion only. */
  subcategoryIds: number[];
  /** Manufacturer, when recognised. Metadata only — never decides the domain. */
  brandId: number | null;
  /** Extracted technical attributes (Voltage/Current/Model/…), free-form. */
  attributes: Record<string, string> | null;
  /** Why the domain was chosen — shown to the manager for review. */
  reason: string | null;
}

/**
 * Ask the model to classify a BATCH of items in one request.
 *
 * Batching matters: a customer RFQ can carry dozens of lines, and one request
 * per line would multiply latency and cost for no benefit. The reply is indexed
 * by the item's position so the caller can map results back.
 *
 * Returns an array aligned to `items` (same order, same length). A `null` entry
 * means «could not classify» — the caller keeps those unassigned (or retries
 * with the keyword classifier). Returns `null` for the WHOLE batch only when no
 * request could be made at all (unconfigured / provider error).
 */
export async function classifyItemsWithAi(
  items: AiClassifyInput[],
  categories: CategorySeed[],
): Promise<Array<AiClassifyResult | null> | null> {
  if (items.length === 0) return [];
  // EVERY active category is offered to the model, keyed by NAME. Filtering on
  // `code` (the old rule) silently dropped every operator-added category — most
  // of the catalogue has no code, so the model could only ever pick from the 5
  // seeded ones and everything else came back «غير معروف». The name is the
  // stable, human-facing key the operator manages; the code is optional.
  const usable = categories.filter((c) => c.name && c.name.trim().length > 0);
  if (usable.length === 0) return null;
  // No provider configured ⇒ return before any network attempt so the caller's
  // deterministic fallback is taken immediately (and tests never hit the wire).
  if (!isAiConfigured) return null;

  const settings = await loadSettings();
  if (!settings.enabled) return null;
  const primary = settings.model || DEFAULT_MODEL;
  const baseUrl = settings.baseUrl;
  // A reasoning primary is downgraded — thinking is wasted on a closed-list
  // choice and is exactly what emptied the reply. The ceiling then follows the
  // model actually used.
  const model = classifyModelFor(primary, baseUrl);
  const maxTokens = classifyMaxTokensFor(model);

  // The catalogue is offered as three SEPARATE closed lists, because the three
  // dimensions are not interchangeable: only a functional domain owns
  // responsibility, a subcategory refines it, and a brand is metadata. Handing
  // the model one mixed list is exactly how «Siemens» became a domain.
  const kinds = usable.map((c) => ({ c, kind: c.kind ?? "functional" }));
  const domains = kinds.filter((k) => k.kind !== "brand" && k.kind !== "subcategory");
  const subs = kinds.filter((k) => k.kind === "subcategory");
  const brands = kinds.filter((k) => k.kind === "brand");
  // A domain list is mandatory — without one there is nothing to choose from.
  if (domains.length === 0) return null;

  const byName = new Map(usable.map((c) => [normalizeCatName(c.name), c]));
  // Aliases are accepted as an answer too («ELEC» → كهرباء), so a deprecated
  // spelling resolves to the one canonical category instead of «غير معروف».
  for (const c of usable) {
    for (const a of c.aliases ?? []) {
      const key = normalizeCatName(a);
      if (key && !byName.has(key)) byName.set(key, c);
    }
  }

  const catalog = buildCatalog(domains, subs, brands);

  // A truncation retry sends a SMALLER batch: less input leaves more of the
  // budget for the reply, so the retry is a genuinely different request rather
  // than a blind repeat.
  let batch = items;
  for (let attempt = 1; attempt <= CLASSIFY_MAX_ATTEMPTS; attempt += 1) {
    const result = await callClassifier(model, baseUrl, batch, catalog, maxTokens);
    if (result === null) return null; // provider error — the caller falls back
    const parsed = parseClassifyReply(result.content, batch.length);
    if (parsed) return mapResults(parsed, items.length, byName);

    const truncated = result.finishReason === "length";
    const half = Math.max(MIN_BATCH, Math.ceil(batch.length / 2));
    if (truncated && half < batch.length) {
      logger.warn(
        { model, finish: result.finishReason, from: batch.length, to: half },
        "ai-classifier: reply truncated — re-asking with a smaller batch",
      );
      batch = batch.slice(0, half);
      continue;
    }
    logger.warn(
      { model: result.modelUsed ?? model, finish: result.finishReason, attempt },
      "ai-classifier: unparsable reply — falling back",
    );
    return null;
  }
  return null;
}

/** Render the three closed lists the model must choose from. */
function buildCatalog(
  domains: Array<{ c: CategorySeed }>,
  subs: Array<{ c: CategorySeed }>,
  brands: Array<{ c: CategorySeed }>,
): string {
  const lines: string[] = ["المجالات الوظيفية (main) — اختر واحدًا فقط لكل بند:"];
  lines.push(...domains.map((d) => `- ${d.c.name}`));
  if (subs.length > 0) {
    lines.push("", "التخصصات الفرعية (sub) — صفر أو أكثر، من هذه القائمة فقط:");
    lines.push(...subs.map((s) => `- ${s.c.name}`));
  }
  if (brands.length > 0) {
    lines.push("", "الماركات (brand) — صفر أو واحد، من هذه القائمة فقط:");
    lines.push(...brands.map((b) => `- ${b.c.name}`));
  }
  return lines.join("\n");
}

/** One provider request for a batch. Returns null when the request itself failed. */
async function callClassifier(
  model: string,
  baseUrl: string | null | undefined,
  batch: AiClassifyInput[],
  catalog: string,
  maxTokens: number,
): Promise<{ content: string | null; finishReason: string | null; modelUsed?: string } | null> {
  const listing = batch
    .map((it, i) => {
      const parts = [
        it.partNo ? `PartNo=${it.partNo}` : null,
        it.lineItem ? `LineItem=${it.lineItem}` : null,
        it.description ? `Desc=${it.description}` : null,
      ].filter(Boolean);
      return `${i + 1}. ${parts.join(" | ") || "(بند بلا وصف)"}`;
    })
    .join("\n");

  const prompt = [
    "أنت مصنّف بنود لمكتب مشتريات. لكل بند حدّد:",
    "1) المجال الوظيفي الرئيسي (main): واحد فقط من قائمة المجالات.",
    "2) التخصصات الفرعية (sub): صفر أو أكثر من قائمة التخصصات (إن وُجدت).",
    "3) الماركة (brand): صفر أو واحد من قائمة الماركات (إن وُجدت).",
    "4) المواصفات الفنية (attributes): Voltage/Current/Model/PartNumber إن ذُكرت.",
    "5) الثقة (confidence): 0-100. وسبب الاختيار (reason) بإيجاز.",
    "",
    catalog,
    "",
    "البنود:",
    listing,
    "",
    "قواعد إلزامية:",
    "- لا تخترع أي قيمة غير موجودة في القوائم أعلاه.",
    "- المجال الوظيفي لا يُستنتج من الماركة وحدها: الشركة الواحدة تنتج منتجات في مجالات مختلفة.",
    '- إن لم تتأكد من المجال اكتب main = "غير معروف" وconfidence = 0.',
    "- Encoder / PLC / قاطع ليست مجالات: هي تخصصات فرعية داخل مجالها.",
    "",
    'أعِد JSON فقط بالشكل: {"results":[{"i":1,"main":"<مجال أو غير معروف>","sub":["..."],"brand":"<ماركة أو فراغ>","confidence":0-100,"attributes":{"Voltage":"..."},"reason":"..."}]}',
  ].join("\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "أنت مصنّف بنود دقيق. تختار من قوائم مغلقة فقط، وتُعيد JSON صالحًا بلا أي نص إضافي.",
    },
    { role: "user", content: prompt },
  ];

  try {
    return await chatCompletion({
      model,
      baseUrl,
      messages,
      temperature: 0,
      maxTokens,
      toolChoice: "none",
    });
  } catch (err) {
    logger.warn({ err }, "ai-classifier: request failed — falling back");
    return null;
  }
}

/** Map parsed rows back to the caller's item order, refusing invented categories. */
function mapResults(
  parsed: Array<ParsedClassifyRow | null>,
  total: number,
  byName: Map<string, CategorySeed>,
): Array<AiClassifyResult | null> {
  const out: Array<AiClassifyResult | null> = new Array(total).fill(null);
  parsed.forEach((r, i) => {
    if (!r || !r.main || r.main === "غير معروف") return;
    const cat = byName.get(normalizeCatName(r.main));
    if (!cat) return; // the model invented a domain — refuse it
    // A brand or a subcategory may never be the MAIN answer: responsibility is
    // owned only by a functional domain. Refuse it rather than mis-own an item.
    const kind = cat.kind ?? "functional";
    if (kind === "brand" || kind === "subcategory") return;
    if (!(r.confidence > 0)) return;

    // Subcategories / brand are looked up in the SAME catalogue and only kept
    // when they are of the right kind — a suggestion, never a responsibility.
    const subcategoryIds: number[] = [];
    for (const s of r.sub) {
      const sub = byName.get(normalizeCatName(s));
      if (sub && (sub.kind ?? "functional") === "subcategory") subcategoryIds.push(sub.id);
    }
    const brand = r.brand ? byName.get(normalizeCatName(r.brand)) : undefined;
    const brandId = brand && (brand.kind ?? "functional") === "brand" ? brand.id : null;

    out[i] = {
      categoryId: cat.id,
      confidence: Math.max(1, Math.min(100, Math.round(r.confidence))),
      matchedTerm: cat.name,
      subcategoryIds: [...new Set(subcategoryIds)],
      brandId,
      attributes: r.attributes,
      reason: r.reason,
    };
  });
  return out;
}

interface RawRow {
  name?: unknown;
  main?: unknown;
  sub?: unknown;
  brand?: unknown;
  confidence?: unknown;
  attributes?: unknown;
  reason?: unknown;
}

export interface ParsedClassifyRow {
  /** The functional domain name, or «غير معروف». */
  main: string;
  /** Subcategory names the model recognised (may be empty). */
  sub: string[];
  /** Brand name, or null. */
  brand: string | null;
  confidence: number;
  /** Extracted technical attributes, or null. */
  attributes: Record<string, string> | null;
  /** Why the domain was chosen, or null. */
  reason: string | null;
}

/** Fold the cosmetic differences that make one category name look like two. */
export function normalizeCatName(s: string): string {
  return s
    .trim()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // harakat + tatweel
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[()\-–—_/.,]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Parse the model's JSON, tolerating a fenced code block or surrounding prose. */
export function parseClassifyReply(
  content: string | null,
  expected: number,
): Array<ParsedClassifyRow | null> | null {
  if (!content) return null;
  const json = extractJson(content);
  if (!json) return null;
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const rows = (data as { results?: unknown }).results ?? (Array.isArray(data) ? data : null);
  if (!Array.isArray(rows)) return null;

  const out: Array<ParsedClassifyRow | null> = new Array(expected).fill(null);
  for (const raw of rows as RawRow[]) {
    const i = Number((raw as { i?: unknown }).i);
    if (!Number.isInteger(i) || i < 1 || i > expected) continue;
    // Accept the multi-dimensional shape (`main`) and the legacy one (`name`),
    // so a model that echoes the older contract still classifies.
    const mainRaw =
      typeof raw.main === "string"
        ? raw.main.trim()
        : typeof raw.name === "string"
          ? raw.name.trim()
          : "";
    const confidence = Number(raw.confidence);
    out[i - 1] = {
      main: mainRaw,
      sub: Array.isArray(raw.sub)
        ? raw.sub
            .filter((s): s is string => typeof s === "string" && s.trim() !== "")
            .map((s) => s.trim())
        : [],
      brand: typeof raw.brand === "string" && raw.brand.trim() !== "" ? raw.brand.trim() : null,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      attributes: normalizeAttributes(raw.attributes),
      reason: typeof raw.reason === "string" && raw.reason.trim() !== "" ? raw.reason.trim() : null,
    };
  }
  return out;
}

/** Keep only string→string attribute pairs (the model may return numbers). */
function normalizeAttributes(value: unknown): Record<string, string> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    if (v == null) continue;
    const val = typeof v === "string" ? v.trim() : String(v).trim();
    if (val) out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractJson(content: string): string | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : content;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

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
import { DEFAULT_MODEL, isAiConfigured, loadSettings } from "../ai-assistant/config";
import { logger } from "../../shared/logger";
import type { CategorySeed } from "./classification";

export interface AiClassifyInput {
  description?: string | null;
  partNo?: string | null;
  lineItem?: string | null;
}

export interface AiClassifyResult {
  /** Chosen category id, or null when the model could not decide. */
  categoryId: number | null;
  /** 0–100. The model's own confidence, clamped. Null when unclassified. */
  confidence: number | null;
  /** The category code/name the model chose, for the audit trail. */
  matchedTerm: string | null;
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
  const model = settings.model || DEFAULT_MODEL;
  const baseUrl = settings.baseUrl;

  const catalog = usable.map((c) => `- ${c.name}`).join("\n");
  const listing = items
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
    "أنت مصنّف بنود لمكتب مشتريات. اختر لكل بند التصنيف الأنسب من القائمة التالية فقط:",
    catalog,
    "",
    "البنود:",
    listing,
    "",
    'أعِد JSON فقط بالشكل: {"results":[{"i":1,"name":"<اسم التصنيف أو غير معروف>","confidence":0-100}]}',
    'لا تخترع تصنيفًا غير موجود في القائمة. إن لم تكن متأكدًا اكتب name = "غير معروف" وconfidence = 0.',
  ].join("\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "أنت مصنّف بنود دقيق. تختار من قائمة مغلقة فقط، وتُعيد JSON صالحًا بلا أي نص إضافي.",
    },
    { role: "user", content: prompt },
  ];

  try {
    const result = await chatCompletion({
      model,
      baseUrl,
      messages,
      temperature: 0,
      maxTokens: 4000,
      toolChoice: "none",
    });
    const parsed = parseClassifyReply(result.content, items.length);
    if (!parsed) {
      logger.warn(
        { model: result.modelUsed, finish: result.finishReason },
        "ai-classifier: unparsable reply — falling back",
      );
      return null;
    }
    const byName = new Map(usable.map((c) => [normalizeCatName(c.name), c]));
    return parsed.map((r) => {
      if (!r || !r.name || r.name === "غير معروف") return null;
      const cat = byName.get(normalizeCatName(r.name));
      if (!cat) return null; // the model invented a category — refuse it
      if (!(r.confidence > 0)) return null;
      return {
        categoryId: cat.id,
        confidence: Math.max(1, Math.min(100, Math.round(r.confidence))),
        matchedTerm: cat.name,
      };
    });
  } catch (err) {
    logger.warn({ err }, "ai-classifier: request failed — falling back");
    return null;
  }
}

interface RawRow {
  name?: unknown;
  confidence?: unknown;
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
): Array<{ name: string; confidence: number } | null> | null {
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

  const out: Array<{ name: string; confidence: number } | null> = new Array(expected).fill(null);
  for (const raw of rows as RawRow[]) {
    const i = Number((raw as { i?: unknown }).i);
    if (!Number.isInteger(i) || i < 1 || i > expected) continue;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const confidence = Number(raw.confidence);
    out[i - 1] = { name, confidence: Number.isFinite(confidence) ? confidence : 0 };
  }
  return out;
}

function extractJson(content: string): string | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : content;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

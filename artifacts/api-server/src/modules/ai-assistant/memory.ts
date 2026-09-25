/**
 * AI Assistant — long-term memory.
 *
 * The assistant should GET BETTER over time instead of rediscovering the same
 * facts on every question. This module gives it durable memory, following the
 * patterns that have proven out in the open-source agent-memory projects:
 *
 *  - **Mem0** (mem0ai/mem0): extract *salient facts* from a conversation, then
 *    CONSOLIDATE — add / update / delete — instead of appending duplicates.
 *    That is why a memory is keyed by (phone, category, key): teaching the same
 *    key again UPDATES the stored value rather than piling up rows.
 *  - **Letta / MemGPT** (letta-ai/letta): the agent edits its own memory with
 *    tools, and the most relevant memories are always in context. Our tools are
 *    `remember_fact` / `recall_memory` / `forget_memory`, and the top matches
 *    are injected into the system prompt as "core memory".
 *  - **Graphiti / Zep**: a fact is TIME-SCOPED. A superseded fact is closed
 *    (`validUntil`) rather than destroyed, so history survives and we can tell
 *    "what is true now" from "what used to be true".
 *
 * Retrieval is DELIBERATELY LOCAL (keyword scoring, no embeddings). Every model
 * call here costs from the same 20-requests/day/model budget that already makes
 * the assistant look dead when it runs out; a vector lookup would need an
 * embedding model per read. A token-overlap score over a few hundred rows is
 * instant, costs no quota, and is fully testable.
 */
import { db, aiAssistantMemoriesTable, type AiAssistantMemory } from "@workspace/db";
import { and, eq, desc, isNull, or, sql } from "drizzle-orm";
import { logger } from "../../shared/logger";
import { checkMemoryWrite } from "./guardrails";

/** Memory families. `rule`/`lesson` are the ones the user explicitly asked for. */
export const MEMORY_CATEGORIES = ["fact", "preference", "entity", "rule", "lesson"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** Normalise a category, defaulting to `fact` for anything unrecognised. */
export function normalizeCategory(c: unknown): MemoryCategory {
  const s = String(c ?? "")
    .trim()
    .toLowerCase();
  return (MEMORY_CATEGORIES as readonly string[]).includes(s) ? (s as MemoryCategory) : "fact";
}

/**
 * Fold a memory key to a stable canonical form.
 *
 * Consolidation is only reliable if "milk price", "Milk  Price" and
 * "milk-price" map to the same slot. Arabic is normalised too (alef/hamza,
 * taa marbuta, yaa, harakat, tatweel) so «سعر السكر» and «سعر السكّر» agree.
 */
export function canonicalKey(key: string): string {
  const base = (key ?? "")
    .toString()
    .replace(/[\u064B-\u0652\u0640]/g, "") // harakat + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return base.slice(0, 120) || "memory";
}

/** Split text into comparable tokens (letters/digits), dropping stopwords. */
const STOPWORDS = new Set([
  "من",
  "في",
  "على",
  "عن",
  "الى",
  "إلى",
  "the",
  "a",
  "an",
  "of",
  "to",
  "is",
  "are",
  "was",
  "and",
  "or",
  "for",
  "with",
  "هو",
  "هي",
  "ان",
  "أن",
]);

export function tokenize(text: string): string[] {
  return (text ?? "")
    .toString()
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export interface MemoryInput {
  /** Owner phone; '' (or omitted) = company-wide shared memory. */
  phone?: string;
  category?: string;
  key: string;
  value: string;
  importance?: number;
  source?: string;
  pinned?: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Store a fact, CONSOLIDATING on (phone, category, key).
 *
 * This is Mem0's ADD/UPDATE decision collapsed to one upsert: a new key is
 * added, an existing key is updated in place (its superseded value does not
 * linger as a duplicate — the newest teaching wins). `pinned` and `importance`
 * are only overwritten when explicitly provided, so a later casual mention does
 * not demote a fact an admin pinned.
 */
export async function rememberFact(input: MemoryInput): Promise<AiAssistantMemory> {
  const phone = (input.phone ?? "").toString();
  const category = normalizeCategory(input.category);
  const key = canonicalKey(input.key || input.value);
  const value = (input.value ?? "").toString().trim().slice(0, 4000);
  if (!value) throw new Error("قيمة الذاكرة فارغة");

  // Refuse instruction-shaped or secret-shaped content BEFORE it reaches the
  // table. `remember_fact` takes its value from the model, and the model reads
  // mail — so this is the boundary where attacker-controlled text would become a
  // permanent instruction injected into every later conversation (OWASP ASI06).
  const rejection = checkMemoryWrite(value);
  if (rejection === "instruction") {
    logger.warn({ phone, category, key }, "AI assistant: refused instruction-shaped memory");
    throw new Error("لا يمكن حفظ نص يشبه تعليمات موجّهة للمساعد داخل الذاكرة");
  }
  if (rejection === "secret") {
    logger.warn({ phone, category, key }, "AI assistant: refused secret-shaped memory");
    throw new Error("لا يمكن حفظ بيانات حساسة (مفتاح/كلمة مرور) في الذاكرة");
  }

  const now = new Date();
  const [row] = await db
    .insert(aiAssistantMemoriesTable)
    .values({
      phone,
      category,
      key,
      value,
      importance: clamp(Number(input.importance ?? 50) || 50, 0, 100),
      source: input.source ? String(input.source).slice(0, 40) : "user",
      pinned: Boolean(input.pinned),
      validFrom: now,
    })
    .onConflictDoUpdate({
      target: [
        aiAssistantMemoriesTable.phone,
        aiAssistantMemoriesTable.category,
        aiAssistantMemoriesTable.key,
      ],
      set: {
        value,
        importance: sql`GREATEST(${aiAssistantMemoriesTable.importance}, ${clamp(
          Number(input.importance ?? 50) || 50,
          0,
          100,
        )})`,
        // Never silently un-pin, and never un-pin a pinned fact.
        pinned: sql`(${aiAssistantMemoriesTable.pinned} OR ${Boolean(input.pinned)})`,
        validUntil: null,
        updatedAt: now,
      },
    })
    .returning();
  logger.info({ phone, category, key }, "AI assistant: memory saved");
  return row;
}

/**
 * Score a memory against a query.
 *
 * Keyword overlap (weighted by importance and gently by recency and reuse) is
 * enough to pick a handful of relevant rows out of a few hundred, and it needs
 * no model call. A memory that matches nothing scores 0 and is simply not
 * returned — there is no "always inject everything" fallback.
 */
export function scoreMemory(
  mem: Pick<AiAssistantMemory, "key" | "value" | "importance" | "updatedAt" | "useCount">,
  queryTokens: string[],
): number {
  const q = new Set(queryTokens);
  if (!q.size) return 0;
  const hay = new Set([...tokenize(mem.key), ...tokenize(mem.value)]);
  let overlap = 0;
  for (const t of q) if (hay.has(t)) overlap += 1;
  if (!overlap) return 0;
  const coverage = overlap / q.size;
  const importance = clamp(Number(mem.importance ?? 50), 0, 100) / 100;
  const recencyDays = mem.updatedAt
    ? (Date.now() - new Date(mem.updatedAt).getTime()) / 86_400_000
    : 999;
  const recency = 1 / (1 + Math.max(0, recencyDays) / 30);
  const reuse = Math.min(0.1, (mem.useCount ?? 0) * 0.01);
  return coverage * 0.7 + importance * 0.2 + recency * 0.1 + reuse;
}

export interface RecallOptions {
  phone?: string;
  /** Free-text query; empty returns the most important/recent entries. */
  query?: string;
  category?: string;
  /** Max rows returned (default 12). */
  limit?: number;
  /** Include company-wide memories alongside the phone's own (default true). */
  includeShared?: boolean;
  /** Record the use against returned rows (default false — a prompt build). */
  trackUse?: boolean;
}

/**
 * Retrieve the memories most relevant to `query`.
 *
 * Reads the phone's own memories plus the shared ones, drops superseded facts
 * (`validUntil` in the past), ranks locally, and returns the top N. `trackUse`
 * bumps `useCount`/`lastUsedAt` so retrieval itself makes frequently-needed
 * facts rank higher over time — the "gets better with use" loop.
 */
export async function recallMemories(opts: RecallOptions = {}): Promise<AiAssistantMemory[]> {
  const phone = (opts.phone ?? "").toString();
  const limit = clamp(Number(opts.limit ?? 12) || 12, 1, 100);
  const scope =
    opts.includeShared === false || !phone
      ? eq(aiAssistantMemoriesTable.phone, phone)
      : or(eq(aiAssistantMemoriesTable.phone, phone), eq(aiAssistantMemoriesTable.phone, ""));

  let rows: AiAssistantMemory[];
  try {
    rows = await db
      .select()
      .from(aiAssistantMemoriesTable)
      .where(
        and(
          scope,
          opts.category
            ? eq(aiAssistantMemoriesTable.category, normalizeCategory(opts.category))
            : undefined,
          or(
            isNull(aiAssistantMemoriesTable.validUntil),
            sql`${aiAssistantMemoriesTable.validUntil} > NOW()`,
          ),
        ),
      )
      .orderBy(desc(aiAssistantMemoriesTable.pinned), desc(aiAssistantMemoriesTable.updatedAt))
      .limit(500);
  } catch (err) {
    logger.warn({ err }, "AI assistant: memory recall failed");
    return [];
  }

  // Pinned always survive; the rest rank by relevance to the query.
  const pinned = rows.filter((r) => r.pinned);
  const queryTokens = tokenize(opts.query ?? "");
  const scored = rows
    .filter((r) => !r.pinned)
    .map((r) => ({ r, s: queryTokens.length ? scoreMemory(r, queryTokens) : 0 }))
    .filter(({ s, r }) => (queryTokens.length ? s > 0 : true) || r.importance >= 70)
    .sort((a, b) => b.s - a.s || Number(b.r.importance) - Number(a.r.importance));

  const out = [...pinned, ...scored.map(({ r }) => r)].slice(0, limit);

  if (opts.trackUse && out.length) {
    try {
      await db
        .update(aiAssistantMemoriesTable)
        .set({
          useCount: sql`${aiAssistantMemoriesTable.useCount} + 1`,
          lastUsedAt: new Date(),
        })
        .where(
          sql`${aiAssistantMemoriesTable.id} in (${sql.join(
            out.map((m) => sql`${m.id}`),
            sql`, `,
          )})`,
        );
    } catch (err) {
      logger.warn({ err }, "AI assistant: memory use-tracking failed");
    }
  }
  return out;
}

/** Close a fact (soft delete): it stops counting as current but stays on record. */
export async function forgetMemory(opts: {
  phone?: string;
  key?: string;
  id?: number;
  /** Hard-delete instead of closing the validity window. */
  purge?: boolean;
}): Promise<number> {
  const phone = (opts.phone ?? "").toString();
  const where = opts.id
    ? and(
        eq(aiAssistantMemoriesTable.id, Number(opts.id)),
        or(eq(aiAssistantMemoriesTable.phone, phone), eq(aiAssistantMemoriesTable.phone, "")),
      )
    : and(
        eq(aiAssistantMemoriesTable.key, canonicalKey(opts.key ?? "")),
        or(eq(aiAssistantMemoriesTable.phone, phone), eq(aiAssistantMemoriesTable.phone, "")),
      );
  if (opts.purge) {
    const rows = await db
      .delete(aiAssistantMemoriesTable)
      .where(where)
      .returning({ id: aiAssistantMemoriesTable.id });
    return rows.length;
  }
  const rows = await db
    .update(aiAssistantMemoriesTable)
    .set({ validUntil: new Date(), updatedAt: new Date() })
    .where(
      and(
        where,
        or(
          isNull(aiAssistantMemoriesTable.validUntil),
          sql`${aiAssistantMemoriesTable.validUntil} > NOW()`,
        ),
      ),
    )
    .returning({ id: aiAssistantMemoriesTable.id });
  return rows.length;
}

/**
 * The block injected into the system prompt ("core memory").
 *
 * Deliberately small and labelled so the model treats it as things it ALREADY
 * KNOWS rather than as fresh tool output — and with an explicit instruction to
 * prefer live data when the two disagree, because a remembered price can be
 * stale while the database is current.
 */
export function renderMemoryBlock(memories: AiAssistantMemory[]): string {
  if (!memories.length) return "";
  const label: Record<string, string> = {
    fact: "معلومة",
    preference: "تفضيل",
    entity: "جهة/كيان",
    rule: "قاعدة",
    lesson: "درس مستفاد",
  };
  const lines = memories.map(
    (m) =>
      `- [${label[m.category] ?? m.category}] ${m.key}: ${m.value}${m.pinned ? " (مثبّتة)" : ""}`,
  );
  return (
    "\n\nذاكرتك طويلة المدى (أشياء تعلّمتها من قبل — اعتبرها معلومة تعرفها بالفعل):\n" +
    lines.join("\n") +
    "\nإن تعارضت أي معلومة محفوظة مع نتيجة أداة حديثة، فالأداة هي المصدر الأصح، وحدّث الذاكرة عند الحاجة."
  );
}

/**
 * Phrases that mean "remember this on purpose". Used by the local distiller.
 * Both Arabic and English so the assistant learns regardless of how the operator
 * phrases it.
 */
const TEACH_PATTERNS = [
  /افتكر\s+(?:إن|ان|أن)?\s*(.+)/i,
  /تذكر\s+(?:إن|ان|أن)?\s*(.+)/i,
  /خلي\s+في\s+بالك\s+(?:إن|ان|أن)?\s*(.+)/i,
  /من\s+الآن\s+(?:اعتبر|اعتبرها|خد\s+بالك)?\s*(.+)/i,
  /(?:اعتمد|اعمل)\s+القاعدة\s+(?:إن|ان|أن)?\s*(.+)/i,
  // An explicit RULE directive is a teaching even without «افتكر»: live, the
  // operator wrote «أريد منك تسجيل هذه القاعدة كـ قاعدة أساسية ثابتة … وتطبيقها
  // في جميع المهام المستقبلية المشابهة» — a standing instruction the assistant
  // must apply to every future request, not a one-off task description.
  /(?:سجل|خذ|اعتبر)\s+هذه\s+القاعدة\s*(.+)/i,
  /قاعدة\s+(?:أساسية|ثابتة)\s*(.+)/i,
  /\bremember\s+(?:that\s+)?(.+)/i,
];

/** Phrases that mean the assistant got something wrong — a lesson to keep. */
const CORRECTION_PATTERNS = [
  /(?:ده|دا|هذا|كده)\s*غلط/i,
  /مش\s+(?:كده|صحيح)/i,
  /(?:إنت|انت)\s+غلط/i,
  /الرقم\s+(?:اللي\s+)?(?:قلته|ذكرته)\s+غلط/i,
  /\bthat'?s\s+wrong\b/i,
];

function firstMatch(patterns: RegExp[], text: string): string | null {
  for (const re of patterns) {
    const m = re.exec(text || "");
    if (m) return (m[1] ?? m[0]).trim();
  }
  return null;
}

/**
 * Learn from a finished exchange WITHOUT spending a model call.
 *
 * The obvious "give the agent a distillation LLM step" is the wrong trade here:
 * the Gemini free tier caps each model at 20 requests/day, and the recorded
 * failure mode of this assistant is exactly that the quota runs out and it goes
 * silent. So learning is grounded in signals that need no inference:
 *
 *  1. the model itself called `remember_fact` during the turn (the primary,
 *     deliberate path — already stored, nothing to do here), and
 *  2. an explicit instruction in the operator's OWN words — «افتكر إن…»,
 *     «من الآن اعتبر…», or a correction («ده غلط»). That is a fact the user has
 *     literally stated, so storing it verbatim is safe and needs no model.
 *
 * Returns the memories actually written (for logging/tests). Never throws — a
 * learning failure must not affect the reply that was already produced.
 */
export async function distillMemories(opts: {
  phone: string;
  userText: string;
  assistantText: string;
}): Promise<AiAssistantMemory[]> {
  const userText = (opts.userText ?? "").trim();
  if (!userText) return [];
  const written: AiAssistantMemory[] = [];
  try {
    const teach = firstMatch(TEACH_PATTERNS, userText);
    if (teach && teach.length >= 3) {
      written.push(
        await rememberFact({
          phone: opts.phone,
          category: "rule",
          key: teach.slice(0, 80),
          value: teach,
          importance: 70,
          source: "distilled",
        }),
      );
    }
    // A correction is kept as a LESSON so the assistant does not repeat the
    // mistake — the "learn from mistakes" behaviour the operator asked for. The
    // stored value is the user's correction, not the assistant's wrong answer.
    if (CORRECTION_PATTERNS.some((re) => re.test(userText))) {
      const context = `${opts.assistantText.slice(0, 200)} ← صُحّح: ${userText}`;
      written.push(
        await rememberFact({
          phone: opts.phone,
          category: "lesson",
          key: `تصحيح: ${userText.slice(0, 60)}`,
          value: context.slice(0, 1000),
          importance: 65,
          source: "correction",
        }),
      );
    }
  } catch (err) {
    logger.warn({ err }, "AI assistant: memory distillation failed");
  }
  if (written.length)
    logger.info({ count: written.length }, "AI assistant: learned from conversation");
  return written;
}

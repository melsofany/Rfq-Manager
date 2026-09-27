/**
 * AI Assistant — configuration & access control
 *
 * The assistant is a WhatsApp agent restricted to admins/managers. A phone
 * number must be present (and active) in `ai_assistant_users`. Registration is
 * managed from the portal and is itself restricted to admin/manager roles.
 */
import { db, aiAssistantUsersTable, aiAssistantSettingsTable, employeesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../shared/logger";

/**
 * The DEFAULT provider is DeepSeek, not Gemini.
 *
 * Gemini's free tier caps EACH model at 20 requests/day, which was the single
 * biggest source of operator reports («الوكيل بيقف», quota errors, tasks failing
 * mid-run): the whole assistant went quiet once the day's budget was spent, and
 * an overloaded model could burn the completion budget on 503 retries before a
 * healthy one was ever reached. DeepSeek has no such per-model daily cap on this
 * key and was measured answering tool calls reliably (see `ai-deepseek.test.ts`
 * and the live probe: `deepseek-flash`, `deepseek-v4-pro` both returned
 * `tool_calls`).
 *
 * Gemini remains configured as the SECOND provider (it is still required for
 * voice notes and document reading, which DeepSeek cannot do), so the provider
 * chain simply inverts: DeepSeek primary, Gemini rescue.
 *
 * `AI_MODEL` still overrides everything, so a Gemini-only deployment is one env
 * var away (`AI_MODEL=gemini-3.6-flash`).
 */
export const DEFAULT_MODEL = process.env.AI_MODEL || "deepseek-v4-pro";

/**
 * Preferred model for FAST-path questions (a single lookup, a count).
 *
 * The prompt asks for model routing: a simple question must not pay for the
 * strongest model's cost, and — more importantly here — a fast path is a budget
 * decision. A one-record lookup does not need the deep model's reasoning, and
 * running it on a cheaper/faster model frees the primary's daily quota for the
 * analytical questions that actually need it. The id must be a model measured as
 * reliable on this endpoint (see FALLBACK_MODELS); it is skipped automatically if
 * it is exhausted, since it joins the same fallback chain.
 *
 * GEMINI-ONLY. On a DeepSeek request the light model is DeepSeek's own fast id
 * (the head of `DEEPSEEK_FALLBACK_MODELS`) — see `modelForPath`.
 */
export const FAST_MODEL = process.env.AI_FAST_MODEL || "gemini-3.1-flash-lite";
// Default to DeepSeek's OpenAI-compatible endpoint. Any OpenAI-compatible
// gateway still works by setting AI_BASE_URL; setting it back to the Gemini URL
// makes Gemini primary again.
export const DEFAULT_BASE_URL = process.env.AI_BASE_URL || "https://api.deepseek.com/v1";

/**
 * The Gemini endpoint, used for the capabilities DeepSeek does NOT have.
 *
 * Voice notes (ogg/opus) and document/PDF reading go through Gemini's native
 * `generateContent` + `inline_data`, which accepts any MIME type; DeepSeek has
 * no transcription endpoint and rejects PDFs. Those two features must therefore
 * keep pointing at Gemini even when the CHAT provider is DeepSeek — deriving
 * them from the chat base URL would silently disable both the moment the primary
 * switched, and a voice note would degrade to «تعذّرت القراءة» with no error.
 *
 * `AI_GEMINI_BASE_URL` overrides it; otherwise it is the Gemini OpenAI-compat
 * URL with the trailing `/openai` stripped by the caller that needs the native
 * path.
 */
export const GEMINI_BASE_URL =
  process.env.AI_GEMINI_BASE_URL ||
  process.env.GEMINI_BASE_URL ||
  "https://generativelanguage.googleapis.com/v1beta/openai";

/**
 * The Gemini model used for voice notes and document reading.
 *
 * Independent of `DEFAULT_MODEL`: when the chat provider is DeepSeek, feeding a
 * DeepSeek model id to Gemini's native endpoint would 404 on every transcription.
 * The chain of Gemini models is tried in `extractWithGemini`, and this is its
 * head — kept as a plain reliable Gemini id rather than derived from the chat
 * model.
 */
export const GEMINI_MEDIA_MODEL = process.env.AI_GEMINI_MEDIA_MODEL || "gemini-3.6-flash";

/**
 * Whether a MODEL ID is a Gemini model.
 *
 * Distinct from `isGeminiEndpoint`, which tests a URL. The media readers are
 * handed the CHAT model (DeepSeek in the default deployment) and must substitute
 * a Gemini id for it rather than send `deepseek-chat` to `generateContent`.
 * Kept as a simple prefix test because the ids are stable and a false negative
 * only costs the fallback chain one extra candidate.
 */
export function isGeminiModelId(model?: string | null): boolean {
  return /(^|\/)gemini[-.]/i.test(model || "");
}

/**
 * DeepSeek — the PRIMARY provider since the reliability rewrite.
 *
 * Gemini's free tier caps a single model at 20 requests/day, so the whole
 * assistant went quiet once the day's budget was spent; an overloaded model could
 * also burn the completion budget on 503 retries before a healthy one was tried.
 * DeepSeek has no such per-model daily cap on this key and speaks the same OpenAI
 * wire format, so it drops into the existing client with no new dependency.
 * Gemini stays configured as the second provider because the media readers below
 * still need its native endpoint.
 *
 * Two provider differences the client must handle:
 * - The reasoning variant (`deepseek-v4-pro`) returns `reasoning_content` on its
 *   assistant turns. The client captures it and echoes it back on a tool-call
 *   turn. Measured live (2026-09): the API currently ACCEPTS a tool-call turn
 *   with or without the field, so this is defensive compatibility with
 *   DeepSeek's documented thinking-mode contract rather than a workaround for an
 *   observed 400 — it preserves the real reasoning when present and supplies a
 *   placeholder when absent. See `withReasoningEcho` in `llm.ts`.
 * - There is no `/audio/transcriptions` endpoint and no PDF input (the files API
 *   accepts images only), so voice notes and PDFs are read by Gemini's native
 *   endpoint instead of by the chat provider. See
 *   `transcribeAudio`/`extractDocumentText`, which pin `GEMINI_BASE_URL`.
 */
export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
// `deepseek-v4-pro` is the flagship reasoning model; the models endpoint on this
// key lists exactly `deepseek-flash` (the alias `deepseek-chat`) and
// `deepseek-v4-pro`.
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";

/**
 * DeepSeek's own fallback chain: the fast/cheap model behind the reasoning one.
 *
 * `deepseek-chat` resolves to `deepseek-flash` and answered a tool call in ~1.0s
 * live (measured `tool_calls: true` with a real tool schema), so it is the
 * natural second try when the reasoning model is slow or unavailable. A 400
 * capability mismatch (an image part, say) advances the chain rather than
 * aborting it — see `isCapabilityMismatch`.
 */
export const DEEPSEEK_FALLBACK_MODELS = (process.env.DEEPSEEK_FALLBACK_MODELS || "deepseek-chat")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/**
 * DeepSeek key. A dedicated variable (not AI_API_KEY) because both providers are
 * configured at once — the Gemini key must keep working for voice notes and
 * document reading, which DeepSeek cannot do.
 */
export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";

/** True when the configured endpoint is DeepSeek. */
export function isDeepSeekEndpoint(baseUrl?: string | null): boolean {
  return /api\.deepseek\.com/i.test(baseUrl || "");
}

/**
 * Whether the DeepSeek fallback is available. Off unless a key is configured, so
 * a deployment that only set AI_API_KEY behaves exactly as before.
 */
export const isDeepSeekConfigured = Boolean(DEEPSEEK_API_KEY);

/**
 * Models tried, in order, when the primary model is unavailable or out of
 * quota (Gemini free tier is 20 requests/day/model). Only used on the Gemini
 * endpoint, where these ids exist. Override with AI_FALLBACK_MODELS.
 *
 * The chain is deliberately long: the free-tier quota is PER MODEL, so each
 * extra working model multiplies the daily request budget. Keep the ordering in
 * sync with `listModels()` output when Gemini retires ids.
 *
 * Ordered most-reliable-first (live probe, 5 requests each). An overloaded model
 * early in the chain is not free: its failed attempts spend the shared
 * completion budget, so a dead primary placed first can cost the run its whole
 * time allowance before a working model is ever tried. Keep the measured-reliable
 * models ahead of the flaky ones.
 */
export const FALLBACK_MODELS = (
  process.env.AI_FALLBACK_MODELS ||
  "gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-flash-latest,gemini-3.8-flash,gemini-3.7-flash"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

export interface AiSettings {
  enabled: boolean;
  model: string;
  baseUrl: string | null;
  systemPrompt: string | null;
  language: string;
  allowEmail: boolean;
  allowDatabase: boolean;
  /**
   * Free-form read-only SQL (`run_readonly_query`). Separate from
   * `allowDatabase` so general SQL can be granted without opening it everywhere.
   * Safe to default ON because the read-only guarantee is enforced in code (a
   * `BEGIN TRANSACTION READ ONLY` on the database plus a statement allowlist),
   * not by trusting the model — see `query-exec.ts`.
   */
  allowReadOnlySql: boolean;
  allowPdf: boolean;
}

export const DEFAULT_SETTINGS: AiSettings = {
  enabled: true,
  model: DEFAULT_MODEL,
  baseUrl: process.env.AI_BASE_URL || null,
  systemPrompt: null,
  language: "ar",
  allowEmail: true,
  allowDatabase: true,
  allowReadOnlySql: true,
  allowPdf: true,
};

export const AI_API_KEY =
  process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || "";

/**
 * True when the configured endpoint is Google Gemini. Gemini shares the OpenAI
 * wire format for chat/tools/vision, but differs in two ways that matter here:
 * a native `generateContent` endpoint must be used for WhatsApp voice notes
 * (the OpenAI-compat audio path rejects `ogg`), and Gemini 3 requires the
 * assistant tool-call turn's `thought_signature` to be echoed back.
 */
export function isGeminiEndpoint(baseUrl?: string | null): boolean {
  const base = baseUrl || DEFAULT_BASE_URL;
  return /generativelanguage\.googleapis\.com/i.test(base);
}

/**
 * Whether the assistant can run at all. True when EITHER provider has a key, so
 * a deployment that only set DEEPSEEK_API_KEY still works.
 */
export const isAiConfigured = Boolean(AI_API_KEY || DEEPSEEK_API_KEY);

/**
 * The model to use for a given route path. Fast-path questions use the light
 * model; every other path uses the configured primary. Falls back to the primary
 * when no dedicated fast model is configured (AI_FAST_MODEL="").
 *
 * The fast model is a Gemini id, so it is only applied when the primary is
 * Gemini. On another provider (DeepSeek) the id does not exist and would 404 on
 * every fast-path question — the primary is used instead.
 */
export function modelForPath(
  primary: string,
  path: "fast" | "deep",
  baseUrl?: string | null,
): string {
  if (path === "deep") return primary;
  // Detection mirrors `resolveProvider`: the model ID decides first (a Gemini id
  // sent to DeepSeek, or the reverse, 404s), then the endpoint. `baseUrl` is
  // usually null — the default endpoint is used — so checking only the primary id
  // against `DEEPSEEK_MODEL` would misroute an operator who picked `deepseek-chat`
  // and hand Gemini's fast id to DeepSeek.
  const isDeepSeek =
    /^deepseek/i.test(primary) ||
    (!isGeminiModelId(primary) && isDeepSeekEndpoint(baseUrl || DEFAULT_BASE_URL));
  if (isDeepSeek) {
    // Prefer a configured DeepSeek fallback as the light model; fall back to the
    // primary when none is set so routing can never leave no model to call.
    return DEEPSEEK_FALLBACK_MODELS[0] || primary;
  }
  return FAST_MODEL || primary;
}

const MAX_HISTORY = 12;

export async function loadSettings(): Promise<AiSettings> {
  try {
    const [row] = await db
      .select()
      .from(aiAssistantSettingsTable)
      .where(eq(aiAssistantSettingsTable.key, "default"))
      .limit(1);
    if (!row) return { ...DEFAULT_SETTINGS };
    return {
      enabled: row.enabled,
      model: row.model || DEFAULT_SETTINGS.model,
      baseUrl: row.baseUrl,
      systemPrompt: row.systemPrompt,
      language: row.language || "ar",
      allowEmail: row.allowEmail,
      allowDatabase: row.allowDatabase,
      allowReadOnlySql: row.allowReadOnlySql,
      allowPdf: row.allowPdf,
    };
  } catch (err) {
    logger.warn({ err }, "AI assistant: could not load settings, using defaults");
    return { ...DEFAULT_SETTINGS };
  }
}

/** Digits-only canonical phone form — matches how representatives are stored. */
export function canonicalPhone(phone: string): string {
  // eslint-disable-next-line no-control-regex
  let cleaned = phone.replace(
    /[\u2066\u2067\u2068\u2069\u200e\u200f\u202a\u202b\u202c\u202d\u202e]/g,
    "",
  );
  cleaned = cleaned.replace(/[^\d]/g, "");
  if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);
  if (cleaned.length === 11 && cleaned.startsWith("0")) cleaned = "2" + cleaned;
  if (cleaned.length === 10 && cleaned.startsWith("1")) cleaned = "20" + cleaned;
  return cleaned;
}

export interface AiAuthorizedUser {
  id: number;
  phone: string;
  name: string | null;
  employeeId: number | null;
  role: string;
}

/**
 * Resolve an allowlisted AI user for an incoming phone, verifying the linked
 * employee is still active. Returns null when the number is not authorized.
 */
export async function findAuthorizedUser(phone: string): Promise<AiAuthorizedUser | null> {
  const target = canonicalPhone(phone);
  const rows = await db
    .select()
    .from(aiAssistantUsersTable)
    .where(eq(aiAssistantUsersTable.isActive, true));
  const match = rows.find((r) => canonicalPhone(r.phone) === target);
  if (!match) return null;

  if (match.employeeId != null) {
    const [employee] = await db
      .select({ isActive: employeesTable.isActive })
      .from(employeesTable)
      .where(eq(employeesTable.id, match.employeeId))
      .limit(1);
    if (!employee || !employee.isActive) return null;
  }
  return {
    id: match.id,
    phone: canonicalPhone(match.phone),
    name: match.name,
    employeeId: match.employeeId,
    role: match.role,
  };
}

export { MAX_HISTORY };

/**
 * A quota error carries two different limits behind the same 429, and the
 * RETRY DELAY CANNOT TELL THEM APART: measured live, the free tier's DAILY cap
 * (`<...>PerDayPerProjectPerModel-FreeTier`, limit 20) answers «Please retry in
 * 25.7s» — indistinguishable from a per-minute cap if you only read the delay.
 * Waiting out that 25s and retrying loops on a limit that clears tomorrow.
 *
 * The `quotaId`/`quotaMetric` is the signal that does separate them, so the
 * classification keys on it. Any 429 WITHOUT the per-day marker is treated as
 * transient, because the costly mistake is the other direction: calling an
 * available model "out for the day" silences the assistant, while waiting out a
 * genuine daily cap only costs one wasted attempt.
 */
export function isDailyQuotaExhausted(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // PerDay / PerDayPerProject / daily limits are the ones that do NOT clear
  // within a reply budget.
  return /per\s*day|perday/i.test(message);
}

/** True when a quota error is worth waiting out rather than switching away from. */
export function isTransientQuota(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/per\s*day|perday/i.test(message)) return false;
  const field = /"retryDelay"\s*:\s*"([\d.]+)s"/i.exec(message);
  const phrase = /retry in ([\d.]+)s/i.exec(message);
  const seconds = field?.[1] ?? phrase?.[1];
  if (seconds == null) return false;
  const ms = Number(seconds) * 1000;
  return Number.isFinite(ms) && ms > 0 && ms <= 60_000;
}

export interface ProviderStatus {
  /**
   * A string literal, not the `ModelProvider` type from `llm.ts`: that module
   * imports THIS one, so pulling the type in here would create an import cycle.
   */
  provider: "gemini" | "deepseek";
  /** False when the provider has no key — it can only ever return 401. */
  configured: boolean;
  model: string;
}

/**
 * Which providers are actually usable, for the operator's dashboard.
 *
 * The distinction matters operationally: the failover chain is only as good as
 * the number of CONFIGURED providers, and with one key all of them share a
 * single daily budget. A dashboard that says "failover configured: 1" explains
 * an outage that a graph of model names cannot.
 */
export function providerStatus(): ProviderStatus[] {
  return [
    { provider: "gemini", configured: Boolean(AI_API_KEY), model: DEFAULT_MODEL },
    { provider: "deepseek", configured: isDeepSeekConfigured, model: DEEPSEEK_MODEL },
  ];
}

/** Number of providers that can actually answer — the failover capacity. */
export function configuredProviderCount(): number {
  return providerStatus().filter((p) => p.configured).length;
}

/**
 * Log the failover capacity at startup.
 *
 * The failover chain is only as good as the number of CONFIGURED providers, and
 * with one key every model shares a single 20-request/day budget. Diagnosing a
 * whole-assistant outage ("the provider quota is exhausted") from the outside is
 * near-impossible — the list of model names looks identical either way — so the
 * one fact that explains it is stated where the operator can see it.
 *
 * A missing key is reported as a WARNING, not info: it is a silent single point
 * of failure, not a normal state.
 */
export function logProviderCapacity(): void {
  const status = providerStatus();
  const ready = status.filter((p) => p.configured).map((p) => `${p.provider}:${p.model}`);
  if (ready.length === 0) {
    logger.error("AI assistant: NO provider configured — the assistant cannot answer");
  } else if (ready.length === 1) {
    logger.warn(
      { ready, single: true },
      "AI assistant: ONE provider configured — no failover when its daily quota is spent",
    );
  } else {
    logger.info({ ready }, "AI assistant: provider failover configured");
  }
}

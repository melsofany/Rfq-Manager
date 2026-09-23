/**
 * AI Assistant — OpenAI-compatible chat client with function/tool calling.
 *
 * Works with any OpenAI-compatible endpoint (OpenAI, Azure-compatible gateways,
 * OpenRouter, local vLLM/Ollama) by pointing AI_BASE_URL at it. Supports both
 * plain text turns and image turns (vision) via the multimodal content array.
 */
import { logger } from "../../shared/logger";
import {
  AI_API_KEY,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  FALLBACK_MODELS,
  isGeminiEndpoint,
} from "./config";

export type ChatRole = "system" | "user" | "assistant" | "tool";

/**
 * Cap on extracted document text handed to the model. Long enough for a full
 * supplier invoice or a couple of pages of a PO, short enough not to crowd out
 * the conversation or the tool results.
 *
 * Lives here rather than in `agent.ts` because the tool registry needs it too,
 * and `agent.ts` imports the registry — a shared home avoids the cycle.
 */
export const MAX_DOCUMENT_CHARS = 40_000;

export interface TextPart {
  type: "text";
  text: string;
}
export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}
export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /**
   * Gemini 3 returns an opaque `extra_content.google.thought_signature` on the
   * assistant tool-call turn and REQUIRES it to be echoed back on the next
   * request, otherwise the API returns 400. We keep the raw object so it
   * round-trips untouched.
   */
  extra_content?: { google?: { thought_signature?: string } };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  /** The model that actually produced this result (not necessarily the primary). */
  modelUsed?: string;
}

export class AiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "AiError";
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ceiling on ONE provider attempt. A request that has not answered in this long
 * is better abandoned than waited on: the operator is watching a chat window.
 */
const ATTEMPT_TIMEOUT_MS = Number(process.env.AI_ATTEMPT_TIMEOUT_MS) || 45_000;

/**
 * Ceiling on ALL attempts for one completion, across every retry and fallback.
 *
 * Without this, the worst case was candidates × attempts × attempt-timeout — 7
 * models × 2 × 90s ≈ 21 minutes. The reply was still generated, just long after
 * the operator had given up and concluded they were being ignored. A budget
 * makes the failure mode a prompt error message instead of silence.
 *
 * Read per call (not a constant) so tests can shorten it.
 */
export function completionBudgetMs(): number {
  return Number(process.env.AI_COMPLETION_BUDGET_MS) || 100_000;
}

/** True when an error means "we ran out of time", not "the model refused". */
export function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /abort|timed? ?out|budget/i.test(msg);
}

/** Single attempt against one model. Throws AiError; 429/503 are retryable. */
async function requestCompletion(opts: {
  model: string;
  base: string;
  body: string;
  /** Combined with the per-attempt timeout; aborts when the caller's budget ends. */
  signal?: AbortSignal;
}): Promise<ChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  // `AbortSignal.any` (with a fallback) so an expired overall deadline cancels
  // the in-flight request instead of the attempt running to its own timeout.
  const onOuterAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  try {
    const res = await fetch(`${opts.base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: opts.body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new AiError(`LLM request failed (${res.status}): ${text.slice(0, 300)}`, res.status);
    }
    const json = JSON.parse(text) as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: ToolCall[] };
        finish_reason?: string;
      }>;
    };
    const choice = json.choices?.[0];
    return {
      content: choice?.message?.content ?? null,
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason: choice?.finish_reason ?? null,
    };
  } catch (err) {
    if (err instanceof AiError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new AiError(`LLM request error: ${msg}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export async function chatCompletion(opts: {
  model: string;
  baseUrl?: string | null;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /**
   * "auto" lets the model call tools; "none" forbids it. Passing "none" on the
   * final round is what stops a tool-happy model from looping until the budget
   * runs out and leaving no answer to send.
   */
  toolChoice?: "auto" | "none";
  /**
   * Caller's overall deadline. Combined with the per-completion budget so a
   * multi-round agent run cannot outlive the time the operator is willing to
   * wait, no matter how many rounds or models it goes through.
   */
  signal?: AbortSignal;
}): Promise<ChatResult> {
  if (!AI_API_KEY) {
    throw new AiError("AI_API_KEY / OPENAI_API_KEY not configured");
  }
  const base = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const hasTools = Boolean(opts.tools && opts.tools.length);
  const toolChoice = opts.toolChoice ?? "auto";
  const buildBody = (model: string) =>
    JSON.stringify({
      model,
      messages: opts.messages,
      tools: hasTools ? opts.tools : undefined,
      tool_choice: hasTools ? toolChoice : undefined,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1600,
    });

  // Transient provider errors worth retrying on the SAME model. Measured
  // against Gemini: a 503 is usually a brief "high demand" blip that clears in
  // under a second, but 500/502/504 tend to persist for the whole request and
  // retrying them only delays the fallback. Only 503 is retried.
  const RETRYABLE = new Set([503]);
  const MAX_ATTEMPTS = 2;
  // 429 or 404 on the model means this model is exhausted/unavailable: move on
  // rather than retrying it. Gemini's free tier caps a single model at 20
  // requests/day, so switching is the only way to stay usable.
  const SWITCH_MODEL = new Set([429, 404]);
  /**
   * A 429 carrying `retryDelay` is a per-MINUTE limit, not the daily cap — the
   * model recovers in seconds and is usually the better model. Waiting it out
   * beats falling through to a weaker one, but only up to this bound: the
   * operator is waiting live, and a hint longer than this is better served by
   * switching models immediately.
   */
  const MAX_QUOTA_WAIT_MS = 5_000;
  const candidates = modelChain(opts.model);
  let lastError: AiError | null = null;

  // One deadline for the whole chain. Checked before each attempt so the chain
  // cannot start work it has no time to finish, and passed to the request so an
  // in-flight attempt is cancelled the moment the budget expires.
  const budgetMs = completionBudgetMs();
  const deadline = Date.now() + budgetMs;
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), budgetMs);
  // Also abort when the CALLER's deadline ends — that is the whole agent run's
  // budget, which is what the operator actually experiences.
  const onCallerAbort = () => budget.abort();
  if (opts.signal) {
    if (opts.signal.aborted) budget.abort();
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  /**
   * Time ONE model may consume before the chain moves on.
   *
   * Without this, an overloaded model that answers 503 slowly (observed: ~40s
   * per attempt live) spent the entire completion budget on its own retries, so
   * the reliable fallbacks were never reached and the operator got a timeout
   * instead of an answer. Sharing the budget evenly is what guarantees every
   * candidate gets a turn.
   */
  const perModelMs = Math.max(5_000, Math.floor(budgetMs / Math.max(candidates.length, 1)));

  try {
    outer: for (const model of candidates) {
      let waitedForQuota = false;
      const modelDeadline = Date.now() + perModelMs;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Stop the moment EITHER budget is spent. Checking the caller's signal
        // too means an expired agent-run budget ends the chain here instead of
        // walking the remaining models with requests that are already aborted.
        if (budget.signal.aborted || Date.now() >= deadline) {
          throw new AiError(`LLM request budget of ${budgetMs}ms exhausted before an answer`);
        }
        try {
          const result = await requestCompletion({
            model,
            base,
            body: buildBody(model),
            signal: budget.signal,
          });
          rememberWorkingModel(model);
          return { ...result, modelUsed: model };
        } catch (err) {
          if (!(err instanceof AiError)) throw err;
          lastError = err;
          const status = err.status;

          // A permanent error (bad request, auth) is the same on every model —
          // surface it immediately instead of burning the fallbacks.
          if (status != null && !SWITCH_MODEL.has(status) && !RETRYABLE.has(status)) {
            throw err;
          }

          if (status != null && SWITCH_MODEL.has(status)) {
            // Gemini states how long the limit lasts. Honour it once when it is
            // short, so a brief per-minute cap doesn't demote us to a weaker
            // model for the rest of the conversation.
            const delayMs = parseRetryDelayMs(err.message);
            if (
              status === 429 &&
              !waitedForQuota &&
              delayMs != null &&
              delayMs <= MAX_QUOTA_WAIT_MS &&
              Date.now() + delayMs < deadline
            ) {
              waitedForQuota = true;
              logger.info(
                { model, delayMs },
                "AI assistant: rate limited for a few seconds, waiting instead of downgrading",
              );
              await sleep(delayMs + 400);
              attempt--; // the wait is not a failed attempt against this model
              continue;
            }
            // No short retry given: this model is out for the day. Remember it so
            // the remaining tool-calling rounds don't re-probe it — each wasted
            // probe is a round-trip the operator waits through.
            if (delayMs == null) markModelExhausted(model);
            logger.warn(
              { model, status, retryAfter: delayMs != null ? delayMs / 1000 : undefined },
              "AI assistant: model unavailable, trying next model",
            );
            continue outer;
          }

          // Retryable (503 high demand): back off, retry the same model. Once its
          // attempts are spent, fall through to the next candidate rather than
          // failing — an overloaded model is exactly when a different model
          // succeeds.
          if (attempt < MAX_ATTEMPTS && Date.now() < modelDeadline) {
            if (Date.now() + 300 >= deadline) {
              throw new AiError(`LLM request budget of ${budgetMs}ms exhausted before an answer`);
            }
            await sleep(300);
          }
        }
      }
      logger.warn(
        { model, status: lastError?.status },
        "AI assistant: model exhausted, trying next",
      );
    }
    throw lastError ?? new AiError("LLM request failed");
  } finally {
    clearTimeout(budgetTimer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Models to try, in order, for one completion.
 *
 * The first choice is whatever last succeeded for this process. Without this,
 * every round of the same tool-calling conversation re-walked the chain from
 * the top: a primary model that is out for the day (429) got re-probed on each
 * of up to 5 rounds, adding a wasted round-trip each time — the difference
 * between a snappy answer and a visibly slow one. Known-exhausted models are
 * skipped entirely.
 */
function modelChain(primary: string): string[] {
  const preferred = lastWorkingModel();
  const ordered = [
    ...(preferred && preferred !== primary ? [preferred] : []),
    primary,
    ...FALLBACK_MODELS.filter((m) => m !== primary && m !== preferred),
  ];
  const usable = ordered.filter((m) => !isModelExhausted(m));
  // If every model is remembered as out, the memory is stale rather than the
  // world having ended — try them all again instead of failing instantly, so
  // the caller still surfaces the provider's own quota error.
  return usable.length > 0 ? usable : ordered;
}

/** Model that most recently answered, reused for the next request. */
let cachedWorkingModel: string | null = null;

function lastWorkingModel(): string | null {
  return cachedWorkingModel;
}

function rememberWorkingModel(model: string): void {
  if (cachedWorkingModel !== model) {
    cachedWorkingModel = model;
    logger.info({ model }, "AI assistant: using model");
  }
}

/**
 * Day-level quota exhaustion, keyed by model. Gemini's free tier is per-model
 * and resets daily, so an exhausted model is skipped for an hour — long enough
 * to stop the repeated probes, short enough to pick it back up after a reset.
 */
const exhaustedUntil = new Map<string, number>();
const EXHAUSTED_TTL_MS = 60 * 60 * 1000;

function markModelExhausted(model: string): void {
  exhaustedUntil.set(model, Date.now() + EXHAUSTED_TTL_MS);
}

function isModelExhausted(model: string): boolean {
  const until = exhaustedUntil.get(model);
  if (until == null) return false;
  if (Date.now() >= until) {
    exhaustedUntil.delete(model);
    return false;
  }
  return true;
}

/** Test seam: clear the model-selection memory between cases. */
export function resetModelState(): void {
  cachedWorkingModel = null;
  exhaustedUntil.clear();
}

/**
 * Parse the wait a provider asks for before retrying.
 *
 * Gemini returns both a `retryDelay` field and a human phrase ("Please retry in
 * 11.2s") in the 429 body; accept either. Returns null when the provider said
 * nothing, which is the signal that the limit is not a short one.
 */
export function parseRetryDelayMs(message: string): number | null {
  const field = /"retryDelay"\s*:\s*"([\d.]+)s"/i.exec(message);
  const phrase = /retry in ([\d.]+)s/i.exec(message);
  const seconds = field?.[1] ?? phrase?.[1];
  if (seconds == null) return null;
  const n = Number(seconds);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
}

/** True when the error means "this provider/model is out of capacity or quota". */
export function isQuotaError(err: unknown): boolean {
  return err instanceof AiError && (err.status === 429 || err.status === 503);
}

/**
 * List model ids available on the configured OpenAI-compatible endpoint.
 * Used by the admin UI to offer valid choices instead of free text.
 */
export async function listModels(baseUrl?: string | null): Promise<string[]> {
  if (!AI_API_KEY) return [];
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${AI_API_KEY}` },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? [])
      .map((m) => (m.id ?? "").replace(/^models\//, ""))
      .filter(Boolean)
      .sort();
  } catch (err) {
    logger.warn({ err }, "AI assistant: model listing failed");
    return [];
  }
}

/**
 * Transcribe an audio buffer (WhatsApp voice note). Returns null when
 * transcription is unavailable so the caller can degrade gracefully.
 *
 * Two backends:
 * - Gemini: the OpenAI-compatible surface has NO `/audio/transcriptions`
 *   endpoint (404) and its `input_audio` path only accepts wav/mp3 — WhatsApp
 *   sends ogg/opus. The native `generateContent` endpoint accepts any MIME type,
 *   so we post the raw bytes as `inline_data`. Gemini then answers the prompt
 *   with the transcript.
 * - OpenAI-compatible: `/audio/transcriptions` with whisper-1.
 */
export async function transcribeAudio(
  buffer: Buffer,
  mimeType: string,
  baseUrl?: string | null,
  model?: string | null,
): Promise<string | null> {
  if (!AI_API_KEY) return null;
  if (isGeminiEndpoint(baseUrl)) {
    return extractWithGemini(buffer, mimeType, TRANSCRIBE_PROMPT, baseUrl, model);
  }
  return transcribeWithWhisper(buffer, mimeType, baseUrl);
}

const TRANSCRIBE_PROMPT =
  "حوّل هذه الرسالة الصوتية إلى نص مكتوب كما هي، بنفس اللغة، دون أي إضافة أو تعليق. أعد النص فقط.";

/** What the model is asked to do with a document it cannot read as plain text. */
const DOCUMENT_PROMPT =
  "استخرج كل المعلومات المفيدة من هذا الملف: الأرقام، الأسماء، التواريخ، " +
  "البنود والكميات والأسعار، وأي جدول. اكتب النص المنظّم الذي يمكن الاعتماد " +
  "عليه كنصّ، بنفس اللغة، دون تعليق على الملف نفسه.";

/**
 * Read a document (PDF, image of a document, spreadsheet export) as text.
 *
 * Uses the same native `generateContent` + `inline_data` path as voice notes:
 * Gemini accepts PDF and image bytes directly, which avoids adding a PDF parser
 * (the Render image has no `pdftotext`) and handles scanned/photographed
 * documents that a text extractor cannot. Returns null when the endpoint is not
 * Gemini or the call fails — the caller then tells the operator it could not be
 * read rather than inventing an answer.
 */
export async function extractDocumentText(
  buffer: Buffer,
  mimeType: string,
  baseUrl?: string | null,
  model?: string | null,
): Promise<string | null> {
  if (!AI_API_KEY) return null;
  if (!isGeminiEndpoint(baseUrl)) return null;
  return extractWithGemini(buffer, mimeType, DOCUMENT_PROMPT, baseUrl, model);
}

/** MIME types Gemini reads as inline document data. */
export function isReadableDocumentMime(mimeType: string): boolean {
  const t = (mimeType || "").toLowerCase();
  return (
    t === "application/pdf" ||
    t.startsWith("image/") ||
    t === "text/plain" ||
    t === "text/csv" ||
    // A document mislabelled by the sender still has to be readable: EDC marks
    // real PDFs `application/doc`, and mail clients hand over unknown binary
    // parts as `application/octet-stream`. Content sniffing happens downstream;
    // refusing these by MIME alone is what left the attachments unreadable.
    t === "application/doc" ||
    t === "application/msword" ||
    t === "application/octet-stream"
  );
}

async function extractWithGemini(
  buffer: Buffer,
  mimeType: string,
  prompt: string,
  baseUrl?: string | null,
  model?: string | null,
): Promise<string | null> {
  // Voice notes and documents are a small share of traffic but still count
  // against the same per-model daily quota as text, so walk the same fallback
  // chain.
  const candidates = [model || DEFAULT_MODEL, ...FALLBACK_MODELS].filter(
    (m, i, arr) => arr.indexOf(m) === i,
  );
  for (const candidate of candidates) {
    const text = await extractWithGeminiModel(buffer, mimeType, prompt, baseUrl, candidate);
    if (text) return text;
  }
  return null;
}

async function extractWithGeminiModel(
  buffer: Buffer,
  mimeType: string,
  prompt: string,
  baseUrl: string | null | undefined,
  model: string,
): Promise<string | null> {
  try {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/openai$/, "");
    const res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": AI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: mimeType || "application/octet-stream",
                  data: buffer.toString("base64"),
                },
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, body: (await res.text()).slice(0, 300) },
        "AI assistant: Gemini transcription failed",
      );
      return null;
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return text.trim() || null;
  } catch (err) {
    logger.warn({ err }, "AI assistant: Gemini transcription error");
    return null;
  }
}

async function transcribeWithWhisper(
  buffer: Buffer,
  mimeType: string,
  baseUrl?: string | null,
): Promise<string | null> {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  try {
    const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : "m4a";
    const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
    const form = new FormData();
    form.append("file", blob, `audio.${ext}`);
    form.append("model", "whisper-1");
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AI_API_KEY}` },
      body: form,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { text?: string };
    return json.text?.trim() || null;
  } catch (err) {
    logger.warn({ err }, "AI assistant: audio transcription failed");
    return null;
  }
}

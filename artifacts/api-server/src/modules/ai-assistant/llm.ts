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

/** Single attempt against one model. Throws AiError; 429/503 are retryable. */
async function requestCompletion(opts: {
  model: string;
  base: string;
  body: string;
}): Promise<ChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
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
  }
}

export async function chatCompletion(opts: {
  model: string;
  baseUrl?: string | null;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}): Promise<ChatResult> {
  if (!AI_API_KEY) {
    throw new AiError("AI_API_KEY / OPENAI_API_KEY not configured");
  }
  const base = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const buildBody = (model: string) =>
    JSON.stringify({
      model,
      messages: opts.messages,
      tools: opts.tools && opts.tools.length ? opts.tools : undefined,
      tool_choice: opts.tools && opts.tools.length ? "auto" : undefined,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1600,
    });

  // Transient provider errors worth retrying on the SAME model.
  const RETRYABLE = new Set([500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  // 429 or 404 on the model means this model is exhausted/unavailable: move on
  // rather than retrying it. Gemini's free tier caps a single model at 20
  // requests/day, so switching is the only way to stay usable.
  const SWITCH_MODEL = new Set([429, 404]);
  const candidates = [opts.model, ...FALLBACK_MODELS.filter((m) => m !== opts.model)];
  let lastError: AiError | null = null;

  outer: for (const model of candidates) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await requestCompletion({ model, base, body: buildBody(model) });
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
          const retryAfter = /retry in ([\d.]+)s/i.exec(err.message)?.[1];
          logger.warn(
            { model, status, retryAfter },
            "AI assistant: model unavailable, trying next model",
          );
          continue outer;
        }

        // Retryable (503 high demand, network): back off, retry the same model.
        // Once its attempts are spent, fall through to the next candidate
        // rather than failing — an overloaded model is exactly when a
        // different model succeeds.
        if (attempt < MAX_ATTEMPTS) {
          await sleep(600 * attempt);
        }
      }
    }
    logger.warn({ model, status: lastError?.status }, "AI assistant: model exhausted, trying next");
  }
  throw lastError ?? new AiError("LLM request failed");
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
    return transcribeWithGemini(buffer, mimeType, baseUrl, model);
  }
  return transcribeWithWhisper(buffer, mimeType, baseUrl);
}

async function transcribeWithGemini(
  buffer: Buffer,
  mimeType: string,
  baseUrl?: string | null,
  model?: string | null,
): Promise<string | null> {
  // Voice notes are a small share of traffic but still count against the same
  // per-model daily quota as text, so walk the same fallback chain.
  const candidates = [model || DEFAULT_MODEL, ...FALLBACK_MODELS].filter(
    (m, i, arr) => arr.indexOf(m) === i,
  );
  for (const candidate of candidates) {
    const text = await transcribeWithGeminiModel(buffer, mimeType, baseUrl, candidate);
    if (text) return text;
  }
  return null;
}

async function transcribeWithGeminiModel(
  buffer: Buffer,
  mimeType: string,
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
              {
                text:
                  "حوّل هذه الرسالة الصوتية إلى نص مكتوب كما هي، بنفس اللغة، " +
                  "دون أي إضافة أو تعليق. أعد النص فقط.",
              },
              {
                inline_data: {
                  mime_type: mimeType || "audio/ogg",
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

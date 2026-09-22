/**
 * AI Assistant — OpenAI-compatible chat client with function/tool calling.
 *
 * Works with any OpenAI-compatible endpoint (OpenAI, Azure-compatible gateways,
 * OpenRouter, local vLLM/Ollama) by pointing AI_BASE_URL at it. Supports both
 * plain text turns and image turns (vision) via the multimodal content array.
 */
import { logger } from "../../shared/logger";
import { AI_API_KEY, DEFAULT_BASE_URL, DEFAULT_MODEL, isGeminiEndpoint } from "./config";

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
  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools && opts.tools.length ? opts.tools : undefined,
    tool_choice: opts.tools && opts.tools.length ? "auto" : undefined,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1600,
  });

  // Gemini (and other providers) occasionally return 429/503 under load. Retry
  // those twice with a short backoff before surfacing an error to the operator.
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  let lastError: AiError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AI_API_KEY}`,
        },
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        logger.error({ status: res.status, body: text.slice(0, 500) }, "AI assistant: LLM error");
        const err = new AiError(
          `LLM request failed (${res.status}): ${text.slice(0, 300)}`,
          res.status,
        );
        if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
          lastError = err;
          clearTimeout(timer);
          await sleep(600 * attempt);
          continue;
        }
        throw err;
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
      if (attempt < MAX_ATTEMPTS) {
        lastError = new AiError(`LLM request error: ${msg}`);
        await sleep(600 * attempt);
        continue;
      }
      throw new AiError(`LLM request error: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new AiError("LLM request failed");
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
  try {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/openai$/, "");
    const useModel = model || DEFAULT_MODEL;
    const res = await fetch(`${base}/models/${encodeURIComponent(useModel)}:generateContent`, {
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

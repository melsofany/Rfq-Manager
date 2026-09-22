/**
 * AI Assistant — OpenAI-compatible chat client with function/tool calling.
 *
 * Works with any OpenAI-compatible endpoint (OpenAI, Azure-compatible gateways,
 * OpenRouter, local vLLM/Ollama) by pointing AI_BASE_URL at it. Supports both
 * plain text turns and image turns (vision) via the multimodal content array.
 */
import { logger } from "../../shared/logger";
import { AI_API_KEY, DEFAULT_BASE_URL } from "./config";

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        tools: opts.tools && opts.tools.length ? opts.tools : undefined,
        tool_choice: opts.tools && opts.tools.length ? "auto" : undefined,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 1600,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      logger.error({ status: res.status, body: text.slice(0, 500) }, "AI assistant: LLM error");
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

/**
 * Transcribe an audio buffer via the OpenAI-compatible `/audio/transcriptions`
 * endpoint. Used for WhatsApp voice notes. Returns null when transcription is
 * unavailable so the caller can degrade gracefully.
 */
export async function transcribeAudio(
  buffer: Buffer,
  mimeType: string,
  baseUrl?: string | null,
): Promise<string | null> {
  if (!AI_API_KEY) return null;
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

/**
 * AI Assistant — Mastra model bridge.
 *
 * Exposes THIS project's provider layer (`chatCompletion` in `./llm`) to Mastra
 * as a `LanguageModelV3`. The point of the bridge is what it preserves: the
 * model chain, per-model daily-quota memory, the warm-model promotion, the
 * cross-provider rescue and the run-wide time budget all live in
 * `chatCompletion`. A stock AI-SDK provider would replace them with a single
 * endpoint and a single key — i.e. it would reintroduce the exact failure this
 * assistant was hardened against (one exhausted model and every message goes
 * unanswered).
 *
 * The bridge is deliberately thin: it translates prompt/result shapes and
 * delegates every routing decision to `chatCompletion`.
 *
 * `thought_signature`: Gemini 3 returns an opaque signature on its tool-call
 * turn and rejects the follow-up request without it. Mastra keeps
 * `providerOptions` on the tool-call part, so we carry the raw
 * `extra_content.google.thought_signature` through
 * `providerOptions.cortoba.thoughtSignature` and re-attach it on the way back
 * in. Without this the second tool round 400s on Gemini.
 */
import {
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3Message,
  type LanguageModelV3StreamPart,
  type LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { chatCompletion, type ChatMessage, type ToolCall } from "./llm";

const PROVIDER_ID = "cortoba";

/** Where we stash the Gemini thought signature on a tool-call part. */
interface CortobaToolCallOptions {
  thoughtSignature?: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => {
        if (p?.type === "text") return String(p.text ?? "");
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * `allowEmpty` distinguishes a genuinely empty assistant text turn from a
 * malformed one. An assistant turn that ONLY calls tools has no text, and
 * feeding it back as `null` (rather than "") is what the provider contract
 * expects.
 */
function toChatMessage(msg: LanguageModelV3Message): ChatMessage | null {
  const role = msg.role;

  if (role === "system") {
    return { role: "system", content: msg.content };
  }

  if (role === "user") {
    // Text-only user turns stay plain strings; an image turn becomes content
    // parts, because that is what the provider layer understands.
    const parts = msg.content.map((p: any) => {
      if (p?.type === "file" && typeof p.mediaType === "string" && p.mediaType.startsWith("image/")) {
        const url = typeof p.data === "string" ? p.data : null;
        if (url) return { type: "image_url" as const, image_url: { url } };
      }
      return { type: "text" as const, text: String(p?.text ?? "") };
    });
    const hasImage = parts.some((p) => p.type === "image_url");
    if (!hasImage) return { role: "user", content: parts.map((p: any) => p.text).join("") };
    return { role: "user", content: parts };
  }

  if (role === "assistant") {
    const calls: ToolCall[] = [];
    for (const p of msg.content as any[]) {
      if (p?.type !== "tool-call") continue;
      // The signature arrives on `providerMetadata`; either key shape is
      // accepted so the bridge works whichever provider produced the turn.
      const meta = p.providerMetadata?.[PROVIDER_ID] ?? p.providerOptions?.[PROVIDER_ID];
      calls.push({
        id: p.toolCallId,
        type: "function",
        function: {
          name: p.toolName,
          arguments: typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {}),
        },
        extra_content:
          meta?.thoughtSignature != null
            ? { google: { thought_signature: String(meta.thoughtSignature) } }
            : undefined,
      });
    }
    const text = textOf(msg.content);
    return {
      role: "assistant",
      content: text || null,
      tool_calls: calls.length ? calls : undefined,
    };
  }

  if (role === "tool") {
    // Mastra emits one tool-result message per result; the provider layer wants
    // the id, the name and the text.
    const p = (msg.content as any[])[0];
    if (!p) return null;
    const out = p.output;
    // A tool that answered with a string (our executor always does) must reach
    // the provider as that exact text — JSON-stringifying it would wrap the
    // whole result in quotes and break the model's reading of it.
    const content =
      typeof out?.value === "string"
        ? out.value
        : out?.type === "json"
          ? JSON.stringify(out.value)
          : String(out?.value ?? "");
    return {
      role: "tool",
      content,
      tool_call_id: p.toolCallId,
      name: p.toolName,
    };
  }

  return null;
}

function toChatMessages(options: LanguageModelV3CallOptions): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of options.prompt) {
    const converted = toChatMessage(m);
    if (converted) out.push(converted);
  }
  return out;
}

function toToolDefinitions(options: LanguageModelV3CallOptions) {
  if (!options.tools?.length) return undefined;
  return options.tools.map((t: any) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));
}

function toToolChoice(options: LanguageModelV3CallOptions): "auto" | "none" {
  const tc: any = options.toolChoice;
  if (!tc) return "auto";
  if (tc.type === "none") return "none";
  // "required" and a specific tool are both expressed as "auto" here: the
  // provider layer only distinguishes auto vs none, and forbidding tools is the
  // behaviour that matters (the final round must produce prose).
  return "auto";
}

/** Provider-layer usage is richer than Mastra needs; map the parts Mastra reads. */
function usageFrom(result: {
  promptTokens?: number;
  completionTokens?: number;
}): LanguageModelV3Usage {
  const input = result.promptTokens;
  const output = result.completionTokens;
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/**
 * A `LanguageModelV3` that answers every call through this project's
 * `chatCompletion`. `modelId` is the primary model id only — the actual chain,
 * fallbacks and quota handling are `chatCompletion`'s job, and `chatCompletion`
 * reports back which model really answered.
 */
export class CortobaLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = PROVIDER_ID;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly baseUrl?: string | null;

  constructor(modelId: string, baseUrl?: string | null) {
    this.modelId = modelId;
    this.baseUrl = baseUrl;
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const result = await chatCompletion({
      model: this.modelId,
      baseUrl: this.baseUrl,
      messages: toChatMessages(options),
      tools: toToolDefinitions(options) as any,
      toolChoice: toToolChoice(options),
      temperature: options.temperature,
      maxTokens: options.maxOutputTokens,
      signal: options.abortSignal,
    });

    const content: LanguageModelV3Content[] = [];
    if (result.content) {
      content.push({ type: "text", text: result.content } as LanguageModelV3Content);
    }
    for (const call of result.toolCalls) {
      const signature = call.extra_content?.google?.thought_signature;
      // The AI SDK contract for a tool call part: `input` is the RAW JSON
      // argument string, not a parsed object (Mastra calls `input.replace(...)`
      // on it), and provider-specific extras ride on `providerMetadata`.
      (content as any[]).push({
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.function.name,
        input: call.function.arguments,
        providerMetadata: signature ? { [PROVIDER_ID]: { thoughtSignature: signature } } : undefined,
      });
    }

    const finishReason = mapFinishReason(result.finishReason, result.toolCalls.length);
    const warnings: LanguageModelV3GenerateResult["warnings"] = [];
    // A cross-provider rescue is worth surfacing: the answer did not come from
    // the model the run asked for.
    if (result.modelUsed && result.modelUsed !== this.modelId) {
      warnings.push({
        type: "compatibility",
        feature: "model",
        details: `answered by ${result.modelUsed} (${result.providerUsed ?? "?"}) after a fallback`,
      } as any);
    }

    return {
      content,
      finishReason,
      usage: EMPTY_USAGE,
      warnings,
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }> {
    // Non-streaming internally, replayed as a stream: this assistant answers over
    // WhatsApp in one message, so there is nothing to stream to a UI. Emitting a
    // single text block keeps Mastra's streaming path functional without a second
    // implementation of the provider contract.
    const generated = await this.doGenerate(options);
    const parts: LanguageModelV3StreamPart[] = [
      { type: "stream-start", warnings: generated.warnings },
    ];
    for (const part of generated.content as any[]) {
      if (part.type === "text") {
        parts.push({ type: "text-start", id: "t0" });
        parts.push({ type: "text-delta", id: "t0", delta: part.text });
        parts.push({ type: "text-end", id: "t0" });
      } else {
        parts.push(part);
      }
    }
    parts.push({
      type: "finish",
      usage: generated.usage,
      finishReason: generated.finishReason,
    });
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    });
    return { stream };
  }
}

function mapFinishReason(
  raw: string | null,
  toolCallCount: number,
): { unified: LanguageModelV3GenerateResult["finishReason"]["unified"]; raw: string | undefined } {
  const reason = (raw ?? "").toLowerCase();
  const unified: LanguageModelV3GenerateResult["finishReason"]["unified"] =
    toolCallCount > 0
      ? "tool-calls"
      : reason.includes("length")
        ? "length"
        : reason.includes("content_filter") || reason.includes("safety")
          ? "content-filter"
          : reason.includes("error")
            ? "error"
            : "stop";
  return { unified, raw: raw ?? undefined };
}

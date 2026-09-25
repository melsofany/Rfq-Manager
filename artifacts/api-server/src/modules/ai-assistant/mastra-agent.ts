/**
 * AI Assistant — Mastra tool-loop engine.
 *
 * Runs the tool-calling rounds with Mastra's `Agent` while keeping THIS
 * project's guarantees intact:
 *
 *  - tools are the existing registry (`toolDefinitions` / `executeTool`), so
 *    there is no second implementation to drift;
 *  - the model is `CortobaLanguageModel`, i.e. our `chatCompletion` chain with
 *    its per-model quota memory and cross-provider rescue;
 *  - the run's `AbortSignal` is passed through, so the whole answer still
 *    respects `AGENT_BUDGET_MS`;
 *  - it reports the RAW tool exchanges, so the caller derives groundings and
 *    numeric aggregates exactly as it does for the legacy loop. That keeps the
 *    evidence rules in one place instead of duplicating them per engine.
 *
 * What the engine deliberately does NOT own: grounded-number checks, entity
 * checks, numeric reconciliation and persistence. Those verify the ANSWER, not
 * the loop, and they run in `agent.ts` for whichever engine produced it.
 */
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { logger } from "../../shared/logger";
import { CortobaLanguageModel } from "./mastra-model";
import { executeTool, asText, toolDefinitions, type ToolContext } from "./tools";
import type { ChatMessage, ContentPart } from "./llm";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One tool exchange as it actually happened, for the caller's evidence ledger. */
export interface ToolExchange {
  name: string;
  args: unknown;
  content: string;
}

export interface ToolLoopResult {
  finalText: string | null;
  rounds: number;
  toolCallCount: number;
  exchanges: ToolExchange[];
}

/**
 * Hard ceiling on Mastra's own steps, independent of the caller's round budget.
 *
 * Mastra counts the model's finishing response as a step, so a run that calls
 * tools on every round needs `rounds + 1` steps to also produce its answer.
 * The engine asks for `maxRounds + 1` and this caps it.
 */
const MAX_STEPS = 8;

export async function runToolLoop(opts: {
  model: string;
  baseUrl?: string | null;
  messages: ChatMessage[];
  ctx: ToolContext;
  maxRounds: number;
  signal: AbortSignal;
  phone: string;
}): Promise<ToolLoopResult> {
  const { ctx } = opts;

  // The registry is pure data, so it is reused verbatim. `executeTool` is
  // already the single executor (it owns the per-tool timeout, the resumable
  // census and the audit), so each Mastra tool is a thin adapter over it rather
  // than a re-implementation.
  const tools: Record<string, any> = {};
  for (const def of toolDefinitions(ctx)) {
    const name = def.function.name;
    tools[name] = createTool({
      id: name,
      description: def.function.description,
      // Mastra accepts a JSON schema here, which is what lets the existing
      // catalogue be reused instead of rewritten as zod.
      inputSchema: def.function.parameters as any,
      execute: async (inputData: any) => {
        const args = (inputData ?? {}) as Record<string, unknown>;
        const res = await executeTool(name, args, ctx);
        // Our executor already returns text for text results; only a structured
        // payload is flattened. Calling asText on a string would JSON-quote it.
        const text =
          typeof res.data === "string"
            ? res.data
            : res.ok
              ? asText(res.data)
              : `ERROR: ${res.error}`;
        return res.ok ? text : `ERROR: ${res.error}`;
      },
    });
  }

  const systemMessage = opts.messages.find((m) => m.role === "system");
  const turns = opts.messages.filter((m) => m.role !== "system");
  const instructions =
    typeof systemMessage?.content === "string"
      ? systemMessage.content
      : "أنت مساعد المشتريات. استخدم الأدوات للوصول إلى البيانات الموثوقة.";

  const agent = new Agent({
    id: "cortoba-procurement",
    name: "cortoba-procurement",
    instructions,
    model: new CortobaLanguageModel(opts.model, opts.baseUrl),
    tools,
  });

  // History is replayed as prior turns so a follow-up keeps its context. Each
  // stored turn becomes its own message rather than one concatenated blob.
  //
  // A turn carrying an IMAGE is kept as content parts. Flattening it to text
  // would drop the image silently — `asText` only reads text parts, so the
  // operator's photo would arrive as an empty string and the failure would look
  // like the model ignoring it.
  const isImageTurn = (m: ChatMessage) =>
    Array.isArray(m.content) && m.content.some((p) => p.type === "image_url");

  const history = turns.map((m) => {
    if (isImageTurn(m)) {
      return {
        role: "user" as const,
        content: (m.content as ContentPart[]).map((p) =>
          p.type === "image_url"
            ? { type: "image" as const, image: p.image_url.url, mediaType: "image/jpeg" }
            : { type: "text" as const, text: p.text },
        ),
      };
    }
    return {
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: typeof m.content === "string" ? m.content : asText(m.content),
    };
  });
  if (!history.length) history.push({ role: "user" as const, content: "(رسالة فارغة)" });

  const exchanges: ToolExchange[] = [];

  const result: any = await agent.generate(history as any, {
    // +1: the model's finishing response is counted as one of these steps.
    maxSteps: Math.max(1, Math.min(opts.maxRounds + 1, MAX_STEPS)),
    abortSignal: opts.signal,
    onStepFinish: (step: any) => {
      // Step payloads are read defensively: the shape is Mastra's, and a tool
      // call or result we cannot parse must not abort the answer.
      for (const tc of step?.toolCalls ?? []) {
        const call = tc?.payload ?? tc;
        exchanges.push({
          name: String(call?.toolName ?? "unknown"),
          args: call?.args ?? call?.input ?? {},
          content: "",
        });
      }
      for (const tr of step?.toolResults ?? []) {
        const res = tr?.payload ?? tr?.result ?? tr;
        const raw = res?.result ?? res?.output ?? res;
        // Only a structured result is flattened; a text result is already the
        // exact string the executor produced.
        const text = typeof raw === "string" ? raw : asText(raw);
        const name = String(res?.toolName ?? "unknown");
        // Attach the result to its matching call so the caller sees one
        // (call → result) pair per exchange.
        const match = [...exchanges].reverse().find((e) => e.name === name && !e.content);
        if (match) match.content = text;
        else exchanges.push({ name, args: {}, content: text });
      }
    },
  });

  const finalText = String(result?.text ?? "").trim() || null;
  const rounds = (result?.steps?.length as number | undefined) ?? 1;
  logger.info(
    { phone: opts.phone, rounds, toolCalls: exchanges.length, engine: "mastra" },
    "AI assistant: mastra tool loop complete",
  );

  return { finalText, rounds, toolCallCount: exchanges.length, exchanges };
}

/**
 * Whether the Mastra engine is selected.
 *
 * Defaults to the proven legacy loop ON PURPOSE. The Mastra engine is complete
 * and live-verified (a real Gemini tool round, provider failover and a real DB
 * answer), but four hardened behaviours still live only in the legacy loop:
 * identical-call dedup, the forced tool-free final round, stuck steering, and
 * the progress-based budget extension for a resumable census. Those are the
 * recorded fixes for the operator's reports («بيعيد نفس البحث», the assistant
 * going silent, a census abandoned mid-read), so switching the default before
 * they are ported would silently regress them.
 *
 * Enable for a live A/B with `AI_AGENT_ENGINE=mastra`; that is a one-variable,
 * no-redeploy rollback in the other direction too.
 */
export function mastraEngineEnabled(): boolean {
  return (process.env.AI_AGENT_ENGINE ?? "legacy").toLowerCase() === "mastra";
}

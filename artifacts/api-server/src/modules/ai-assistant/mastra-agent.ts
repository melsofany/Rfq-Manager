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
import {
  TaskTrace,
  steeringMessage,
  logTraceEvent,
  HARD_MAX_STEPS,
  toolCacheKey,
  FORCE_ANSWER_INSTRUCTION,
  type TraceSummary,
} from "./task-loop";
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
  /**
   * The engine's OWN execution trace (steps, tool errors, steers, forced
   * answers, distinct tools).
   *
   * It is returned rather than merely logged because the operator dashboard
   * reads the run trace from `recordMetrics`. The Mastra engine builds its own
   * `TaskTrace`, so without this the engine's control-flow work was invisible:
   * every Mastra answer reported `steps: 0, toolCalls: 0` while the log line
   * showed the real numbers — the dashboard silently described a different run
   * than the one that happened. `agent.ts` merges this over the legacy trace
   * (which is empty on this path) so both engines report the same shape.
   */
  taskTrace: TraceSummary;
}

/**
 * Hard ceiling on Mastra's own steps, independent of the caller's round budget.
 *
 * Mastra counts the model's finishing response as a step, so a run that calls
 * tools on every round needs `rounds + 1` steps to also produce its answer.
 * The engine asks for `maxRounds + 1` and this caps it.
 */
const MAX_STEPS = 8;

/**
 * One tool-free turn whose only job is to produce prose from what is already in
 * the transcript.
 *
 * Removing the tool schemas — rather than asking `tool_choice:"none"` — is what
 * reliably yields text: the recorded Gemini behaviour was to ignore the
 * instruction and keep calling tools until the budget was gone, leaving the
 * operator with silence. A per-run `maxRetries: 0` keeps it consistent with the
 * main agent (see the note there).
 */
async function answerWithoutTools(
  convo: any[],
  instructions: string,
  opts: { model: string; baseUrl?: string | null; signal: AbortSignal; phone: string },
): Promise<string | null> {
  const agent = new Agent({
    id: "cortoba-procurement-final",
    name: "cortoba-procurement-final",
    instructions,
    model: new CortobaLanguageModel(opts.model, opts.baseUrl),
    maxRetries: 0,
  });
  try {
    const res = await agent.generate(convo as any, { maxSteps: 1, abortSignal: opts.signal });
    return String(res?.text ?? "").trim() || null;
  } catch (err) {
    logger.warn({ err, phone: opts.phone }, "AI assistant: mastra forced-answer turn failed");
    return null;
  }
}

export async function runToolLoop(opts: {
  model: string;
  baseUrl?: string | null;
  messages: ChatMessage[];
  ctx: ToolContext;
  maxRounds: number;
  signal: AbortSignal;
  phone: string;
  /**
   * Remaining wall-clock budget for the whole run, in ms. The caller owns the
   * run's clock (it also drives the abort signal), so the budget extension
   * measures the REAL remainder rather than a per-segment elapsed time — an
   * extension granted against the wrong figure would either strand a resumable
   * census or overrun the operator's deadline.
   */
  remainingBudgetMs?: number;
}): Promise<ToolLoopResult> {
  const { ctx } = opts;
  const remainingBudget = (): number =>
    typeof opts.remainingBudgetMs === "number"
      ? Math.max(0, opts.remainingBudgetMs - (Date.now() - runStartedAt))
      : Number.POSITIVE_INFINITY;
  const runStartedAt = Date.now();

  // Per-run memo of tool results, keyed on the tool name + canonical arguments.
  // A model that re-issues an identical call (documented live: it repeats the
  // same search when the first result did not match its expectation) would
  // otherwise spend another scarce round on work already done — one of the
  // recorded causes of the assistant going silent on the free-tier quota. The
  // cache is scoped to this run only: a later question must see fresh data.
  //
  // A resumable census tool is deliberately EXEMPT. A second identical call is
  // the resume operation: the session cursor has advanced in shared cache and
  // must be allowed to return the next batch. Memoizing it made the model
  // receive the first partial batch forever, despite the prompt telling it to
  // continue.
  const toolCache = new Map<string, Promise<string>>();
  const RESUMABLE_TOOLS = new Set(["scan_email_items"]);

  const executeOnce = (name: string, args: Record<string, unknown>): Promise<string> => {
    const resumable = RESUMABLE_TOOLS.has(name);
    if (!resumable) {
      const cached = toolCache.get(toolCacheKey(name, args));
      if (cached) return cached;
    }
    const pending = (async () => {
      const res = await executeTool(name, args, ctx);
      // Our executor already returns text for text results; only a structured
      // payload is flattened. Calling asText on a string would JSON-quote it.
      if (!res.ok) return `ERROR: ${res.error}`;
      return typeof res.data === "string" ? res.data : asText(res.data);
    })();
    if (!resumable) toolCache.set(toolCacheKey(name, args), pending);
    return pending;
  };

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
        return executeOnce(name, args);
      },
    });
  }

  const systemMessage = opts.messages.find((m) => m.role === "system");
  const turns = opts.messages.filter((m) => m.role !== "system");
  const instructions =
    typeof systemMessage?.content === "string"
      ? systemMessage.content
      : "أنت مساعد المشتريات. استخدم الأدوات للوصول إلى البيانات الموثوقة.";

  // `maxRetries: 0` is deliberate, not a default left unset.
  //
  // `chatCompletion` already owns retrying: it retries a transient 503 on the
  // SAME model and then walks the fallback chain (429/404 switch immediately,
  // because Gemini's free tier caps each model at 20 requests/day). Mastra's own
  // retry sits ON TOP of that, so its default (2) multiplies the provider calls
  // per round: a single overloaded model could be probed three times before the
  // chain was even consulted. On a 20-req/day/model budget those extra calls are
  // what turns one slow model into a whole-day outage — the recorded
  // «مش بيرد عليا» failure. Retrying is the provider layer's job; the agent must
  // not do it a second time.
  const agent = new Agent({
    id: "cortoba-procurement",
    name: "cortoba-procurement",
    instructions,
    model: new CortobaLanguageModel(opts.model, opts.baseUrl),
    tools,
    maxRetries: 0,
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

  // ── Execution control, shared with the legacy loop ─────────────────────────
  // The same four hardened behaviours the legacy loop owns run here too, so
  // switching engines is not a silent regression:
  //   1. identical-call dedup (above, in `executeOnce`);
  //   2. a forced tool-free final round;
  //   3. stuck steering (change approach instead of looping);
  //   4. progress-based budget extension for a resumable census.
  //
  // They are implemented OUTSIDE Mastra's step machinery, by driving it in
  // segments: `maxSteps` is set exactly to the rounds currently granted, and
  // when the control layer grants an extension the next segment continues from
  // the full message history. This is deliberate — `prepareStep` cannot express
  // "stop now", and returning `activeTools: []` would ask a provider for a
  // tool-less turn with tools still declared, which is the exact
  // tool_choice="none" failure already seen with Gemini.
  const trace = new TaskTrace();
  let effectiveRounds = Math.max(1, opts.maxRounds);
  let steered = false;
  let extended = false;
  let forcedAnswer = false;
  let finalText: string | null = null;
  let rounds = 0;
  let consecutiveErrors = 0;
  let guard = 0;

  // The conversation as it advances. `generate` returns a COMPLETE message
  // array, so a segment always continues from the real transcript (including
  // the assistant's tool-call turns and every tool result) rather than a
  // reconstructed approximation.
  let convo: any[] = history;

  while (guard++ < MAX_STEPS) {
    const requestedSteps = Math.max(1, Math.min(effectiveRounds + 1, MAX_STEPS));
    const segmentSteps = Math.max(1, requestedSteps - rounds);
    const callStartedAt = Date.now();

    // Steps observed through the callback, used only when the provider/version
    // returns no `result.steps`. Without this fallback a run whose steps were
    // delivered solely as callbacks would have a POPULATED exchange ledger
    // (groundings, numeric aggregates) and an EMPTY control trace, so stuck
    // detection, the progress extension and the dashboard numbers would all read
    // zero on a run that clearly did work.
    const observedSteps: any[] = [];
    let result: any;
    try {
      result = await agent.generate(convo as any, {
        maxSteps: segmentSteps,
        abortSignal: opts.signal,
        onStepFinish: (step: any) => {
          if (step && typeof step === "object") observedSteps.push(step);
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
    } catch (err) {
      // A run that dies mid-segment (provider fault, abort) must not lose the
      // turns it already completed. Ask ONCE, with the tool schemas removed, for
      // an answer built from the evidence already in the transcript. Falling
      // straight through would hand the operator the generic "exhausted" notice
      // even when several successful tool results were sitting in the ledger —
      // the "census died mid-read and I got nothing" complaint. If even that
      // turn fails, the caller's own exhausted-answer fallback still applies.
      logger.warn(
        { err, phone: opts.phone, engine: "mastra", segmentSteps },
        "AI assistant: mastra segment failed",
      );
      finalText = await answerWithoutTools(convo, instructions, opts);
      break;
    }

    if (result?.modelUsed && result.modelUsed !== opts.model) {
      logger.info(
        { phone: opts.phone, modelUsed: result.modelUsed, providerUsed: result.providerUsed },
        "AI assistant: mastra engine used a fallback model",
      );
    }

    // Distinguish the model's finishing turn from a turn that ended on tool
    // calls: only the former carries the answer. The message list is preferred
    // because it also tells us how far the transcript got.
    const nextMessages = (result?.response?.messages ?? result?.response?.dbMessages) as
      any[] | undefined;
    const last = Array.isArray(nextMessages) ? nextMessages[nextMessages.length - 1] : undefined;
    const endedOnToolCall =
      last?.role === "assistant" && Array.isArray(last?.tool_calls)
        ? last.tool_calls.length > 0
        : false;

    if (Array.isArray(nextMessages) && nextMessages.length) convo = nextMessages;
    rounds = (result?.steps?.length as number | undefined) ?? rounds + segmentSteps;

    // ── Record the segment's steps for the execution control ────────────────
    // MUST happen before the answer check below. Mastra can end a segment on
    // prose AFTER calling tools inside it (maxSteps > 1), and breaking out first
    // dropped those tool steps: the exchange ledger was populated by the
    // callback while the control trace read zero, so the dashboard reported
    // `toolCalls: 0` for a run that clearly called tools — the exact telemetry
    // defect this trace was added to fix.
    // `result.steps` is the authoritative transcript; the callback buffer is the
    // fallback described above.
    const returnedSteps = (result?.steps ?? []) as any[];
    const steps = returnedSteps.length ? returnedSteps : observedSteps;
    steps.forEach((step, i) => {
      const calls = (step?.toolCalls ?? []).map((tc: any) => {
        const call = tc?.payload ?? tc;
        return { name: String(call?.toolName ?? "unknown"), args: call?.args ?? call?.input ?? {} };
      });
      const results = (step?.toolResults ?? []).map((tr: any) => {
        const res = tr?.payload ?? tr?.result ?? tr;
        const raw = res?.result ?? res?.output ?? res;
        return typeof raw === "string" ? raw : asText(raw);
      });
      trace.record({
        step: rounds - steps.length + i + 1,
        thought: String(step?.text ?? ""),
        toolCalls: calls,
        results,
      });
    });

    if (!endedOnToolCall) {
      finalText = String(result?.text ?? "").trim() || null;
      break;
    }

    const errCount = trace.summary().toolErrors;
    const noProgress = errCount > consecutiveErrors;
    consecutiveErrors = errCount;

    // ── Stuck handling (OpenManus `is_stuck` / `handle_stuck_state`) ───────
    // The recorded "fails at many tasks" behaviour is the model re-issuing the
    // same failing call until the round budget is gone. Steer it once — change
    // approach, or answer with what it has — instead of letting it loop.
    if (!steered && trace.isStuck()) {
      if (rounds + 1 >= MAX_STEPS) break;
      const reason = trace.stuckReason();
      trace.noteDetection();
      trace.noteSteering();
      steered = true;
      convo = [
        ...convo,
        {
          role: "user",
          content: steeringMessage(trace),
        },
      ];
      logTraceEvent(opts.phone, "stuck", { round: rounds, reason, engine: "mastra" });
      // A malformed-argument call is answered by correction, and a repeated
      // FAILING call is worth one more round to retry intelligently. A merely
      // repeated thought (no progress) gets no extension — that is the stall.
      if (reason === "repeated_failed_call" && effectiveRounds < HARD_MAX_STEPS) {
        effectiveRounds += 1;
        logTraceEvent(opts.phone, "extend", {
          to: effectiveRounds,
          reason,
          engine: "mastra",
        });
      }
      continue;
    }

    // ── Progress-based budget extension (OpenManus `max_steps` is a budget) ─
    // A run still producing NEW successful tool results may take one extra
    // round, so a multi-window census is not abandoned mid-read. Guarded by the
    // remaining budget and the hard cap so this can never loop on a dead run.
    if (
      !extended &&
      !steered &&
      !noProgress &&
      trace.canExtend(rounds, remainingBudget(), steered) &&
      effectiveRounds < HARD_MAX_STEPS &&
      rounds + 1 < MAX_STEPS
    ) {
      effectiveRounds += 1;
      extended = true;
      logTraceEvent(opts.phone, "extend", {
        to: effectiveRounds,
        reason: "progress",
        engine: "mastra",
      });
      continue;
    }

    // Rounds granted but not yet spent: keep looping. This is what makes the
    // planned budget (`plan.maxRounds`) mean anything — falling straight through
    // to the forced answer here would end every run after a single tool round,
    // which is precisely the "census abandoned mid-read" regression.
    if (rounds < effectiveRounds && rounds + 1 < MAX_STEPS) {
      continue;
    }

    // ── Forced tool-free final round ───────────────────────────────────────
    // Budget spent: run ONE more turn with the tool schemas removed so the
    // model cannot call a tool and must write the answer. Removing the schemas
    // (rather than asking `tool_choice:"none"`) is what reliably yields text —
    // the recorded Gemini behaviour was to ignore the instruction and keep
    // calling tools until the budget was gone, leaving the operator with
    // silence.
    if (requestedSteps >= MAX_STEPS) break;
    forcedAnswer = true;
    trace.noteForcedAnswer();
    logTraceEvent(opts.phone, "force", { round: rounds, engine: "mastra" });
    convo = [...convo, { role: "user", content: FORCE_ANSWER_INSTRUCTION }];
    finalText = await answerWithoutTools(convo, instructions, opts);
    break;
  }

  logger.info(
    {
      phone: opts.phone,
      rounds,
      toolCalls: exchanges.length,
      engine: "mastra",
      forcedAnswer,
      steered,
      extended,
      trace: trace.summary(),
    },
    "AI assistant: mastra tool loop complete",
  );

  return {
    finalText,
    rounds,
    toolCallCount: exchanges.length,
    exchanges,
    taskTrace: trace.summary(),
  };
}

/**
 * Whether the Mastra engine is selected.
 *
 * Defaults to the proven legacy loop. The Mastra engine is complete and
 * live-verified (a real Gemini tool round, provider failover and a real DB
 * answer) and now owns the same four hardened behaviours as the legacy loop —
 * identical-call dedup, the forced tool-free final round, stuck steering, and
 * the progress-based budget extension for a resumable census (see
 * `runToolLoop`). Those are the recorded fixes for the operator's reports
 * («بيعيد نفس البحث», the assistant going silent, a census abandoned mid-read),
 * and they are covered by the same guard tests through the shared `TaskTrace`.
 *
 * The default stays `legacy` only until an A/B against the live mailbox
 * confirms parity; the switch is one variable in either direction, with no
 * redeploy, so a regression is rolled back by unsetting `AI_AGENT_ENGINE`.
 */
export function mastraEngineEnabled(): boolean {
  return (process.env.AI_AGENT_ENGINE ?? "legacy").toLowerCase() === "mastra";
}

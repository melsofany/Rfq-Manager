/**
 * AI Assistant — unified agent engine.
 *
 * ## Why this exists
 *
 * There used to be TWO tool-calling loops in this module: a hand-written one in
 * `agent.ts` and a Mastra-backed one in `mastra-agent.ts`. They implemented the
 * SAME four hardened behaviours — identical-call dedup, stuck steering, the
 * progress-based budget extension and the forced tool-free final round — twice,
 * in different styles, over different providers. That is how a defect appeared in
 * one engine and not the other (the `job_status`/invented-progress incident was
 * diagnosed against one path while the other was live).
 *
 * This file is the ONE loop. Every guarantee is implemented once:
 *
 *  - model access goes through `chatCompletion`, so the model chain, the
 *    per-model daily-quota memory, the warm-model promotion, the cross-provider
 *    Gemini↔DeepSeek rescue and the run-wide time budget all apply unchanged.
 *    A stock agent framework would replace those with a single endpoint and a
 *    single key — i.e. it would reintroduce the failure this assistant was
 *    hardened against (one exhausted model and every message goes unanswered);
 *  - tools are the existing registry (`toolDefinitions` / `executeTool`), so
 *    there is no second implementation to drift;
 *  - control flow is the shared `TaskTrace` (OpenManus-style stuck detection and
 *    budget extension), so the dashboard reads the same numbers either way;
 *  - it reports the RAW tool exchanges, so `agent.ts` derives grounding, numeric
 *    aggregates and claim checks in ONE place.
 *
 * What this engine deliberately does NOT own: grounded-number checks, entity
 * checks, numeric reconciliation and persistence. Those verify the ANSWER, not
 * the loop, and they run in `agent.ts` for whichever engine produced it.
 */
import { logger } from "../../shared/logger";
import { chatCompletion, type ChatMessage, type ToolCall } from "./llm";
import { executeTool, asText, toolDefinitions, type ToolContext } from "./tools";
// Read from `./budgets`, not `./tools`: the engine must not depend on the tool
// registry for a timing constant, or a test that mocks the registry loses it and
// the guarantee silently becomes `undefined`.
import { ANSWER_RESERVE_MS, MIN_ANSWER_BUDGET_MS } from "./budgets";
import { filterToolDefinitions } from "./tool-scope";
import { wrapUntrustedOutput, unwrapUntrustedOutput } from "./guardrails";
import {
  TaskTrace,
  steeringMessage,
  logTraceEvent,
  HARD_MAX_STEPS,
  toolCacheKey,
  FORCE_ANSWER_INSTRUCTION,
  type TraceSummary,
} from "./task-loop";

/** One tool exchange as it actually happened, for the caller's evidence ledger. */
export interface ToolExchange {
  name: string;
  args: unknown;
  content: string;
  /**
   * False when the call failed (unknown tool, timeout, tool error). The caller
   * needs this to avoid reporting a failed call as work performed.
   */
  ok?: boolean;
}

export interface ToolLoopResult {
  finalText: string | null;
  rounds: number;
  toolCallCount: number;
  exchanges: ToolExchange[];
  /**
   * The engine's OWN execution trace (steps, tool errors, steers, forced
   * answers, distinct tools). It is returned rather than merely logged because
   * the operator dashboard reads the run trace from `recordMetrics`; without it
   * every answer reported `steps: 0, toolCalls: 0` while the log line showed the
   * real numbers — the dashboard silently described a different run than the one
   * that happened.
   */
  taskTrace: TraceSummary;
}

/**
 * Tool names whose output is RESUMABLE and must therefore never be memoized.
 *
 * A second identical call to one of these IS the resume operation: the session
 * cursor has advanced in the shared scan cache and the call must be allowed to
 * return the next batch. Memoizing it made the model receive the first partial
 * batch forever, despite the prompt telling it to continue.
 */
const RESUMABLE_TOOLS = new Set(["scan_email_items"]);

/** Parse a tool call's arguments defensively — a malformed payload must not throw. */
function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The engine's name, for the startup log and the metrics row.
 *
 * There is one engine now, so this is not a switch — it reports which provider
 * path the process is configured for so an operator reading the logs can see at
 * a glance that the model chain is the one in use.
 */
export function engineName(): string {
  return "unified";
}

/** Whether the assistant engine is available (always true; kept for parity). */
export function mastraEngineEnabled(): boolean {
  return true;
}

/**
 * Ask for an answer with the tool schemas REMOVED.
 *
 * Removing the schemas (rather than asking `tool_choice:"none"`) is what
 * reliably yields text: the recorded Gemini behaviour was to ignore the
 * instruction and keep emitting tool calls until the budget was gone, leaving
 * the operator with silence. Used both for the forced final round and as the
 * rescue when a provider faults mid-run.
 *
 * A truncated response is treated as NO answer, not as an empty one. A reasoning
 * model that exhausts `max_tokens` on its invisible thinking returns
 * `finish_reason:"length"` with `content:""` — and it does so exactly when the
 * question is hardest, which is when the operator most needs the reply. The
 * caller turns `null` into an honest notice; returning the empty string would
 * let an empty turn be sent as the answer.
 */
async function answerWithoutTools(
  messages: ChatMessage[],
  opts: {
    model: string;
    baseUrl?: string | null;
    signal: AbortSignal;
    phone: string;
    /** Instant by which the answer must be done (run deadline − reserve). */
    deadlineMs?: number;
  },
): Promise<string | null> {
  try {
    const res = await chatCompletion({
      model: opts.model,
      baseUrl: opts.baseUrl,
      messages,
      toolChoice: "none",
      signal: opts.signal,
      deadlineMs: opts.deadlineMs,
    });
    const text = String(res.content ?? "").trim();
    if (!text && res.finishReason === "length") {
      logger.warn(
        { phone: opts.phone, model: opts.model },
        "AI assistant: forced answer exhausted its token budget with no text",
      );
    }
    return text || null;
  } catch (err) {
    logger.warn({ err, phone: opts.phone }, "AI assistant: forced-answer turn failed");
    return null;
  }
}

/**
 * Run the tool-calling rounds to completion.
 *
 * The contract is unchanged from the loop it replaces: the caller passes the
 * routed tool scope, owns the run clock and the abort signal, and receives the
 * raw exchanges plus the control trace.
 */
export async function runToolLoop(opts: {
  model: string;
  baseUrl?: string | null;
  messages: ChatMessage[];
  ctx: ToolContext;
  maxRounds: number;
  signal: AbortSignal;
  phone: string;
  /**
   * Tool names this question may use, from `toolsForIntent`. `null`/undefined
   * keeps the full catalogue. Passed in rather than derived here so the engine
   * has no opinion about routing — the deterministic router owns that decision.
   */
  allowedTools?: string[] | null;
  /**
   * Remaining wall-clock budget for the whole run, in ms. The caller owns the
   * run's clock, so the budget extension measures the REAL remainder rather than
   * a per-segment elapsed time — an extension granted against the wrong figure
   * would either strand a resumable census or overrun the operator's deadline.
   */
  remainingBudgetMs?: number;
}): Promise<ToolLoopResult> {
  const { ctx } = opts;
  const runStartedAt = Date.now();
  const remainingBudget = (): number =>
    typeof opts.remainingBudgetMs === "number"
      ? Math.max(0, opts.remainingBudgetMs - (Date.now() - runStartedAt))
      : Number.POSITIVE_INFINITY;

  // Per-run memo of tool results, keyed on the tool name + canonical arguments.
  // A model that re-issues an identical call (documented live: it repeats the
  // same search when the first result did not match its expectation) would
  // otherwise spend another scarce round on work already done — one of the
  // recorded causes of the assistant going silent on the free-tier quota. The
  // cache is scoped to this run only: a later question must see fresh data.
  //
  // The PROMISE is cached rather than the value, because the calls in one round
  // already run concurrently via `Promise.all`: a second identical call in the
  // same round must join the in-flight request, not start a new one.
  const toolCache = new Map<string, Promise<string>>();

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
      const content = typeof res.data === "string" ? res.data : asText(res.data);
      // Mail/document text is attacker-controlled; the model must see where the
      // untrusted region begins and ends (OWASP ASI01). The raw content is what
      // the caller's evidence ledger parses, so only the string handed to the
      // model is wrapped.
      return wrapUntrustedOutput(name, content);
    })();
    if (!resumable) toolCache.set(toolCacheKey(name, args), pending);
    return pending;
  };

  // The catalogue is SCOPED to the routed intent: the model was measured
  // choosing the wrong tools from the full set and the right ones from a small
  // set, so the tools that cannot serve this question are removed rather than
  // discouraged in prose (see tool-scope.ts).
  const tools = filterToolDefinitions(toolDefinitions(ctx), opts.allowedTools ?? null);

  const trace = new TaskTrace();
  const exchanges: ToolExchange[] = [];
  const messages: ChatMessage[] = [...opts.messages];

  let effectiveRounds = Math.max(1, opts.maxRounds);
  let steered = false;
  let extended = false;
  let forcedAnswer = false;
  let finalText: string | null = null;
  let rounds = 0;

  /**
   * The instant a completion must be DONE by: the run's deadline minus the slice
   * kept for DELIVERING the answer (WhatsApp upload, session write).
   *
   * A completion started after this point cannot finish before the run ends, so
   * the loop must stop calling tools and speak with what it already has.
   */
  const answerDeadlineMs = (): number =>
    opts.ctx.deadline == null ? Number.POSITIVE_INFINITY : opts.ctx.deadline - ANSWER_RESERVE_MS;

  try {
    for (let round = 0; round < effectiveRounds; round++) {
      // Last round: forbid tool calls so the model has to answer with what it
      // already gathered. Without this a model that keeps calling tools drains
      // the budget and leaves nothing to send.
      const isLastRound = round === effectiveRounds - 1;
      const roundStartedAt = Date.now();

      // ── Fund the answer BEFORE spending another tool round ──────────────
      // A ~85s scan inside a 150s run leaves ~65s, which cannot fund a completion
      // that asks for its 100s allowance: the provider call is aborted and throws
      // «LLM request budget of 100000ms exhausted before an answer», on every
      // attempt, so the run ends with the generic notice AFTER the mail was read.
      // The tool's own ceiling does not prevent this — it is measured against the
      // RUN, not against the completion that must follow it.
      //
      // Answering now is strictly better than a round that cannot finish: the
      // operator gets text instead of a failure notice. The check is at the TOP
      // of the round rather than the bottom, so it also covers the first round of
      // a run that was already short on time when it started.
      if (!isLastRound && opts.ctx.deadline != null) {
        const leftAfterReserve = answerDeadlineMs() - Date.now();
        if (leftAfterReserve < MIN_ANSWER_BUDGET_MS) {
          logger.warn(
            { phone: opts.phone, round, leftAfterReserve, engine: engineName() },
            "AI assistant: no time left to fund another tool round — answering now",
          );
          forcedAnswer = true;
          trace.noteForcedAnswer();
          finalText = await answerWithoutTools(messages, {
            ...opts,
            deadlineMs: answerDeadlineMs(),
          });
          break;
        }
      }

      let result;
      try {
        result = await chatCompletion({
          model: opts.model,
          baseUrl: opts.baseUrl,
          messages,
          tools,
          toolChoice: isLastRound ? "none" : "auto",
          signal: opts.signal,
          deadlineMs: answerDeadlineMs(),
        });
      } catch (err) {
        // A provider fault (or an abort) must not throw away the turns already
        // completed. Ask ONCE, with the tool schemas removed, for an answer built
        // from the evidence already in the transcript. Falling straight through
        // would hand the operator the generic "exhausted" notice even when
        // several successful tool results were sitting in the ledger — the
        // "census died mid-read and I got nothing" complaint.
        //
        // But when NOTHING has been gathered yet there is no transcript to
        // salvage, and the fault must PROPAGATE rather than be dressed up as an
        // answer: the caller turns a thrown provider error into a quota/timeout
        // metric and an honest notice, whereas a swallowed one would look like a
        // normal reply built from no data.
        if (exchanges.length === 0) throw err;
        logger.warn(
          { err, phone: opts.phone, round, engine: engineName() },
          "AI assistant: provider round failed, answering from the transcript",
        );
        finalText = await answerWithoutTools(messages, { ...opts, deadlineMs: answerDeadlineMs() });
        break;
      }
      rounds += 1;

      if (result.toolCalls.length === 0) {
        // An EMPTY turn is not an answer. A reasoning model that spent its whole
        // `max_tokens` on thinking returns no text and `finish_reason:"length"`;
        // assigning that empty string let the run be reported as "answered"
        // while the operator received the generic «نفدت محاولات المعالجة» notice.
        // Leaving it null makes the caller say what actually happened.
        finalText = result.content?.trim() || null;
        if (!finalText && result.finishReason === "length") {
          logger.warn(
            { phone: opts.phone, model: opts.model, round },
            "AI assistant: answer truncated by the token budget",
          );
          // The thinking was cut short, so the evidence is already in the
          // transcript and the schema-free re-ask genuinely can differ (a smaller
          // request leaves more of the budget for the reply itself).
          finalText = await answerWithoutTools(messages, {
            ...opts,
            deadlineMs: answerDeadlineMs(),
          });
        }
        break;
      }

      // Some providers (observed: Gemini) still return tool calls under
      // tool_choice "none". Dropping the tool schemas entirely removes the
      // option and reliably yields text; if even that fails, report what did run
      // rather than silently swallowing the turn.
      if (isLastRound) {
        logger.warn(
          { providerToolChoiceIgnored: true, model: opts.model, calls: result.toolCalls.length },
          "AI assistant: model ignored tool_choice=none on the final round",
        );
        forcedAnswer = true;
        trace.noteForcedAnswer();
        finalText = await answerWithoutTools(messages, { ...opts, deadlineMs: answerDeadlineMs() });
        break;
      }

      // Echo the assistant's tool-call turn back into the conversation, then run
      // every call in THIS round concurrently. The calls in one round are chosen
      // together by the model and are independent, so awaiting them in sequence
      // only added latency (a 3-line item scan cost 3 round-trips).
      //
      // The raw `toolCalls` array is pushed as-is so a provider-specific opaque
      // field survives: Gemini 3 returns `extra_content.google.thought_signature`
      // on its tool-call turn and rejects the follow-up request without it.
      //
      // `reasoning_content` is carried through when the provider returned it
      // (DeepSeek thinking mode): the next request is rejected without it.
      messages.push({
        role: "assistant",
        content: result.content ?? null,
        tool_calls: result.toolCalls,
        reasoning_content: result.reasoningContent,
      });

      const calls = result.toolCalls.map((call) => ({ call, parsed: parseArgs(call) }));
      let dedupedCount = 0;
      const outcomes = await Promise.all(
        calls.map(async ({ call, parsed }) => {
          const key = toolCacheKey(call.function.name, parsed);
          const resumable = RESUMABLE_TOOLS.has(call.function.name);
          if (!resumable && toolCache.has(key)) dedupedCount += 1;
          const content = await executeOnce(call.function.name, parsed);
          // `ERROR:` prefix is how a failed call is represented in the
          // transcript, so `ok` is derived from it rather than carried
          // separately — a deduped repeat must report the same outcome.
          const ok = !content.startsWith("ERROR:");
          // Record the UNWRAPPED text: the caller's ledger parses these strings
          // as JSON, so a security delimiter left in place would silently disable
          // the numeric verifier and the resumable-census detection.
          const ledgerText = unwrapUntrustedOutput(content);
          exchanges.push({ name: call.function.name, args: parsed, content: ledgerText, ok });
          return { call, raw: content, ledgerText };
        }),
      );

      for (const o of outcomes) {
        messages.push({
          role: "tool",
          tool_call_id: o.call.id,
          name: o.call.function.name,
          content: o.raw,
        });
      }

      logger.info(
        {
          phone: opts.phone,
          round,
          ms: Date.now() - roundStartedAt,
          toolCalls: calls.map((c) => c.call.function.name),
          deduped: dedupedCount,
          engine: engineName(),
        },
        "AI assistant: tool round complete",
      );

      // Record the think/act cycle so the execution control below can see whether
      // this run is progressing, looping, or failing the same call repeatedly.
      trace.record({
        step: round + 1,
        thought: result.content ?? "",
        toolCalls: calls.map((c) => ({ name: c.call.function.name, args: c.parsed })),
        results: outcomes.map((o) => o.ledgerText),
      });

      // ── Stuck handling (OpenManus `is_stuck` / `handle_stuck_state`) ───────
      // The recorded "fails at many tasks" behaviour is the model re-issuing the
      // same failing call until the round budget is gone. Steer it once — change
      // approach, or answer with what it has — instead of letting it loop.
      if (!steered && trace.isStuck()) {
        const reason = trace.stuckReason();
        trace.noteDetection();
        trace.noteSteering();
        steered = true;
        messages.push({ role: "user", content: steeringMessage(trace) });
        logTraceEvent(opts.phone, "stuck", { round, reason, engine: engineName() });
        // A malformed-argument call is answered by correction, and a repeated
        // FAILING call is worth one more round to retry intelligently. A merely
        // repeated thought (no progress) gets no extension — that is the stall.
        if (reason === "repeated_failed_call" && effectiveRounds < HARD_MAX_STEPS) {
          effectiveRounds += 1;
          logTraceEvent(opts.phone, "extend", {
            to: effectiveRounds,
            reason,
            engine: engineName(),
          });
        }
      }

      // ── Progress-based budget extension (OpenManus `max_steps` is a budget) ─
      // A run whose latest tool EXPLICITLY reported more work is granted one more
      // round, so a multi-window census is not abandoned mid-read. Guarded by the
      // remaining budget and the hard cap so this can never loop on a dead run.
      if (
        !extended &&
        !steered &&
        trace.hasPendingWork() &&
        trace.canExtend(round + 1, remainingBudget(), steered) &&
        effectiveRounds < HARD_MAX_STEPS
      ) {
        effectiveRounds += 1;
        extended = true;
        logTraceEvent(opts.phone, "extend", {
          to: effectiveRounds,
          reason: "progress",
          engine: engineName(),
        });
      }
    }
  } finally {
    // Nothing to release: the run clock and abort signal are owned by the caller.
  }

  logger.info(
    {
      phone: opts.phone,
      rounds,
      toolCalls: exchanges.length,
      engine: engineName(),
      forcedAnswer,
      steered,
      extended,
      trace: trace.summary(),
    },
    "AI assistant: tool loop complete",
  );

  return {
    finalText,
    rounds,
    toolCallCount: exchanges.length,
    exchanges,
    taskTrace: trace.summary(),
  };
}

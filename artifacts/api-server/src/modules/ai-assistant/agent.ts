import { db, aiAssistantMessagesTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { logger } from "../../shared/logger";
import {
  chatCompletion,
  transcribeAudio,
  extractDocumentText,
  MAX_DOCUMENT_CHARS,
  isTimeoutError,
  isQuotaError,
  type ChatMessage,
  type ContentPart,
} from "./llm";
import { loadSettings, modelForPath, MAX_HISTORY, type AiSettings } from "./config";
import { recallMemories, renderMemoryBlock, distillMemories } from "./memory";
import {
  toolDefinitions,
  executeTool,
  asText,
  type ToolContext,
  type OutboxAttachment,
} from "./tools";
import { entityVocabulary, findUnknownEntityNames, type EntityName } from "./db-tools";
import { loadOrgProfiles, renderOrgProfilesBlock, type OrgProfile } from "./org-profiles";
import { routeQuestion, routeHint, DEEP_MAX_ROUNDS } from "./router";
import { resolveSourceChoice } from "./source-choice";
import { wrapUntrustedOutput } from "./guardrails";
import {
  TaskTrace,
  steeringMessage,
  logTraceEvent,
  HARD_MAX_STEPS,
  toolCacheKey,
} from "./task-loop";
import { runToolLoop, mastraEngineEnabled } from "./engine";
import type { ToolExchange } from "./engine";
import { checkClaims, checkJobClaims } from "./claim-check";
import { toolsForIntent, filterToolDefinitions } from "./tool-scope";
import type { TraceSummary } from "./task-loop";
import { verifyAnswer } from "./verifier";
import { sanitizeAssistantReply, hadToolMarkup } from "./reply-sanitize";
import { recordMetrics } from "./metrics";
import {
  loadConversationState,
  saveConversationState,
  renderConversationState,
  inferStatePatch,
} from "./conversation";
import { systemPrompt } from "./system-prompt";
import { EMAIL_TOOLS } from "./answer-guard";
import {
  answerConfidence,
  answerSource,
  collectToolTotals,
  exhaustedAnswer,
  findGroundingNumbers,
  findMailAccessFailure,
  findUngroundedNumbers,
  isRefusalSentence,
  looksLikeDataFound,
  noteMailAccessFailure,
  parseArgs,
  renderLearningLead,
  renderVocabularyBlock,
  verifyGroundedAnswer,
} from "./answer-guard";

/**
 * AI Assistant — agent loop.
 *
 * Runs a tool-calling conversation against the LLM: takes the operator's
 * message (text or image), lets the model call any registered tool, feeds the
 * results back, and loops until the model produces a final answer. Conversation
 * history is persisted per phone for multi-turn context.
 */

export { MAX_DOCUMENT_CHARS } from "./llm";

/**
 * Rounds allowed for the DEEP path (the router picks it per question). Kept as
 * an alias of the router's constant so there is one source of truth.
 */
export {
  answerConfidence,
  answerSource,
  collectToolTotals,
  exhaustedAnswer,
  findGroundingNumbers,
  findMailAccessFailure,
  findUngroundedNumbers,
  isRefusalSentence,
  looksLikeDataFound,
  noteMailAccessFailure,
  parseArgs,
  renderLearningLead,
  renderVocabularyBlock,
  verifyGroundedAnswer,
} from "./answer-guard";
export { systemPrompt } from "./system-prompt";
export { toolCacheKey };

export const MAX_TOOL_ROUNDS = DEEP_MAX_ROUNDS;

/**
 * Hard ceiling on one whole answer, across every tool round and model fallback.
 *
 * The operator is waiting live in a chat window. Past this, a late answer is
 * worse than an honest timeout: they have already given up and concluded they
 * are being ignored — the reported symptom. Set above the per-completion budget
 * so a single completion can use its full share, but far below the worst case of
 * rounds × models × attempts × timeout.
 */
export const AGENT_BUDGET_MS = Number(process.env.AI_RUN_BUDGET_MS) || 200_000;

/**
 * Rounds with the full toolset before the last one, which forbids tools. A
 * model that never stops calling tools would otherwise exhaust the budget and
 * leave `finalText` null — surfacing as "no final answer" to the operator.
 */
const FORCE_ANSWER_ON_LAST_ROUND = true;

/**
 * Least time that must remain in the run budget before a grounding-verification
 * round is attempted. The operator is waiting live: if there is not enough time
 * for another provider round-trip, shipping the answer as-is beats a timeout
 * notice. See `verifyGroundedAnswer`.
 */
export const VERIFY_MIN_REMAINING_MS = 30_000;

/**
 * Least time that must remain before a second re-ask is attempted, and the
 * ceiling on how many times one run may re-ask. The re-ask exists for the case
 * where the model met a genuinely empty result and gave up: it is worth one more
 * attempt, never an open loop (the operator is waiting and the quota is scarce).
 */
export const RETRY_MIN_REMAINING_MS = 35_000;
export const MAX_REFUSAL_REASKS = 1;

async function loadHistory(phone: string): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(aiAssistantMessagesTable)
    .where(eq(aiAssistantMessagesTable.phone, phone))
    .orderBy(desc(aiAssistantMessagesTable.id))
    .limit(MAX_HISTORY);
  return rows
    .reverse()
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

async function saveMessage(
  phone: string,
  role: string,
  content: string,
  toolCalls?: unknown,
): Promise<void> {
  try {
    await db.insert(aiAssistantMessagesTable).values({ phone, role, content, toolCalls });
  } catch (err) {
    logger.warn({ err, phone }, "AI assistant: failed to persist message");
  }
}

export interface AgentInput {
  phone: string;
  text?: string;
  imageUrl?: string;
  audio?: { buffer: Buffer; mimeType: string };
  /** A document the operator sent (PDF, spreadsheet, scanned image). */
  document?: { buffer: Buffer; mimeType: string; filename?: string };
}

export interface AgentOutput {
  reply: string;
  attachments: OutboxAttachment[];
}

/**
 * Load everything a turn needs before the tool loop: the audio transcript and
 * the attached document, the run's tool context and route, the parallel loads
 * (history, memories, vocabulary, state, organisation profiles), the prompt and
 * the message list, the scoped tool catalogue, and the grounding ledger.
 *
 * Returns the state the later phases share. Split out of `runAgent` with its
 * statements unchanged.
 */
async function prepareRun(input: AgentInput, settings: AiSettings) {
  let userText = input.text?.trim() || "";
  if (input.audio) {
    const transcript = await transcribeAudio(
      input.audio.buffer,
      input.audio.mimeType,
      settings.baseUrl,
      settings.model,
    );
    if (transcript) userText = transcript;
    else userText = userText || "[رسالة صوتية — تعذّر تحويلها إلى نص]";
  }

  // A document is read into text UP FRONT rather than handed to the model as a
  // tool result: the operator's question usually refers to it ("لخّص هذا الملف",
  // "ابحث عن البند ده"), so the model needs the contents in the same turn.
  let documentNote = "";
  if (input.document) {
    const extracted = await extractDocumentText(
      input.document.buffer,
      input.document.mimeType,
      settings.baseUrl,
      settings.model,
    );
    if (extracted) {
      documentNote =
        `\n\n[محتوى الملف المرفق «${input.document.filename || "ملف"}»:]\n` +
        extracted.slice(0, MAX_DOCUMENT_CHARS);
    } else {
      userText =
        userText ||
        `تعذّر قراءة الملف «${input.document.filename || "الملف"}» (${input.document.mimeType}).`;
    }
  }

  /** Real figures reported by data tools (row counts, totals, cuts). */
  const traceData: Array<Record<string, unknown>> = [];
  // The run deadline, known before any tool runs. `executeTool` clamps its own
  // ceiling to what is left of it, so a long tool returns a partial result the
  // model can still report instead of completing after the run has aborted.
  const runDeadline = Date.now() + AGENT_BUDGET_MS;
  const ctx: ToolContext = {
    settings,
    phone: input.phone,
    outbox: [],
    deadline: runDeadline,
    // Data tools report their REAL row counts / totals / cuts here, so the run's
    // figures are observable rather than inferred from the model's summary. The
    // "15 items" report could not be diagnosed from the transcript otherwise.
    trace: (summary) => traceData.push(summary),
  };

  // The router is deterministic and free: it classifies the question before any
  // provider request, so a simple lookup does not pay for the budget an analysis
  // needs (and vice versa). It never answers — it only allocates rounds and
  // supplies a short tool hint.
  const plan = routeQuestion(userText);
  // Rounds actually allowed for THIS question. The last one still forbids tools
  // (see FORCE_ANSWER_ON_LAST_ROUND) so an answer is always produced.
  //
  // This is a BUDGET, not a guillotine (OpenManus `max_steps` semantics): a run
  // that keeps producing real progress — the recorded failure is a resumable
  // census abandoned half-read — may be granted one extra round, up to
  // `HARD_MAX_STEPS`, while a run that is looping is stopped early by the
  // stuck detection below.
  const plannedRounds = plan.maxRounds;
  let effectiveRounds = plannedRounds;
  const trace = new TaskTrace();
  let steered = false;
  let extended = false;
  // Model routing (P6): a fast-path lookup runs on the light model so it does
  // not spend the primary model's daily quota, which the analytical questions
  // need. The light model is part of the same fallback chain, so an exhausted
  // fast model degrades to the regular chain automatically.
  const runModel = modelForPath(settings.model, plan.path, settings.baseUrl);

  // Independent loads run concurrently. Previously these were awaited in
  // sequence — history, then memories, then the vocabulary — which added their
  // latencies together on the path of every single question. Nothing here
  // depends on anything else in the group, so the only correct behaviour is to
  // overlap them.
  const [history, memories, vocabulary, conversationState, orgProfiles] = await Promise.all([
    loadHistory(input.phone),
    // Core memory: the memories most relevant to THIS message are injected into
    // the system prompt, so a fact taught weeks ago is available without the model
    // having to spend a tool round asking for it (and without the whole table
    // crowding the context). Retrieval is local keyword scoring — no model quota.
    recallMemories({
      phone: input.phone,
      query: userText,
      limit: 12,
      trackUse: true,
    }),
    // The real supplier/customer vocabulary, prefetched so the model can tell an
    // invented name from a real one. Two cheap selects, cached upstream — no model
    // quota spent, and it is what makes a name checkable before it is written
    // rather than after the operator challenges it.
    settings.allowDatabase
      ? entityVocabulary()
      : Promise.resolve({ suppliers: [] as EntityName[], customers: [] as EntityName[] }),
    // What the conversation was last about, so «وطب آخر سعر له؟» resolves "له"
    // without the operator restating the part. Read-only, best-effort.
    loadConversationState(input.phone),
    // What the assistant has LEARNED about each counterparty: their aliases,
    // mail domains and the FORMATS of the document numbers they issue
    // (`26R…` = EDC's RFQ, `P26E…` = their PO). Injected so a number it has
    // never seen is still recognised instead of guessed at. Best-effort: a read
    // failure degrades to "nothing learned yet".
    settings.allowDatabase ? loadOrgProfiles() : Promise.resolve([] as OrgProfile[]),
  ]);
  const memoryBlock = renderMemoryBlock(memories);
  const vocabularyBlock = renderVocabularyBlock(vocabulary);
  const stateBlock = renderConversationState(conversationState);
  const orgProfilesBlock = renderOrgProfilesBlock(orgProfiles);
  const learningLead = renderLearningLead({ memories, orgProfiles, vocabulary });

  const system: ChatMessage = {
    role: "system",
    content:
      systemPrompt(settings) +
      routeHint(plan) +
      stateBlock +
      memoryBlock +
      learningLead +
      vocabularyBlock +
      orgProfilesBlock,
  };

  let userContent: string | ContentPart[];
  if (input.imageUrl) {
    userContent = [
      { type: "text", text: (userText || "حلّل هذه الصورة وأخبرني بما تحتويه.") + documentNote },
      { type: "image_url", image_url: { url: input.imageUrl } },
    ];
  } else {
    userContent = (userText || "(رسالة فارغة)") + documentNote;
  }

  const messages: ChatMessage[] = [system, ...history, { role: "user", content: userContent }];

  // Scope the catalogue to what this question plausibly needs. The model was
  // measured choosing WRONG tools from the full 28-tool catalogue and RIGHT
  // tools from a small one — see tool-scope.ts. The router is deterministic, so
  // its classification is a free constraint; the prompt hint alone was ignored.
  const allTools = toolDefinitions(ctx);
  const allowedTools = toolsForIntent(plan.intent, plan.sourceScope);
  const tools = filterToolDefinitions(allTools, allowedTools);
  logger.info(
    { phone: input.phone, intent: plan.intent, tools: tools.length, total: allTools.length },
    "AI assistant: tool catalogue scoped",
  );
  // `ok` matters: the model can emit a tool name it was never offered, and the
  // exhausted-budget message must not report that as work performed (live: it
  // announced `run_readonly_query, search_database` on a mail question where the
  // database tools were not even in the catalogue).
  const usedTools: Array<{ name: string; args: unknown; ok: boolean }> = [];
  // Raw tool exchanges (name + args + the tool's OWN result text, before the
  // untrusted-content delimiters are added). The claim check parses this JSON to
  // compare the answer's claims against `matched`/`isComplete`; the delimited
  // text the model sees would not parse.
  const toolExchanges: ToolExchange[] = [];
  // Mailbox read failures seen in this run; see `findMailAccessFailure`.
  const mailFailureEvidence: string[] = [];
  let finalText: string | null = null;
  // Quantity totals the tools actually returned, WITH the tool that produced
  // each one. The numeric verifier reconciles a figure against the DATABASE, so
  // it must be handed the tool's OWN aggregate; without it the check fell back to
  // `extractReportedTotals(text)[0]` — the first large number in the prose — and
  // compared a YEAR («2025») or a Part Number («680632») against the sum of every
  // PO line. That produced the spurious
  // «المرصود 2025 والمحسوب 14265 … PARTIALLY_VERIFIED» caveat on correct answers.
  const toolAggregates: Array<{ tool: string; total: number }> = [];
  let rounds = 0;
  let fallbackUsed = false;
  // The model/provider that actually produced the answer. A cross-provider
  // rescue (Gemini quota spent, DeepSeek answered) is otherwise invisible: the
  // router's `runModel` would still be reported as if it had spoken.
  /**
   * The Mastra engine's own trace, when that engine ran.
   *
   * Set from `runToolLoop`'s result; left undefined on the legacy path, where
   * `trace` (above) is the authority.
   */
  let engineTrace: TraceSummary | undefined;
  let answeredModel: string | undefined;
  let answeredProvider: string | undefined;
  let verificationRan = false;
  let numericDisagreed = false;
  const startedAt = Date.now();

  // Per-run memo of tool results, keyed on the tool name + canonical arguments.
  // A model that re-issues an identical call (documented live: it repeats the
  // same search when the first result did not match its expectation) would
  // otherwise spend another scarce round on work already done — one of the
  // recorded causes of the assistant going silent on the free-tier quota. The
  // cache is scoped to this run only: a later question must see fresh data.
  const toolCache = new Map<string, Promise<string>>();
  // Grounding ledger: every token that appeared in a tool result (or was stated
  // by the operator). The verifier checks the final answer against this — see
  // `findUngroundedNumbers`.
  const groundedNumbers = new Set<string>();
  // Anything the operator, the conversation, the attached document, or the
  // learned memory already stated is fair game for the answer to quote back —
  // the verifier only challenges tokens the run itself introduced.
  for (const n of findGroundingNumbers(userText + documentNote + memoryBlock + vocabularyBlock)) {
    groundedNumbers.add(n);
  }
  for (const m of history) {
    if (typeof m.content === "string") {
      for (const n of findGroundingNumbers(m.content)) groundedNumbers.add(n);
    }
  }

  // Hard ceiling on the WHOLE run (every round, every model, every tool). The
  // operator is waiting in a chat window: past this point a late answer is
  // worse than an honest "it timed out", because they have already given up.
  const runBudget = new AbortController();

  return {
    input,
    settings,
    userText,
    documentNote,
    ctx,
    plan,
    trace,
    traceData,
    runModel,
    effectiveRounds,
    steered,
    extended,
    history,
    memoryBlock,
    vocabularyBlock,
    vocabulary,
    tools,
    allowedTools,
    messages,
    usedTools,
    toolExchanges,
    mailFailureEvidence,
    finalText: finalText as string | null,
    toolAggregates,
    rounds,
    fallbackUsed,
    engineTrace,
    answeredModel,
    answeredProvider,
    verificationRan,
    numericDisagreed,
    startedAt,
    toolCache,
    groundedNumbers,
    runBudget,
    mailFailure: null as string | null,
  };
}

/** Everything one turn accumulates. Phases read and write it in place. */
type RunState = Awaited<ReturnType<typeof prepareRun>>;

/** Run the tool loop on the Mastra engine (opt-in; the same evidence is rebuilt). */
async function runEngineLoop(s: RunState): Promise<void> {
  // Swap-in tool loop. Everything around it — the router's plan, the run
  // budget, the evidence ledger, verification, persistence and metrics —
  // stays exactly as it is, so the engine can be changed back with one env
  // var and nothing else in the pipeline has to be trusted twice.
  const loop = await runToolLoop({
    allowedTools: s.allowedTools,
    model: s.runModel,
    baseUrl: s.settings.baseUrl,
    messages: s.messages,
    ctx: s.ctx,
    maxRounds: s.plan.maxRounds,
    signal: s.runBudget.signal,
    phone: s.input.phone,
    // The engine's budget extension measures the REAL remainder of the run
    // budget, so it can never grant a round the operator's deadline cannot
    // afford (nor strand a resumable census it still has time to finish).
    remainingBudgetMs: AGENT_BUDGET_MS - (Date.now() - s.startedAt),
  });
  s.rounds = loop.rounds;
  s.finalText = loop.finalText;
  s.engineTrace = loop.taskTrace;
  // Rebuild the evidence ledger from the engine's raw exchanges, through the
  // SAME helpers the legacy loop uses, so the number check and the numeric
  // reconciliation behave identically on either engine.
  for (const ex of loop.exchanges) {
    s.usedTools.push({ name: ex.name, args: ex.args, ok: ex.ok !== false });
    s.toolExchanges.push(ex);
    if (ex.content.startsWith("ERROR:")) noteMailAccessFailure(s.mailFailureEvidence, ex.content);
    for (const n of findGroundingNumbers(ex.content)) s.groundedNumbers.add(n);
    for (const t of collectToolTotals(ex.name, ex.content)) {
      s.toolAggregates.push({ tool: ex.name, total: t });
    }
  }
}

/** Run the built-in tool loop: one model round per iteration, until an answer or the budget. */
async function runLegacyRounds(s: RunState): Promise<void> {
  for (let round = 0; round < s.effectiveRounds; round++) {
    // Last round: forbid tool calls so the model has to answer with what it
    // already gathered. Without this a model that keeps calling tools drains
    // the budget and leaves nothing to send.
    const isLastRound = FORCE_ANSWER_ON_LAST_ROUND && round === s.effectiveRounds - 1;
    const roundStartedAt = Date.now();
    const result = await chatCompletion({
      model: s.runModel,
      baseUrl: s.settings.baseUrl,
      messages: s.messages,
      tools: s.tools,
      toolChoice: isLastRound ? "none" : "auto",
      signal: s.runBudget.signal,
    });
    s.rounds += 1;
    if (result.modelUsed && result.modelUsed !== s.runModel) s.fallbackUsed = true;
    if (result.modelUsed) s.answeredModel = result.modelUsed;
    if (result.providerUsed) s.answeredProvider = result.providerUsed;

    if (result.toolCalls.length === 0) {
      s.finalText = result.content;
      break;
    }

    // Some providers (observed: Gemini) still return tool calls under
    // tool_choice "none". Dropping the tool schemas entirely removes the option
    // and reliably yields text; if even that fails, report what did run rather
    // than silently swallowing the turn.
    if (isLastRound) {
      logger.warn(
        {
          providerToolChoiceIgnored: true,
          model: s.runModel,
          calls: result.toolCalls.length,
        },
        "AI assistant: model ignored tool_choice=none on the final round",
      );
      const noTools = await chatCompletion({
        model: s.runModel,
        baseUrl: s.settings.baseUrl,
        messages: s.messages,
        toolChoice: "none",
      });
      s.rounds += 1;
      if (noTools.modelUsed && noTools.modelUsed !== s.runModel) s.fallbackUsed = true;
      if (noTools.modelUsed) s.answeredModel = noTools.modelUsed;
      if (noTools.providerUsed) s.answeredProvider = noTools.providerUsed;
      s.finalText = noTools.content ?? result.content ?? exhaustedAnswer(s.usedTools);
      break;
    }

    // Echo the assistant's tool-call turn back into the conversation, then run
    // every call in THIS round concurrently. The calls in one round are chosen
    // together by the model and are independent, so awaiting them in sequence
    // only added latency (a 3-line item scan cost 3 round-trips).
    //
    // `reasoning_content` is carried through when the provider returned it
    // (DeepSeek thinking mode): the next request is rejected without it. A
    // provider that returns none (Gemini) leaves the field unset, and
    // `withReasoningEcho` supplies the placeholder DeepSeek accepts.
    s.messages.push({
      role: "assistant",
      content: result.content ?? null,
      tool_calls: result.toolCalls,
      reasoning_content: result.reasoningContent,
    });

    const calls = result.toolCalls.map((call) => {
      const parsed = parseArgs(call);
      return { call, parsed };
    });
    let dedupedCount = 0;
    const outcomes = await Promise.all(
      calls.map(async ({ call, parsed }) => {
        // Identical (tool, args) in the SAME run: reuse the earlier result
        // instead of re-running the tool. The calls in one round already run
        // concurrently, so the promise is cached rather than the value.
        const key = toolCacheKey(call.function.name, parsed);
        // Resumable census tools intentionally MUST NOT be memoized. A second
        // identical call is the resume operation: the session cursor has
        // advanced in shared cache and must be allowed to return the next
        // batch. Memoizing it made the model receive the first partial 150
        // messages forever, despite the prompt telling it to continue.
        const resumable = call.function.name === "scan_email_items";
        let pending = resumable ? undefined : s.toolCache.get(key);
        if (pending) {
          dedupedCount += 1;
        } else {
          pending = (async () => {
            const res = await executeTool(call.function.name, parsed, s.ctx);
            if (!res.ok) noteMailAccessFailure(s.mailFailureEvidence, res.error);
            return res.ok ? asText(res.data) : `ERROR: ${res.error}`;
          })();
          if (!resumable) s.toolCache.set(key, pending);
        }
        const content = await pending;
        // `ERROR:` prefix is how a failed call is represented in the
        // transcript, so `ok` is derived from it rather than carried
        // separately — a deduped repeat must report the same outcome.
        const ok = !content.startsWith("ERROR:");
        s.toolExchanges.push({ name: call.function.name, args: parsed, content, ok });
        s.usedTools.push({ name: call.function.name, args: parsed, ok });
        for (const n of findGroundingNumbers(content)) s.groundedNumbers.add(n);
        // Collect the tool's OWN quantity aggregates (never a figure from the
        // prose) so the numeric verifier reconciles against what the database
        // actually returned rather than against the first large number in the
        // answer.
        for (const t of collectToolTotals(call.function.name, content))
          s.toolAggregates.push({ tool: call.function.name, total: t });
        return { call, content };
      }),
    );
    for (const { call, content } of outcomes) {
      s.messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        // Mail/document text is attacker-controlled, so the model sees where
        // the untrusted region begins and ends (OWASP ASI01). Wrapping happens
        // ONLY here: the ledger and `collectToolTotals` above read the raw
        // content, and a delimiter would break their JSON parsing.
        content: wrapUntrustedOutput(call.function.name, content),
      });
    }
    logger.info(
      {
        phone: s.input.phone,
        round,
        ms: Date.now() - roundStartedAt,
        toolCalls: calls.map((c) => c.call.function.name),
        deduped: dedupedCount,
      },
      "AI assistant: tool round complete",
    );

    // Record the think/act cycle so the execution control below can see whether
    // this run is progressing, looping, or failing the same call repeatedly.
    s.trace.record({
      step: round + 1,
      thought: result.content ?? "",
      toolCalls: calls.map((c) => ({ name: c.call.function.name, args: c.parsed })),
      results: outcomes.map((o) => o.content),
    });

    // ── Stuck handling (OpenManus `is_stuck` / `handle_stuck_state`) ───────
    // The recorded "fails at many tasks" behaviour is the model re-issuing the
    // same failing call until the round budget is gone. Steer it once — change
    // approach, or answer with what it has — instead of letting it loop.
    if (!s.steered && s.trace.isStuck()) {
      const reason = s.trace.stuckReason();
      s.trace.noteDetection();
      s.trace.noteSteering();
      s.steered = true;
      s.messages.push({ role: "user", content: steeringMessage(s.trace) });
      logTraceEvent(s.input.phone, "stuck", { round, reason });
      // A malformed-argument call is answered by correction, and a repeated
      // FAILING call is worth one more round to retry intelligently. A merely
      // repeated thought (no progress) gets no extension — that is the stall.
      if (reason === "repeated_failed_call" && s.effectiveRounds < HARD_MAX_STEPS) {
        s.effectiveRounds += 1;
        logTraceEvent(s.input.phone, "extend", { to: s.effectiveRounds, reason });
      }
    }

    // ── Progress-based budget extension (OpenManus `max_steps` is a budget) ─
    // A run still producing NEW successful tool results may take one extra
    // round, so a multi-window census is not abandoned mid-read. Guarded by the
    // remaining budget and the hard cap so this can never loop on a dead run.
    if (
      !s.extended &&
      !s.steered &&
      s.trace.canExtend(round + 1, AGENT_BUDGET_MS - (Date.now() - s.startedAt), s.steered) &&
      s.effectiveRounds < HARD_MAX_STEPS
    ) {
      s.effectiveRounds += 1;
      s.extended = true;
      logTraceEvent(s.input.phone, "extend", { to: s.effectiveRounds, reason: "progress" });
    }
  }
}

/** Source-scope check: an email-scoped question answered without reading mail is labelled. */
function applySourceScope(s: RunState): void {
  if (s.plan.sourceScope === "email" && s.finalText) {
    const ranEmail = s.usedTools.some((t) => EMAIL_TOOLS.has(t.name));
    if (!ranEmail) {
      s.finalText =
        `${s.finalText}\n\n⚠️ تنبيه: طلبت البيانات من البريد الإلكتروني، لكن هذه الإجابة مبنية على النظام الداخلي ` +
        `ولم يُقرأ البريد في هذه الجولة — فهي ليست حصرًا للميل. أعد السؤال بكلمة «من البريد» وسأفحص المرفقات.`;
      s.verificationRan = true;
      logger.warn(
        { phone: s.input.phone, tools: s.usedTools.map((t) => t.name) },
        "AI assistant: email-scoped question answered without reading email",
      );
    }
  }
}

/** Post-answer verification passes: ungrounded figures, unknown names, premature refusals and claim contradictions. */
async function verifyDraft(s: RunState): Promise<void> {
  let refusals = 0;
  for (let pass = 0; s.plan.verify && pass <= MAX_REFUSAL_REASKS; pass++) {
    if (!s.finalText) break;
    const remaining = AGENT_BUDGET_MS - (Date.now() - s.startedAt);
    if (s.runBudget.signal.aborted || remaining < VERIFY_MIN_REMAINING_MS) break;

    // (a) Numbers the answer cites that appear nowhere in the evidence.
    const ungrounded = findUngroundedNumbers(s.finalText, s.groundedNumbers);

    // (b) Entity names the answer cites that are not in the real vocabulary.
    // This is the «هاي فولت» lesson: invented company names read as plausible
    // prose, and a challenge from the operator is the only thing that caught
    // it before. Now the check happens before the reply is sent.
    const unknownNames = findUnknownEntityNames(s.finalText, s.vocabulary);

    // (c) A reply that says it found nothing while it also cites nothing —
    // the "gave up too early" case. Worth one re-ask with an explicit order to
    // widen the search, because the operator's question was answerable.
    const looksLikeRefusal =
      !ungrounded.length &&
      !unknownNames.length &&
      isRefusalSentence(s.finalText) &&
      !looksLikeDataFound(s.finalText);
    const canReask =
      !s.mailFailure &&
      looksLikeRefusal &&
      refusals < MAX_REFUSAL_REASKS &&
      remaining >= RETRY_MIN_REMAINING_MS;

    // (d) The claim check — the NEGATIVE/COMPLETENESS contradiction. This is
    // the «لا توجد مرفقات» failure: the answer denied data that a census in
    // its own trace had already matched. `isRefusalSentence` above only fires
    // on a bare refusal with no figures, so it MISSES exactly the case that
    // was reported: a confident, well-formed denial. This check compares the
    // claim against `matched`/`isComplete` instead of against the prose.
    const claim = checkClaims({
      answer: s.finalText,
      // The RAW exchanges, so the check parses the tool's own JSON rather than
      // the delimited text the model saw.
      exchanges: s.toolExchanges,
    });
    // (e) The JOB-STATE claim — an invented job number or progress percent.
    // `findUngroundedNumbers` cannot see a bare `213` or `82%` (it challenges
    // only mixed alphanumeric ids), so the live «المهمة 213 … 82%» narrative
    // passed every existing check. This one reads the job tools' own payloads.
    const jobClaim = checkJobClaims(s.finalText, s.toolExchanges);
    const correctionText = claim.correction ?? jobClaim.correction;
    const canCorrectClaim =
      !s.mailFailure && !!correctionText && remaining >= RETRY_MIN_REMAINING_MS;

    if (!ungrounded.length && !unknownNames.length && !canReask && !canCorrectClaim) break;

    if (ungrounded.length || unknownNames.length) {
      logger.warn(
        {
          phone: s.input.phone,
          ungrounded: ungrounded.slice(0, 8),
          unknownNames: unknownNames.slice(0, 8),
        },
        "AI assistant: answer cites tokens absent from every tool result",
      );
    } else if (correctionText) {
      logger.warn(
        { phone: s.input.phone, rule: claim.rule ?? jobClaim.rule },
        "AI assistant: answer contradicts the tool s.trace",
      );
    } else {
      refusals += 1;
      logger.info({ phone: s.input.phone }, "AI assistant: re-asking after a premature refusal");
    }

    s.verificationRan = true;
    const corrected = await verifyGroundedAnswer({
      settings: s.settings,
      messages: s.messages,
      finalText: s.finalText,
      ungrounded,
      unknownNames,
      reask: canReask && !ungrounded.length && !unknownNames.length,
      // The claim contradiction is passed as an explicit problem so the same
      // single correction round fixes it — no extra provider request.
      claimCorrection: correctionText ?? undefined,
      signal: s.runBudget.signal,
    });
    // A verification that produced nothing leaves the draft in place — an
    // unavailable verifier must never lose a good reply.
    if (!corrected) break;
    // A re-ask that came back with a still-empty answer is the model's final
    // word; do not loop on it.
    if (canReask && !ungrounded.length && !unknownNames.length) {
      if (isRefusalSentence(corrected) && !looksLikeDataFound(corrected)) {
        s.finalText = corrected;
        break;
      }
    }
    s.finalText = corrected;
  }
}

/** Deterministic numeric check of the figures against the tools' own aggregates. */
async function verifyNumbers(s: RunState): Promise<void> {
  if (s.finalText) {
    try {
      const v = await verifyAnswer({
        answerText: s.finalText,
        source: answerSource(s.usedTools),
        // The tool's OWN aggregates, not a figure guessed from the prose.
        toolAggregates: s.toolAggregates,
      });
      if (v.outcome === "disagreement" && v.note) {
        s.finalText = `${s.finalText}\n\n⚠️ تحقق آلي: ${v.note} — لذا النتيجة PARTIALLY_VERIFIED.`;
        s.verificationRan = true;
        s.numericDisagreed = true;
        logger.warn(
          { phone: s.input.phone, note: v.note },
          "AI assistant: numeric verification disagreed",
        );
      }
    } catch (err) {
      // A verifier failure must never lose the answer.
      logger.warn({ err }, "AI assistant: numeric verification skipped");
    }
  }
}

/** The mailbox caveat goes on LAST, after every correction, so nothing can drop it. */
function applyMailCaveat(s: RunState): void {
  if (s.finalText && s.mailFailure) {
    s.finalText =
      `${s.finalText}\n\n⚠️ لم أتمكّن من قراءة البريد فعليًا: ${s.mailFailure}. ` +
      `هذه ليست إجابة «لا توجد بيانات» — لم يحدث فحص للبريد الإلكتروني في هذه الجولة، ` +
      `فلا تعتبر النتيجة أعلاه حصرًا.`;
    s.verificationRan = true;
    logger.warn(
      { phone: s.input.phone, reason: s.mailFailure },
      "AI assistant: email read failed — answer labelled as unread",
    );
  }
}

/** Record a run that ended in an error (timeout, quota or other) and let it propagate. */
function recordFailedRun(s: RunState, err: unknown): void {
  recordMetrics({
    phone: s.input.phone,
    intent: s.plan.intent,
    path: s.plan.path,
    routeReason: s.plan.reason,
    rounds: s.rounds,
    toolCalls: s.usedTools.length,
    toolNames: [...new Set(s.usedTools.map((t) => t.name))],
    verified: s.verificationRan,
    fallbackUsed: s.fallbackUsed,
    model: s.runModel,
    modelUsed: s.answeredModel,
    provider: s.answeredProvider,
    latencyMs: Date.now() - s.startedAt,
    outcome: isTimeoutError(err) ? "timeout" : isQuotaError(err) ? "quota" : "error",
  });
}

/** Record the answered run, persist the exchange, and return the reply. */
async function finishRun(s: RunState, answer: string): Promise<AgentOutput> {
  let finalText = answer;
  logger.info(
    { phone: s.input.phone, ms: Date.now() - s.startedAt, rounds: s.rounds },
    "AI assistant: answered",
  );

  recordMetrics({
    phone: s.input.phone,
    intent: s.plan.intent,
    path: s.plan.path,
    routeReason: s.plan.reason,
    rounds: s.rounds,
    toolCalls: s.usedTools.length,
    toolNames: [...new Set(s.usedTools.map((t) => t.name))],
    verified: s.verificationRan,
    fallbackUsed: s.fallbackUsed,
    model: s.runModel,
    modelUsed: s.answeredModel,
    provider: s.answeredProvider,
    latencyMs: Date.now() - s.startedAt,
    outcome: "answered",
    confidence: answerConfidence(s.usedTools.length, s.verificationRan, s.numericDisagreed),
    // The data tools' own figures travel with the trace. A summary can claim
    // "كل الأصناف" while the tool returned 15 rows; these numbers make that
    // contradiction visible on the dashboard instead of only in a log line.
    task: {
      // The Mastra engine owns its own `TaskTrace`, so its summary replaces the
      // (empty) legacy one. Without this the dashboard reported `steps: 0` for
      // every Mastra run while the log line carried the real numbers.
      ...(s.engineTrace ?? s.trace.summary()),
      ...(s.traceData.length ? { data: s.traceData } : {}),
    },
  });

  const sanitized = sanitizeAssistantReply(finalText);
  if (hadToolMarkup(finalText)) {
    logger.warn(
      { phone: s.input.phone, before: finalText.length, after: sanitized.length },
      "AI assistant: stripped tool-call markup from the reply",
    );
  }
  finalText = sanitized || "";
  if (!finalText) {
    // A message that was ONLY markup describes a call it could not make. Saying
    // so is honest; sending an empty WhatsApp message is not possible, and
    // letting the markup through shows the operator the machinery.
    finalText =
      "لم أستطع إكمال الطلب داخل هذه المحاولة. جرّب سؤالًا أكثر تحديدًا (مثل رقم أمر التوريد أو اسم البند) وسأجيب مباشرة.";
  }

  // The extracted document text is intentionally kept out of the stored
  // history: it is large and only relevant to this one turn. The label keeps
  // the transcript understandable when it is replayed as context.
  const historyText = s.input.imageUrl
    ? `[صورة] ${s.userText}`.trim()
    : s.input.document
      ? `[ملف: ${s.input.document.filename || "ملف"}] ${s.userText}`.trim()
      : s.userText;
  await saveMessage(s.input.phone, "user", historyText);
  await saveMessage(s.input.phone, "assistant", finalText, s.usedTools.length ? s.usedTools : null);

  // Record what this turn was about, so a follow-up can resolve «له/بتاعه».
  // Only explicitly-named entities are recorded (see inferStatePatch) and it is
  // best-effort — a state-write failure must never surface to the operator.
  void saveConversationState(s.input.phone, inferStatePatch({ userText: s.userText })).catch(
    () => {},
  );

  // Learn from the exchange. Fire-and-forget: the reply is already produced, and
  // a memory-write failure must never turn a good answer into an error the
  // operator sees. The distiller uses only the operator's own words (no model
  // call), so this costs none of the scarce daily quota.
  void distillMemories({
    phone: s.input.phone,
    userText: s.userText,
    assistantText: finalText,
  }).catch((err) => logger.warn({ err }, "AI assistant: background learning failed"));
  return { reply: finalText, attachments: s.ctx.outbox };
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const settings = await loadSettings();
  if (!settings.enabled) {
    return { reply: "المساعد الذكي معطّل حاليًا. تواصل مع الإدارة.", attachments: [] };
  }

  // A census with no named source is answered by asking, not by guessing: the
  // three datasets give different numbers. This runs before any model call, so
  // the question costs no quota.
  if (typeof input.text === "string" && !input.imageUrl && !input.document && !input.audio) {
    const gate = resolveSourceChoice(input.phone, input.text);
    if (gate.kind === "ask") return { reply: gate.reply, attachments: [] };
    input = { ...input, text: gate.text };
  }

  const s = await prepareRun(input, settings);
  // Hard ceiling on the WHOLE run (every round, every model, every tool). The
  // operator is waiting in a chat window: past this point a late answer is
  // worse than an honest "it timed out", because they have already given up.
  const runTimer = setTimeout(() => s.runBudget.abort(), AGENT_BUDGET_MS);

  try {
    if (mastraEngineEnabled()) {
      await runEngineLoop(s);
    } else {
      await runLegacyRounds(s);
    }

    if (!s.finalText) {
      s.finalText = exhaustedAnswer(s.usedTools);
    }

    // Mail-access failure must not read as an empty mailbox: a negative claim is
    // only allowed when the read actually happened. Checked by the passes below.
    s.mailFailure = findMailAccessFailure(s.usedTools, s.mailFailureEvidence);
    applySourceScope(s);
    await verifyDraft(s);
    await verifyNumbers(s);
    applyMailCaveat(s);
  } catch (err) {
    recordFailedRun(s, err);
    throw err;
  } finally {
    clearTimeout(runTimer);
  }

  return finishRun(s, s.finalText ?? "");
}

/** Clear conversation history for a phone (used by the reset command). */
export async function resetHistory(phone: string): Promise<void> {
  await db.delete(aiAssistantMessagesTable).where(eq(aiAssistantMessagesTable.phone, phone));
}

/** Most recent assistant message for a phone — used for idempotency checks. */
export async function lastAssistantMessage(phone: string): Promise<string | null> {
  const [row] = await db
    .select({ content: aiAssistantMessagesTable.content })
    .from(aiAssistantMessagesTable)
    .where(
      and(
        eq(aiAssistantMessagesTable.phone, phone),
        eq(aiAssistantMessagesTable.role, "assistant"),
      ),
    )
    .orderBy(desc(aiAssistantMessagesTable.id))
    .limit(1);
  return row?.content ?? null;
}

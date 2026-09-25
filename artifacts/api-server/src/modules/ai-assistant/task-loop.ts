/**
 * AI Assistant — task-execution layer (OpenManus-derived).
 *
 * The hand-rolled loop in `agent.ts` gave the model a fixed number of rounds and
 * then abandoned the turn. Live, that surfaced as the assistant "failing at many
 * tasks": it repeated the same failing tool call until the budget ran out, never
 * reflected on a tool error, and the operator received either a bare timeout or a
 * confidently wrong answer built on the one result it did get.
 *
 * This module ports the execution-control ideas that make OpenManus
 * (https://github.com/FoundationAgents/OpenManus) durable across steps, and keeps
 * the parts that matter for a live WhatsApp reply:
 *
 *  - **Stuck detection** (`BaseAgent.is_stuck`): count identical assistant turns;
 *    a model looping on the same thought is not making progress.
 *  - **`handle_stuck_state`**: when stuck, inject a "change strategy" instruction
 *    for the next step instead of silently looping.
 *  - **`should_force_answer` / `Terminate`**: once a step budget is spent, stop
 *    calling tools and synthesise a final answer from what was gathered.
 *  - **`tool_choices` REQUIRED → NONE**: the same idea the hand-rolled loop
 *    already borrowed — the last round forbids tools.
 *  - **Per-observation cap** (`max_observe`): a 12k-char tool dump was crowding
 *    out the conversation; results are capped for the context.
 *  - **Step extension**: OpenManus's `max_steps` is a budget, not a guillotine.
 *    A run that keeps producing *new* progress may take one extra step, so an
 *    interrupted enum resumable census is not abandoned half-finished.
 *
 * Deliberately NOT ported: the planner/executor/reporter multi-agent split, the
 * Python sandbox, and browser automation. Those need a long-lived process and a
 * Python runtime; this agent answers inside one WhatsApp reply on a 150s budget.
 * Only the *execution control* is borrowed, not the tool surface.
 *
 * Everything here is pure and synchronous so it is cheap on the hot path and
 * unit-testable without a provider.
 */
import { logger } from "../../shared/logger";

/** One think/act cycle, in the shape OpenManus's `Memory` holds. */
export interface ObservedStep {
  /** 1-based step number within the run. */
  step: number;
  /** The model's reasoning/content for this step (its "thought"). */
  thought: string;
  /** Tool calls issued this step, in order. */
  toolCalls: Array<{ name: string; args: unknown }>;
  /** Tool observations, matched to the calls by index. */
  results: string[];
}

/** Structured per-run numbers, logged and attached to the answer metrics. */
export interface TraceSummary {
  steps: number;
  toolCalls: number;
  toolErrors: number;
  distinctTools: number;
  successfulTools: number;
  /** Times the run was forced to answer instead of calling more tools. */
  forcedAnswers: number;
  /** Times a strategy-changing instruction was pushed to the model. */
  steers: number;
  /** Times a stuck condition was detected. */
  detections: number;
}

/** Identical assistant turns before a run counts as stuck (OpenManus default). */
export const DUPLICATE_THRESHOLD = 2;

/**
 * Hard ceiling on model rounds for ONE answer, however many extensions are
 * granted. Each round is a provider request against a 20/day/model free tier, so
 * this is a quota guard as much as a loop guard.
 */
export const HARD_MAX_STEPS = 6;

/**
 * Least time that must remain in the run budget before an extra round is
 * granted. Mirrors the verification guard: with less than this there is not
 * enough budget for another round-trip, so answering with what we have beats
 * timing out with nothing.
 */
export const EXTEND_MIN_REMAINING_MS = 25_000;

/**
 * The strategy-change instruction, adapted from OpenManus's `handle_stuck_state`
 * to a single-reply operator: it must change approach AND, if the alternatives
 * are exhausted, answer with what it has rather than loop.
 */
export const STUCK_PROMPT =
  "لاحظتُ تكرار نفس السلوك دون تقدّم فعلي. غيّر الاستراتيجية الآن: " +
  "لا تُعِد أي استدعاء سابق بنفس المعطيات، وجرّب أداة مختلفة أو كلمة بحث أخرى أو جدولًا آخر. " +
  "وإن استنفدت البدائل فاكتب الرد النهائي بما وصلت إليه فعلًا مع ذكر ما جرّبته، ولا تُكمل في الحلقة.";

/** Instruction for a tool that returned a malformed-argument / unknown-tool error. */
function errorCorrectionPrompt(tool: string): string {
  return (
    `الأداة «${tool}» رجعت خطأً في المعطيات أو أنها غير معروفة. صحّح المعطيات وفق المخطط المعلن ` +
    `أو استخدم أداة بديلة — إعادة نفس الاستدعاء الفاشل لن تُنجحه.`
  );
}

/** Normalise a thought for duplicate comparison (whitespace only). */
export function normalizeThought(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Stable key for a tool call: name + canonicalised arguments. */
export function callSignature(name: string, args: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = canon((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  try {
    return `${name}:${JSON.stringify(canon(args ?? {}))}`;
  } catch {
    return `${name}:${String(args)}`;
  }
}

/**
 * Whether a tool observation is an error.
 *
 * Accepts both shapes the registry actually produces: the `ERROR:` string the
 * agent writes for a failed call, and an `{ok:false}` envelope from a tool that
 * returned its own error object.
 */
export function isErrorObservation(content: string): boolean {
  const t = (content ?? "").trimStart();
  if (!t) return false;
  if (/^ERROR\b/i.test(t)) return true;
  try {
    const parsed = JSON.parse(t);
    return (
      Boolean(parsed) && typeof parsed === "object" && (parsed as { ok?: unknown }).ok === false
    );
  } catch {
    return false;
  }
}

/**
 * Whether an error is the model's FAULT (bad or missing arguments, unknown tool)
 * rather than the data's. Those are the errors a reflection instruction can fix;
 * a timeout or an empty result is not, so retrying them unchanged is wasted quota.
 */
export function isValidationError(content: string): boolean {
  if (!isErrorObservation(content)) return false;
  return /(invalid|unexpected|missing|required|schema|parameter|argument|unknown tool|not a function|must be|expected|معطيات|وسيط|غير معروف)/i.test(
    content ?? "",
  );
}

/**
 * Accumulates the run's think/act history and answers the execution-control
 * questions the loop asks. One instance per answer.
 */
export class TaskTrace {
  private readonly steps: ObservedStep[] = [];
  /** Call signature → how many times it returned an error in this run. */
  private readonly failures = new Map<string, number>();
  /** Tools whose most recent observation was an error. */
  private readonly failingTools = new Set<string>();
  /** Tools that produced at least one clean observation. */
  private readonly successfulTools = new Set<string>();
  private errorCount = 0;
  private forcedAnswers = 0;
  private steers = 0;
  private detections = 0;
  private lastStepValidationError = false;

  record(step: ObservedStep): void {
    this.steps.push(step);
    this.lastStepValidationError = false;
    step.toolCalls.forEach((call, i) => {
      const result = step.results[i] ?? "";
      if (isErrorObservation(result)) {
        this.errorCount += 1;
        this.failingTools.add(call.name);
        const key = callSignature(call.name, call.args);
        this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
        if (isValidationError(result)) this.lastStepValidationError = true;
      } else {
        this.successfulTools.add(call.name);
        this.failingTools.delete(call.name);
      }
    });
  }

  /** Steps recorded so far (i.e. rounds that actually executed tools). */
  get stepCount(): number {
    return this.steps.length;
  }

  /** True once at least one tool produced a usable observation. */
  get hasProgress(): boolean {
    return this.successfulTools.size > 0;
  }

  /**
   * Whether the latest step's tools EXPLICITLY reported that more work remains —
   * the resumable-census shape (`isComplete:false` / `remainingMessages>0` /
   * `continueHint`).
   *
   * This is deliberately the only justification for an extra round. "The run
   * called a tool successfully" is not enough: a model that repeats a completed
   * lookup has not progressed, it has failed to answer, and granting it another
   * round would just spend another day's quota on the same stall. A tool that
   * says "there is more, call me again" is a different claim entirely, and it is
   * exactly the multi-window census the fixed budget used to abandon.
   */
  hasPendingWork(): boolean {
    const last = this.steps[this.steps.length - 1];
    if (!last) return false;
    return last.results.some((content) => {
      if (isErrorObservation(content)) return false;
      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch {
        return /\b(continueHint|remainingMessages)\b/.test(content ?? "");
      }
      if (!parsed || typeof parsed !== "object") return false;
      const root = parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
      if (root.isComplete === false) return true;
      if (Number(root.remainingMessages) > 0) return true;
      if (root.continueHint) return true;
      if (root.truncated === true) return true;
      return false;
    });
  }

  /** Count of earlier assistant turns identical to the latest one. */
  private duplicateThoughtCount(): number {
    const last = this.steps[this.steps.length - 1];
    const target = normalizeThought(last?.thought ?? "");
    if (!target) return 0;
    let n = 0;
    for (let i = this.steps.length - 2; i >= 0; i--) {
      if (normalizeThought(this.steps[i].thought) === target) n += 1;
    }
    return n;
  }

  /**
   * A tool call from the latest step whose signature has already failed
   * `DUPLICATE_THRESHOLD` times — the "same broken call, over and over" loop.
   */
  repeatedFailureTool(): string | null {
    const last = this.steps[this.steps.length - 1];
    if (!last) return null;
    for (const call of last.toolCalls) {
      if ((this.failures.get(callSignature(call.name, call.args)) ?? 0) >= DUPLICATE_THRESHOLD) {
        return call.name;
      }
    }
    return null;
  }

  /** OpenManus `is_stuck()`: a repeated thought or a repeatedly failing call. */
  isStuck(): boolean {
    return (
      this.duplicateThoughtCount() >= DUPLICATE_THRESHOLD || this.repeatedFailureTool() !== null
    );
  }

  /** Why the run is stuck, for logging — null when it is not. */
  stuckReason(): string | null {
    if (this.repeatedFailureTool()) return "repeated_failed_call";
    if (this.duplicateThoughtCount() >= DUPLICATE_THRESHOLD) return "duplicate_response";
    return null;
  }

  /** Did the latest step include a malformed-argument tool error? */
  lastHadValidationError(): boolean {
    return this.lastStepValidationError;
  }

  /**
   * Whether one more round should be granted past the planned allocation.
   *
   * Requires a tool that EXPLICITLY reported more work remains (see
   * `hasPendingWork`), no steering already in flight, budget left, and room
   * under the hard cap — so an extension can never loop on a dead run, repeat a
   * completed lookup, or spend the day's quota on a stall.
   */
  canExtend(consumedRounds: number, remainingMs: number, steered: boolean): boolean {
    return (
      !steered &&
      consumedRounds < HARD_MAX_STEPS &&
      remainingMs > EXTEND_MIN_REMAINING_MS &&
      this.hasPendingWork()
    );
  }

  noteSteering(): void {
    this.steers += 1;
  }

  noteDetection(): void {
    this.detections += 1;
  }

  noteForcedAnswer(): void {
    this.forcedAnswers += 1;
  }

  summary(): TraceSummary {
    return {
      steps: this.steps.length,
      toolCalls: this.steps.reduce((a, s) => a + s.toolCalls.length, 0),
      toolErrors: this.errorCount,
      distinctTools: new Set(this.steps.flatMap((s) => s.toolCalls.map((c) => c.name))).size,
      successfulTools: this.successfulTools.size,
      forcedAnswers: this.forcedAnswers,
      steers: this.steers,
      detections: this.detections,
    };
  }
}

/**
 * The instruction to push as a user turn when the run needs to change approach.
 * A failing call gets the specific correction; a repeated thought gets the
 * generic strategy change. Both end with the same "answer if you are out of
 * alternatives" so the operator always gets a reply.
 */
export function steeringMessage(trace: TaskTrace): string {
  const failing = trace.repeatedFailureTool();
  return failing ? `${errorCorrectionPrompt(failing)}\n\n${STUCK_PROMPT}` : STUCK_PROMPT;
}

/**
 * Stable cache key for one tool call: the tool name plus its arguments in a
 * canonical form, so `{"a":1,"b":2}` and `{"b":2,"a":1}` dedupe to one entry.
 * Nested objects are sorted recursively; a non-object value falls back to its
 * string form.
 *
 * Lives here (a pure, dependency-free module) rather than in `agent.ts` so the
 * Mastra engine can reuse the identical rule without importing `agent.ts` back
 * — a cycle that would make either engine untestable in isolation.
 */
export function toolCacheKey(name: string, args: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = canonical((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  try {
    return `${name}:${JSON.stringify(canonical(args ?? {}))}`;
  } catch {
    return `${name}:${String(args)}`;
  }
}

/**
 * The last-round instruction: stop calling tools and answer from what has
 * already been gathered. Shared so both engines force the answer identically.
 */
export const FORCE_ANSWER_INSTRUCTION =
  "لم يعد لديك استدعاءات أدوات. استخدم النتائج التي جمعتها بالفعل واكتب الإجابة " +
  "النهائية الآن بالعربية. إذا كانت البيانات ناقصة فاذكر ما توصلت إليه صراحةً وما " +
  "لم تستطع الوصول إليه، ولا تخترع أرقامًا.";

/** Log one stuck/forced event so the new control flow is visible in production. */
export function logTraceEvent(
  phone: string,
  event: "stuck" | "steer" | "force" | "extend",
  detail: Record<string, unknown>,
): void {
  logger.info({ phone, event, ...detail }, `AI assistant: task ${event}`);
}

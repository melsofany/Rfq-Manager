/**
 * An explicit task plan — the one idea worth taking from OpenManus.
 *
 * OpenManus runs a `PlanningFlow`: a plan is written down as STEPS, and the loop
 * executes step by step until none is left, instead of re-deciding the whole
 * task from the top on every round. Our loop had no memory of a plan, so a
 * multi-step request («اجمع أوامر الشراء … ثم قارن الأسعار … ثم اكتب تقرير»)
 * drifted: each round saw only the recent transcript and the later steps were
 * silently dropped — the operator experiences this as «مش بيكمّل المهمة».
 *
 * This is deliberately NOT the OpenManus Python runtime. Its agents drive a bash
 * sandbox, a browser and a filesystem, none of which this process can host, and
 * its planner spends a model call to produce a plan we can derive from the
 * router we already have. What we take is the DISCIPLINE: write the steps down,
 * execute them in order, report which one is done.
 *
 * Pure and dependency-free, so the step accounting is unit-testable without a
 * database or a provider.
 */

export type StepStatus = "pending" | "in_progress" | "done" | "blocked";

export interface PlanStep {
  /** 1-based, as shown to the operator. */
  index: number;
  text: string;
  status: StepStatus;
}

export interface TaskPlan {
  goal: string;
  steps: PlanStep[];
  /** Reason the plan stopped, when it did not finish. */
  blockedReason?: string;
}

/**
 * Steps a question implies, in the order they must run.
 *
 * Derived from the SAME signals the router uses, so the plan cannot disagree
 * with the path that was chosen. Order matters: gathering precedes analysis,
 * and a report is written only after both.
 */
const STEP_PATTERNS: Array<{ re: RegExp; text: string }> = [
  {
    re: /حصر|جرد|عدّد|عدد|كام|كم\s|إجمالي|اجمالي|إحصائي/i,
    text: "اجمع الأرقام المطلوبة من المصدر المحدد",
  },
  {
    re: /قارن|مقارنة|الفرق|أفضل|افضل|أرخص|ارخص|أعلى|اعلى/i,
    text: "رتّب/قارن النتائج واستخرج الفروق",
  },
  { re: /تقرير|تقريرًا|PDF|pdf|ابعت|أرسل|ارسل/i, text: "جهّز التقرير وأرسله" },
];

export function planFor(question: string): TaskPlan {
  const text = String(question ?? "").trim();
  const steps: PlanStep[] = [];
  for (const p of STEP_PATTERNS) {
    if (p.re.test(text) && !steps.some((s) => s.text === p.text)) {
      steps.push({ index: steps.length + 1, text: p.text, status: "pending" });
    }
  }
  // Every question has at least the gather step, so the operator always sees
  // what is being worked on rather than a silent spinner.
  if (!steps.length) {
    steps.push({ index: 1, text: "اجمع البيانات المطلوبة من المصدر الصحيح", status: "pending" });
  }
  return { goal: text, steps };
}

/** The first step that still needs work, or null when the plan is complete. */
export function nextStep(plan: TaskPlan): PlanStep | null {
  return plan.steps.find((s) => s.status === "pending" || s.status === "in_progress") ?? null;
}

/**
 * Mark a step by its 1-based index. An unknown index is ignored rather than
 * throwing: the plan is bookkeeping, and a bad index must never fail a task the
 * operator is waiting on.
 */
export function markStep(plan: TaskPlan, index: number, status: StepStatus): TaskPlan {
  const step = plan.steps.find((s) => s.index === index);
  if (step) step.status = status;
  return plan;
}

export function planProgress(plan: TaskPlan): { done: number; total: number; percent: number } {
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === "done").length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

/** The plan as a compact block for the prompt — empty when there is nothing to track. */
export function renderPlan(plan: TaskPlan): string {
  if (plan.steps.length < 2) return "";
  const { done, total, percent } = planProgress(plan);
  const lines = plan.steps.map((s) => {
    const mark = s.status === "done" ? "[x]" : s.status === "in_progress" ? "[>]" : "[ ]";
    return `${mark} ${s.index}. ${s.text}`;
  });
  return (
    `خطة المهمة (${done}/${total} — ${percent}%):\n${lines.join("\n")}\n` +
    `نفّذ الخطوة النشطة الآن، وعلّمها منتهية قبل الانتقال للتي بعدها. ` +
    `ولا تُعلن انتهاء المهمة قبل أن تصير كل الخطوات [x].`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The full loop: plan → execute → REVIEW → retry (OpenManus's PlanningFlow,
// developed for Node).
//
// OpenManus walks a plan step by step, but its `_mark_step_completed` trusts the
// executor's own claim that the step is done. A step that produced an error is
// therefore recorded as complete and the plan advances on a false premise —
// exactly the «capability that reports something other than what it did» family
// this repository keeps re-learning. So the loop below REVIEWS each step against
// its own evidence before advancing, and retries a step that failed for a
// transient reason.
// ─────────────────────────────────────────────────────────────────────────────

export interface StepAttempt {
  index: number;
  /** Tool results / text the step produced, as evidence for the review. */
  evidence: string[];
  /** Errors seen while running the step. */
  errors: string[];
  attempts: number;
}

export interface TaskRecord {
  goal: string;
  plan: TaskPlan;
  attempts: StepAttempt[];
  startedAt: string;
  finishedAt?: string;
  /** Model calls spent on this task — the cost line the operator asked for. */
  modelCalls: number;
  toolCalls: number;
  outcome: "running" | "completed" | "failed" | "awaiting_approval";
  /** Set when the loop stopped needing the operator. */
  approvalPrompt?: string;
}

export const MAX_STEP_ATTEMPTS = 3;

export function newTaskRecord(goal: string, plan: TaskPlan): TaskRecord {
  return {
    goal,
    plan,
    attempts: [],
    startedAt: new Date().toISOString(),
    modelCalls: 0,
    toolCalls: 0,
    outcome: "running",
  };
}

/**
 * A transient failure is worth another attempt; a permanent one is not.
 *
 * Retrying a validation error or a missing record just burns the day's model
 * quota on the same answer, which is this assistant's recorded failure mode.
 */
const TRANSIENT_RE =
  /timeout|timed out|مهلة|503|502|504|429|rate.?limit|حصة|overload|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|شبكة|غير متاح مؤقتًا|circuit breaker/i;

export function isTransientFailure(errors: string[]): boolean {
  return errors.some((e) => TRANSIENT_RE.test(String(e)));
}

export interface ReviewResult {
  done: boolean;
  retry: boolean;
  /** Arabic note for the record / the model. */
  note: string;
}

/**
 * Review a step's outcome. A step is done only when it produced evidence and no
 * unrecovered error; an empty result is NOT success (the `filter(Boolean)`
 * lesson), and a transient error earns a retry.
 */
export function reviewStep(attempt: StepAttempt): ReviewResult {
  const hasEvidence = attempt.evidence.some((e) => String(e ?? "").trim().length > 0);
  const errors = attempt.errors.filter((e) => String(e ?? "").trim().length > 0);

  if (!errors.length) {
    return hasEvidence
      ? { done: true, retry: false, note: "الخطوة أنتجت نتيجة." }
      : {
          done: false,
          retry: true,
          note: "الخطوة لم تُنتج أي نتيجة — لا تُعتبر منتهية، أعدها بطريقة أخرى.",
        };
  }

  if (isTransientFailure(errors) && attempt.attempts < MAX_STEP_ATTEMPTS) {
    return {
      done: false,
      retry: true,
      note: `فشل مؤقت (محاولة ${attempt.attempts} من ${MAX_STEP_ATTEMPTS}) — أعد المحاولة.`,
    };
  }

  return {
    done: false,
    retry: false,
    note: `فشل غير قابل للإصلاح: ${errors[0]}. اذكر السبب ولا تدّعِ إتمام المهمة.`,
  };
}

/** Record a step's attempt, creating its slot on first use. */
export function recordAttempt(
  task: TaskRecord,
  index: number,
  evidence: string[],
  errors: string[],
): StepAttempt {
  let a = task.attempts.find((x) => x.index === index);
  if (!a) {
    a = { index, evidence: [], errors: [], attempts: 0 };
    task.attempts.push(a);
  }
  a.attempts += 1;
  a.evidence.push(...evidence);
  a.errors = errors.slice();
  return a;
}

/**
 * Advance the plan: review the step just run, then either mark it done, leave it
 * for a retry, or block it. Returns what the loop should do next.
 */
export function advancePlan(
  task: TaskRecord,
  index: number,
  evidence: string[],
  errors: string[],
): ReviewResult & { blocked: boolean } {
  const attempt = recordAttempt(task, index, evidence, errors);
  const review = reviewStep(attempt);

  if (review.done) {
    markStep(task.plan, index, "done");
    return { ...review, blocked: false };
  }
  if (review.retry) {
    markStep(task.plan, index, "in_progress");
    return { ...review, blocked: false };
  }
  markStep(task.plan, index, "blocked");
  task.plan.blockedReason = review.note;
  return { ...review, blocked: true };
}

/** The task as a compact record for the operator / logs. */
export function renderTaskRecord(task: TaskRecord): string {
  const p = planProgress(task.plan);
  const lines = [
    `المهمة: ${task.goal}`,
    `الخطة: ${p.done}/${p.total} (${p.percent}%) — الحالة: ${task.outcome}`,
    `نداءات النموذج: ${task.modelCalls} · استدعاءات الأدوات: ${task.toolCalls}`,
  ];
  for (const s of task.plan.steps) {
    const a = task.attempts.find((x) => x.index === s.index);
    const tries = a ? ` (${a.attempts} محاولة)` : "";
    lines.push(
      `  ${s.status === "done" ? "✓" : s.status === "blocked" ? "✗" : "…"} ${s.index}. ${s.text}${tries}`,
    );
  }
  if (task.plan.blockedReason) lines.push(`توقفت عند: ${task.plan.blockedReason}`);
  return lines.join("\n");
}

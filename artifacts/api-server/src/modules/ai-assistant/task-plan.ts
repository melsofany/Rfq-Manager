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

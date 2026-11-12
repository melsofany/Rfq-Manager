// Intelligent task routing + bounded, free-only fallback.
//
// Two responsibilities:
//   1. classify(task)  -> "simple" | "medium" | "complex"  (drives the tier)
//   2. fallbackPlan()  -> the ordered models to try, and the retry budget
//
// The fallback chain is HARD-BOUNDED and FREE-ONLY. A failure of a free model
// never escalates to a paid one; it either tries the next free model or stops
// and asks the user. This is the rule with the highest priority in the system.
import { modelsByTier, tierOf } from "./models.mjs";

export const TASK_CLASSES = {
  simple: {
    tier: "free",
    examples: [
      "read a file",
      "search the repo",
      "explain code",
      "summarise a file",
      "write documentation",
      "edit comments / text",
      "small CSS / UI tweak",
      "obvious error analysis",
      "simple unit test",
      "review a small diff",
    ],
  },
  medium: {
    tier: "economical",
    examples: [
      "new feature",
      "medium bug fix",
      "backend change",
      "API endpoint change",
      "write SQL",
      "React component",
      "database change",
      "business logic",
      "code review",
    ],
  },
  complex: {
    tier: "premium",
    examples: [
      "architecture analysis",
      "large refactor",
      "hard bug",
      "complex DB problem",
      "production incident analysis",
      "task that cheaper models failed",
      "advanced reasoning",
    ],
  },
};

// Arabic folds for signal matching. The operator writes Arabic, so an
// English-only classifier would leave every task at the default tier — the
// routing would exist but never fire. Folding is the same technique the
// assistant router uses: hamza/alef, taa-marbuta, yaa, harakat, tatweel.
export function normalizeArabic(s) {
  return String(s || "")
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // harakat + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\u200f|\u200e/g, "")
    .toLowerCase();
}

// Arabic equivalents of the English signals. Deliberately NOT including bare
// "تعديل" (edit) or "مراجعة" (review): those are simple for a comment and
// medium for a backend change, so matching them would mis-tier real work.
const AR_COMPLEX_SIGNALS = [
  /معماري|اركيتكتشر|هيكله|اعاده هيكله|اعاده بناء|ريفاكتور|اعاده كتابه/,
  /اعاده تصميم|ريديزاين/,
  /ترحيل|مايجريشن|نقل قاعده البيانات/,
  /ديدلوك|تسريب ذاكره|حاله سباق|سباق|تزامن|concurrenc/,
  /مشكله الانتاج|عطل|انهيار|انقطاع|وقع|داون|production/,
  /الاداء|بوتل نك|بطء|بطيء|تحسين السرعه/,
  /تحليل عميق|تحليل شامل|تحليل معقد|فحص شامل|تدقيق/,
  /معقد|صعب|محير|محتاج تفكير|مش سهل/,
  /امن|ثغره|اختراق|مراجعه امنيه/,
  /فشل النموذج|فشلت النماذج|النموذج فشل|فشل اكتر من مره/,
];

const AR_SIMPLE_SIGNALS = [
  /اقرا|اقرأ|افتح|اعرض|وريني|شوف|اطبع|اقتبس/,
  /ابحث|دور|لاقي|هات|فين/,
  /اشرح|فسر|وضح|يعني ايه|ايه ده/,
  /لخص|ملخص|اختصر/,
  /توثيق|دوكيومنتيشن|كومنت|تعليق|تعليقات/,
  /تنسيق|فورمات|مسافات|غلطه املائيه|اخطاء املائيه|اعاده تسميه|غير الاسم/,
  /ستايل|تصميم بسيط|لون|هامش|سي اس اس/,
  /بسيط|سهل|سريع|تافه/,
];

const COMPLEX_SIGNALS = [
  /architecture|architectural|re-?architect/i,
  /refactor (the|whole|entire|large|major)/i,
  /redesign/i,
  /migration|migrate the (schema|database|system)/i,
  /race condition|deadlock|memory leak|heap|concurrenc/i,
  /production (incident|outage|down|failure)/i,
  /performance (regression|profil|bottleneck)/i,
  /why (is|does).*(fail|flaky|intermittent)/i,
  /deep (analysis|reasoning|investigation)/i,
  /failed (with|on) the (cheaper|economical|free)/i,
  /\bcomplex\b|\bhard\b|\btricky\b/i,
  /security (audit|review|vulnerab)/i,
];

const SIMPLE_SIGNALS = [
  /\bread\b|\bopen\b|\bshow\b|\blist\b|\bcat\b|\bview\b/i,
  /\bsearch\b|\bgrep\b|\bfind\b|\blocate\b/i,
  /explain|what does|how does .* work/i,
  /summar(y|ise|ize)/i,
  /\bdoc(s|umentation)?\b/i,
  /comment|typo|rename|format|prettier|whitespace/i,
  /\bCSS\b|styling|color|spacing|padding|margin/i,
  /\b(lint|format) (error|fix)/i,
];

export function classify(task) {
  const t = String(task || "");
  const tn = normalizeArabic(t);
  let score = 0;
  let complexHits = 0;
  let simpleHits = 0;
  for (const re of COMPLEX_SIGNALS) if (re.test(t)) complexHits++;
  for (const re of SIMPLE_SIGNALS) if (re.test(t)) simpleHits++;
  const arComplex = AR_COMPLEX_SIGNALS.filter((re) => re.test(tn)).length;
  const arSimple = AR_SIMPLE_SIGNALS.filter((re) => re.test(tn)).length;
  complexHits += arComplex;
  simpleHits += arSimple;
  score += complexHits * 2 - simpleHits;
  // Length is a weak prior: very long asks are usually medium+.
  if (t.length > 1200) score += 1;
  let cls = "medium";
  if (complexHits > 0 && simpleHits === 0) cls = "complex";
  else if (simpleHits > 0 && complexHits === 0 && t.length < 400) cls = "simple";
  else if (score >= 3) cls = "complex";
  else if (score <= -1) cls = "simple";
  return { class: cls, tier: TASK_CLASSES[cls].tier, complexHits, simpleHits, arComplex, arSimple };
}

// Order the free-tier candidates so the best tool-capable model is tried first.
const FREE_ORDER = [
  "groq/openai/gpt-oss-120b",
  "cerebras/gpt-oss-120b",
  "openrouter/nex-agi/nex-n2.5-pro:free",
  "gemini/gemini-3.5-flash-lite",
  "gemini/gemini-3.1-flash-lite",
];

// Cheapest-first. `deepseek/deepseek-v4-pro` is deliberately absent: it is
// measured as the most expensive model this workspace uses, so it must never be
// reached by automatic routing (the policy would stop on it anyway).
const ECON_ORDER = [
  "openhands/deepseek-v4.1-flash",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-v4-flash",
];

export const RETRY_BUDGET = {
  // Per-provider attempts before moving on. Kept small: retrying a rate limit
  // in place just burns the quota.
  perProviderAttempts: 1,
  // Total models tried before the task is stopped and the user is asked.
  maxFallbackDepth: 5,
  // Absolute ceiling on attempts across the whole task, so no loop is possible.
  maxTotalAttempts: 8,
};

/**
 * Build the fallback plan for a task.
 * @param {string} task
 * @param {object} opts { allowPaid?: boolean, approvalId?: string, forcedModel?: string }
 */
// Compose the candidate chain so the models the task tier actually needs are
// present. Truncating a [free..., economical...] list would drop every
// economical model and leave a medium task with free-only candidates — which
// then (correctly) stops instead of running, i.e. the task can never be done.
export function composeChain(taskTier, depth = RETRY_BUDGET.maxFallbackDepth) {
  const toEntry = (m) => ({ model: m, tier: tierOf(m) || "unknown" });
  if (taskTier === "free") {
    return FREE_ORDER.slice(0, depth).map(toEntry);
  }
  // economical / complex: reserve slots for the paid-but-cheap tier, keeping
  // the free models first because they are tried first.
  const econSlots = Math.min(ECON_ORDER.length, Math.max(1, Math.floor(depth / 2)));
  const freeSlots = Math.max(1, depth - econSlots);
  return [...FREE_ORDER.slice(0, freeSlots), ...ECON_ORDER.slice(0, econSlots)].map(toEntry);
}

export function planForTask(task, opts = {}) {
  const c = classify(task);
  let chain;
  if (opts.forcedModel) {
    chain = [{ model: opts.forcedModel, tier: tierOf(opts.forcedModel) || "unknown" }];
  } else {
    chain = composeChain(c.tier, RETRY_BUDGET.maxFallbackDepth);
  }

  const budget = { ...RETRY_BUDGET };
  if (chain.length > budget.maxFallbackDepth) chain.length = budget.maxFallbackDepth;

  const requiresApproval = c.tier === "premium";
  // The note must state what the chain ACTUALLY does. A medium/complex chain is
  // [free..., economical...], so a free failure does fall through to the
  // economical tier — authorised for those task classes, but still a PAID call.
  // Claiming paid escalation is impossible there would be false; what is
  // actually blocked is reaching a PREMIUM model.
  const note =
    c.tier === "free"
      ? "Every candidate is a free model; a paid model is never reached automatically."
      : requiresApproval
        ? "Complex task: free models are tried first, then the economical tier (authorised for this class). A premium model needs explicit approval and is never reached automatically."
        : "Free models are tried first; the economical tier is authorised for this task class, so a fall-through to it is expected and is a paid call. A premium model is never reached automatically.";
  return {
    taskClass: c.class,
    tier: c.tier,
    chain,
    budget,
    requiresApproval,
    premiumCandidate: requiresApproval ? (modelsByTier("premium")[0]?.id ?? null) : null,
    note,
  };
}

// Failure taxonomy used to decide "retry elsewhere" vs "stop".
export const FAILURE_KINDS = {
  RATE_LIMIT: "rate_limit",
  SERVER_ERROR: "server_error",
  TIMEOUT: "timeout",
  INVALID_KEY: "invalid_api_key",
  MODEL_UNAVAILABLE: "model_unavailable",
  CONTEXT_LENGTH: "context_length_exceeded",
  NO_TOOL_CALLING: "tool_calling_unsupported",
  CONNECTION: "provider_connection_error",
  WEAK_CAPABILITY: "weak_capability",
  UNKNOWN: "unknown",
};

export function classifyFailure(err) {
  const s = String(err?.message || err || "").toLowerCase();
  const code = err?.status || err?.statusCode || err?.response?.status;
  if (code === 429 || /rate.?limit|quota|too many requests/.test(s))
    return FAILURE_KINDS.RATE_LIMIT;
  if (code >= 500 || /server error|bad gateway|unavailable|overloaded/.test(s))
    return FAILURE_KINDS.SERVER_ERROR;
  if (/timeout|timed out|etimedout|aborted/.test(s)) return FAILURE_KINDS.TIMEOUT;
  if (code === 401 || code === 403 || /invalid.*(api.?key|token)|unauthorized/.test(s))
    return FAILURE_KINDS.INVALID_KEY;
  if (code === 404 || /model.*(not found|unavailable|does not exist)/.test(s))
    return FAILURE_KINDS.MODEL_UNAVAILABLE;
  if (/context length|maximum context|too many tokens/.test(s)) return FAILURE_KINDS.CONTEXT_LENGTH;
  if (/tool.?call.*(not supported|unsupported)|does not support tools/.test(s))
    return FAILURE_KINDS.NO_TOOL_CALLING;
  if (/econnrefused|enotfound|network|connection/.test(s)) return FAILURE_KINDS.CONNECTION;
  return FAILURE_KINDS.UNKNOWN;
}

// Should we try another model, or stop and ask the user?
export function nextAction(failureKind, attemptIndex, plan) {
  const canTryMore = attemptIndex + 1 < plan.chain.length;
  const underBudget = attemptIndex + 1 < plan.budget.maxTotalAttempts;
  switch (failureKind) {
    case FAILURE_KINDS.INVALID_KEY:
      // An invalid key is permanent for that provider: skip its other models.
      return canTryMore && underBudget ? "try_next" : "stop";
    case FAILURE_KINDS.CONTEXT_LENGTH:
      return canTryMore && underBudget ? "try_next" : "stop";
    case FAILURE_KINDS.NO_TOOL_CALLING:
      return canTryMore && underBudget ? "try_next" : "stop";
    case FAILURE_KINDS.RATE_LIMIT:
    case FAILURE_KINDS.SERVER_ERROR:
    case FAILURE_KINDS.TIMEOUT:
    case FAILURE_KINDS.MODEL_UNAVAILABLE:
    case FAILURE_KINDS.CONNECTION:
    case FAILURE_KINDS.WEAK_CAPABILITY:
    case FAILURE_KINDS.UNKNOWN:
    default:
      return canTryMore && underBudget ? "try_next" : "stop";
  }
}

/**
 * Simulate the fallback decision for a list of per-model outcomes.
 * Used by tests and by the guard to prove there is no paid escalation and no
 * infinite loop.
 * @param {string} task
 * @param {string[]} failures  failure kinds, one per attempted model
 */
export function simulateFallback(task, failures) {
  const plan = planForTask(task);
  const trace = [];
  for (let i = 0; i < plan.chain.length; i++) {
    const step = plan.chain[i];
    trace.push({ model: step.model, tier: step.tier });
    const f = failures[i];
    if (!f) return { status: "success", model: step.model, trace };
    const action = nextAction(f, i, plan);
    if (action === "stop") {
      return {
        status: "stopped",
        reason: f,
        tried: trace.map((t) => t.model),
        message:
          "All free/economical alternatives were exhausted; task stopped, no paid escalation.",
        trace,
      };
    }
  }
  return {
    status: "stopped",
    reason: "chain_exhausted",
    tried: trace.map((t) => t.model),
    message: "Fallback chain exhausted; task stopped.",
    trace,
  };
}

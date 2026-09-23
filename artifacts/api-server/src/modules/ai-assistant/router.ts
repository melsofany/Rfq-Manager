/**
 * AI Assistant — intent / query router.
 *
 * A deterministic layer that sits BEFORE the LLM and decides how a question
 * should be handled: which intent it is, whether it may go down the FAST path
 * (a couple of rounds) or the DEEP path (the full tool budget), and whether the
 * post-answer verification has anything to gain.
 *
 * Why a router at all: every question used to take the same path and consume the
 * same budget, so a simple "which supplier owns PO 104?" cost the same rounds as
 * a year-long email census — and on Gemini's free tier (20 requests/day/model)
 * that budget is the scarce resource. The router is deliberately RULES-BASED,
 * not an LLM call: it must be free, instant, explainable, and testable. When it
 * cannot classify confidently it returns the DEEP path with `intent: "analytics"`
 * — the safe default — so an unusual question is treated as hard rather than
 * mis-routed as trivial.
 *
 * It never answers anything itself. It only allocates budget and gives the model
 * a short hint about the likely tool.
 */

/** What the question is about. Drives the prompt hint and the tool budget. */
export type QueryIntent =
  | "document_lookup"
  | "supplier_lookup"
  | "count_aggregate"
  | "email_search"
  | "report"
  | "analytics"
  | "smalltalk";

export type QueryPath = "fast" | "deep";

export interface RoutePlan {
  intent: QueryIntent;
  path: QueryPath;
  /** Hard ceiling on model rounds for this question. */
  maxRounds: number;
  /** Whether the post-answer grounding verification is worth its budget. */
  verify: boolean;
  /** Short, loggable explanation of why this route was chosen. */
  reason: string;
  /** One-line tool hint appended to the prompt (empty when none applies). */
  hint: string;
}

/** A fast-path question gets at most this many model rounds (see agent.ts). */
export const FAST_MAX_ROUNDS = 2;

/**
 * Rounds allowed on the deep path — the full tool budget. Each round costs one
 * provider request, so this is a budget as much as a limit (Gemini free tier:
 * 20 requests/day/model). 5 covers gather → refine → answer, and the last round
 * always produces text (the agent forbids tools there).
 */
export const DEEP_MAX_ROUNDS = 5;

/**
 * Arabic text is normalised before matching: diacritics/tatweel removed and the
 * letter variants that Arabic writers use interchangeably folded together, so
 * «تسعير» matches «تسعير» regardless of hamza/ya spelling. Without this the
 * router silently misses questions and sends everything down the deep path.
 */
export function normalizeArabic(input: string): string {
  return (input || "")
    .replace(/[\u0617-\u061A\u064B-\u0652\u0670\u0640]/g, "") // harakat + tatweel
    .replace(/[إأآٱا]/g, "ا")
    .replace(/[ىي]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ؤئء]/g, "ء")
    .toLowerCase()
    .trim();
}

// ─── Matchers ───────────────────────────────────────────────────────────────

/**
 * Aggregate verbs/words that make a question analytical rather than a lookup.
 *
 * Deliberately EXCLUDES the bare quantifiers «كل»/«all»: they appear in email and
 * report requests too («كل المرفقات», «كل البنود»), and matching them here would
 * label those as analytics before the email/report rules could see them. The
 * remaining words are unambiguous analysis signals.
 */
const ANALYTIC_RE =
  /(حصر|احصا|احصائ|احصيه|قارن|مقارن|تحليل|حلل|اجمالي|اجمال|اكثر|الاكثر|توزيع|نسبه|معدل|اتجاه|تطور|لسه|ناقص|متاخر|معلق|غير مكتمل|متبقي|متبقى|\brank\b|\btop\b|compare|analytics?|aggregate|total of|sum of|\boverdue\b|\boutstanding\b|\bpending\b)/;

/** Email / attachment / WhatsApp surfaces. */
const EMAIL_RE = /(بريد|ايميل|ايمل|ميل|رسائل|رساله|مرفق|مرفقات|صندوق|inbox|email|mail|attach)/;

/** Counting questions. The «كام»/«كم» alternatives need a boundary — otherwise
 *  «كامل» (complete) reads as «كام» (how many) and a report request is mistaken
 *  for a count question. */
const COUNT_RE = /(^|\s)(كام|كم|عدد|كميات|كميه)(\s|$|؟|\?)|\b(how many|count of)\b/;

/** Document nouns (any document type the system holds). Arabic keeps the
 *  definite article inside the phrase («امر الشراء»), so allow an optional «ال». */
const DOC_RE =
  /(طلب\s*عرض|عرض\s*سعر|امر\s*ال?شراء|اوامر\s*ال?شراء|امر\s*توريد|فاتور|مستند|رقم\s*الامر|رقم\s*الطلب|رقم\s*الفاتور|\bpo\b|\brfq\b|\bso\b)/;

/** A document number: an alphanumeric id (letters AND digits, e.g. P26E11407,
 *  `26R011936`) or a bare 3+ digit run. */
const DOC_NUMBER_RE = /\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{4,}\b|\b\d{3,}\b/;

/** Supplier nouns. */
const SUPPLIER_RE = /(مورد|موردين|الموردين|supplier|vendor)/;

/** File/report verbs. */
const REPORT_RE = /(تقرير|ملف|اكسل|اكسيل|pdf|تصدير|export|ارسل لي|نزلي|csv)/;

/** Greetings / pure chit-chat. */
const SMALLTALK_RE =
  /^(السلام عليكم|سلام عليكم|مرحبا|اهلا|هاي|صباح الخير|مساء الخير|شكرا|تمام|ok|hello|hi|thanks)[!. ]*$/;

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Classify one question into a route plan.
 *
 * Ordering is the design: analytical/scope questions are checked FIRST so a
 * phrase like «اعمل حصر لكل PO في البريد خلال 2026» is not mistaken for a
 * document lookup merely because it contains «PO» and a year. Only after the
 * aggregate and email surfaces are ruled out does a bare document number mean
 * "look up this document".
 */
export function routeQuestion(rawText: string): RoutePlan {
  const text = normalizeArabic(rawText);

  if (!text) {
    return {
      intent: "smalltalk",
      path: "fast",
      maxRounds: FAST_MAX_ROUNDS,
      verify: false,
      reason: "empty message",
      hint: "",
    };
  }

  // 1. Analytical / comparative / scope question → deep, verify is worthwhile.
  if (ANALYTIC_RE.test(text)) {
    return {
      intent: "analytics",
      path: "deep",
      maxRounds: DEEP_MAX_ROUNDS,
      verify: true,
      reason: "aggregate/comparison wording",
      hint:
        "سؤال تحليلي/حصر: استخدم الأدوات التي تُجمِع في قاعدة البيانات أو adat الحصر في البريد، " +
        "ولا تُجرِ الجمع يدويًا. اذكر دائمًا هل النتيجة كاملة أم عيّنة.",
    };
  }

  // 2. Email / attachment questions → deep (mailbox reading is rarely one round).
  if (EMAIL_RE.test(text)) {
    return {
      intent: "email_search",
      path: "deep",
      maxRounds: DEEP_MAX_ROUNDS,
      verify: true,
      reason: "email/attachment wording",
      hint: "سؤال بريد: search_emails للحصر النقطي، scan_emails للحصر الكامل، scan_email_items للبنود داخل المرفقات.",
    };
  }

  // 3. Counting question → fast, but verification stays ON because the answer
  //    is numeric and a wrong count is exactly the failure mode we guard.
  if (COUNT_RE.test(text)) {
    return {
      intent: "count_aggregate",
      path: "fast",
      maxRounds: FAST_MAX_ROUNDS,
      verify: true,
      reason: "counting wording",
      hint: "سؤال عدّ: استخدم count_database أو دالة تجميع في قاعدة البيانات، لا تعتمد على عيّنة.",
    };
  }

  // 4. A specific document number → fast single-record lookup.
  if (DOC_RE.test(text) && DOC_NUMBER_RE.test(text)) {
    return {
      intent: "document_lookup",
      path: "fast",
      maxRounds: FAST_MAX_ROUNDS,
      verify: true,
      reason: "document noun + number",
      hint: "سؤال عن مستند بعينه: استخدم lookup_document بالرقم مباشرة، ثم أجب من نتيجة الأداة.",
    };
  }

  // 5. Question about a supplier → fast single-entity overview.
  if (SUPPLIER_RE.test(text)) {
    return {
      intent: "supplier_lookup",
      path: "fast",
      maxRounds: FAST_MAX_ROUNDS,
      verify: true,
      reason: "supplier wording",
      hint: "سؤال عن مورد: استخدم supplier_overview لجلب كل شيء في استدعاء واحد.",
    };
  }

  // 6. A file/report request → deep (generation + delivery).
  if (REPORT_RE.test(text)) {
    return {
      intent: "report",
      path: "deep",
      maxRounds: DEEP_MAX_ROUNDS,
      verify: true,
      reason: "report/file wording",
      hint: "طلب تقرير/ملف: استخدم أدوات الحصر مع exportCsv/exportPdf، أو generate_pdf.",
    };
  }

  // 7. Pure greeting / chit-chat → fast, no verification (no facts to check).
  if (SMALLTALK_RE.test(text) && words(text) <= 4) {
    return {
      intent: "smalltalk",
      path: "fast",
      maxRounds: FAST_MAX_ROUNDS,
      verify: false,
      reason: "greeting only",
      hint: "",
    };
  }

  // Default: unknown → treat as hard. Mis-routing a genuine analysis as a quick
  // lookup is the expensive error (it answers confidently from a sample); the
  // reverse merely costs a round.
  return {
    intent: "analytics",
    path: "deep",
    maxRounds: DEEP_MAX_ROUNDS,
    verify: true,
    reason: "unclassified — safe default",
    hint: "",
  };
}

/** Convenience: the router's hint as a system-prompt fragment (may be empty). */
export function routeHint(plan: RoutePlan): string {
  if (!plan.hint) return "";
  return `\n\nتوجيه هذه الجولة (${plan.path === "fast" ? "مسار سريع" : "مسار تحليلي"}): ${plan.hint}`;
}

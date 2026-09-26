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
  | "procurement_ops"
  | "smalltalk";

export type QueryPath = "fast" | "deep";

/**
 * Which SOURCE the operator demanded, when they said so explicitly.
 *
 * «من الميل مش قاعدة البيانات» is not a preference — it is the requirement. The
 * recorded failure is the model answering an email question from the internal
 * purchase-order table and reporting it as a complete census of the mail, which
 * is a different dataset entirely. `sourceScope` makes that demand explicit so
 * the run can be checked against it.
 */
export type SourceScope = "email" | "any";

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
  /**
   * "email" when the operator named the mailbox as the required source (or
   * explicitly excluded the database). The answer is then only acceptable if an
   * email tool actually ran — see the check in `agent.ts`.
   */
  sourceScope: SourceScope;
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
  /(حصر|احصا|احصائ|احصيه|قارن|مقارن|تحليل|حلل|اجمالي|اجمال|اكثر|الاكثر|افضل|فرق|رصيد|توزيع|نسبه|معدل|اتجاه|تطور|لسه\s*ما|ناقص|متاخر|معلق|غير\s*مدفوع|مستحق|غير مكتمل|متبقي|متبقى|اخر\s*سعر|\brank\b|\btop\b|compare|analytics?|aggregate|total of|sum of|\boverdue\b|\boutstanding\b|\bpending\b)/;

/**
 * Delivery-request wording: the operator is asking for a FILE/report to be sent
 * back. Checked before the analytic rule so «ابعت تقرير بالأرقام الناقصة» is a
 * report, not an analysis. Deliberately excludes the bare words «ملف»/«pdf» — they
 * appear in questions ABOUT attachments («إيه الإيميلات اللي فيها ملفات PDF؟»),
 * which are email searches and would be mis-labelled as report requests.
 */
const REPORT_DELIVERY_RE =
  /(تقرير|اكسل|اكسيل|تصدير|export|نزلي|هاتلي تقرير|ارسل لي|ابعتلي|ابعت لي|csv)/;

/** Email / attachment / WhatsApp surfaces. */
const EMAIL_RE = /(بريد|ايميل|ايمل|ميل|رسائل|رساله|مرفق|مرفقات|صندوق|inbox|email|mail|attach)/;

/** Counting questions. The «كام»/«كم» alternatives need a boundary — otherwise
 *  «كامل» (complete) reads as «كام» (how many) and a report request is mistaken
 *  for a count question. «أرقام» (numbers) is included because «أرقام الموردين»
 *  is a count request that carries no «كام». */
const COUNT_RE = /(^|\s)(كام|كم|عدد|ارقام|كميات|كميه)(\s|$|؟|\?)|\b(how many|count of)\b/;

/** Document nouns (any document type the system holds). Arabic keeps the
 *  definite article inside the phrase («امر الشراء»), so allow an optional «ال». */
const DOC_RE =
  /(طلب\s*عرض|عرض\s*سعر|امر\s*ال?شراء|اوامر\s*ال?شراء|امر\s*توريد|فاتور|مستند|رقم\s*الامر|رقم\s*الطلب|رقم\s*الفاتور|\bpo\b|\brfq\b|\bso\b)/;

/** A document number: an alphanumeric id (letters AND digits, e.g. P26E11407,
 *  `26R011936`) or a bare 3+ digit run. */
const DOC_NUMBER_RE = /\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{4,}\b|\b\d{3,}\b/;

/** Supplier nouns. */
const SUPPLIER_RE = /(مورد|موردين|الموردين|supplier|vendor)/;

/** A bare sheet-style PO/RFQ code (P26E11407, R26E…) — enough on its own to mean
 *  "this document", without a document noun. Kept narrow so it cannot match a
 *  price or a quantity. */
const PO_CODE_RE = /\b[pqr]\d{2}[a-z]\d{4,}\b/;
/** Greetings / pure chit-chat, as a whole message («هاي» alone). Matched ONLY
 *  when it is the entire message, because «هاي» is also the start of a supplier
 *  name («هاي فولت») — a prefix match there would swallow a real lookup. */
const SMALLTALK_EXACT_RE =
  /^(السلام عليكم|سلام عليكم|مرحبا|اهلا|هاي|صباح الخير|مساء الخير|شكرا|تمام|ok|hello|hi|thanks)[!. ]*$/;

/** A greeting that opens a short message («صباح الخير يا هندسة»). Requires no
 *  data signal to be present (checked by the caller) so «تمام، كام أمر شراء؟»
 *  is not mistaken for chit-chat. */
const SMALLTALK_PREFIX_RE = /^(السلام عليكم|سلام عليكم|مرحبا|اهلا|صباح الخير|مساء الخير|شكرا)/;

/**
 * Procurement WORKING-SET wording: the operator asking what is outstanding right
 * now — overdue deliveries, open/unreceived POs, unfulfilled lines, late
 * suppliers. These map to the dedicated DB-first tools (get_overdue_deliveries /
 * get_unfulfilled_orders) rather than to a generic analysis, so naming the tool
 * here is what stops the model answering from a sample of rows it happened to
 * read. Checked BEFORE the generic analytic rule (its words overlap it).
 */
const PROCUREMENT_OPS_RE =
  /(متاخر|متأخر|فات\s*ميعاد|فات\s*موعد|تاخير|تسليمات|غير\s*مسلم|لسه\s*ما\s*وصل|لم\s*يصل|لم\s*تصل|open\s*po|overdue|late\s*deliver|unfulfilled|not\s*received|pending\s*(po|order|deliver))/;

/** Group/plural supplier wording — a question about a SET is analytical, not a
 *  single-entity lookup («الموردين اللي عرضوا أسعار آخر شهر»). Checked AFTER the
 *  count rule so «أرقام الموردين» remains a count. */
const SUPPLIER_PLURAL_RE = /(موردين|موردون|الموردين|الموردون|\bsuppliers\b|\bvendors\b)/;

/**
 * Customer-purchase-order wording: the operator asking about the orders a
 * CUSTOMER sent us (EDC et al.) — a different table from our own supplier POs.
 *
 * This distinction is the whole point: `customer_pos` holds ~767 headers and
 * ~1,993 lines, while `purchase_orders` holds 39 and 65. The model answered a
 * customer-PO question from the supplier table and reported 39/65 as the total,
 * then denied that a record visible on screen (`CPO-2025-000484` / `P25E26553`,
 * id 841) existed. A hint naming the right tool is what keeps the small table
 * from being mistaken for the whole history.
 */
const CUSTOMER_PO_RE =
  /(اوامر\s*شراء\s*العملاء|امر\s*شراء\s*العميل|اوامر\s*العميل|من\s*العميل|الوارده\s*من|وارده\s*من|مورده\s*للعملاء|المورده|توريدات|client\s*po|customer\s*po)/;

/** A customer-side document code that is UNAMBIGUOUS: our internal customer-PO
 *  number `CPO-2025-000484` exists only in `customer_pos` (supplier POs use
 *  `PO-2026-…`).
 *
 *  Deliberately does NOT include the `P25E…`/`P26E…` sheet codes: all 39 supplier
 *  POs share their `sheetPoNo` with a customer PO (a supplier PO is raised
 *  against a customer order), so that form lives in BOTH tables and a rule
 *  forcing one of them would be wrong half the time. Those stay a document
 *  lookup, where `lookup_document` already checks the sibling table on a miss. */
const CUSTOMER_PO_CODE_RE = /\bcpo-\d{4}-\d{6}\b/i;

/**
 * The operator NAMING the mailbox as the required source, or excluding the
 * internal system.
 *
 * «بقولك من الميل مش قاعده البيانات» was answered from the purchase-order table
 * — a complete census of a different dataset, presented as the answer about the
 * mail. The demand has to be recognised as a CONSTRAINT, not a topic: it is
 * matched here so the run can be verified against it. Two shapes:
 *  - a source directive: «من الإيميل», «من البريد», «ادخل الميل», «افحص البريد»;
 *  - an explicit exclusion: «مش قاعدة البيانات», «مش النظام», «لا من الداتا».
 */
const EMAIL_SCOPE_RE =
  /(من\s*ال(بريد|ايميل|ايمل|ميل)|في\s*ال(بريد|ايميل|ميل)|ادخل\s*ال(بريد|ايميل|ميل)|افحص\s*ال(بريد|ايميل|ميل|مرفقات)|من\s*(الميل|الايميل|الايمل)|فى\s*(الميل|الايميل)|from\s+(the\s+)?(email|mail|inbox)|from\s+email|in\s+the\s+mailbox)/;

/** The operator explicitly excluding the internal database as a source. */
const NOT_DB_SCOPE_RE =
  /(مش\s*(?:من\s*)?(?:قاعده|قاعدة)\s*البيانات|مش\s*ال(نظام|داتا|داتابيز|داتا\s*بيس)|لسه\s*مش\s*فرق|لا\s*من\s*ال(داتا|قاعده)|not\s+(?:from\s+)?(?:the\s+)?database|not\s+from\s+(the\s+)?(db|system))/;

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

  // A source constraint is computed once and attached to every plan, so no
  // branch can forget it: «من الميل مش قاعدة البيانات» must survive whichever
  // intent the question also matches.
  const sourceScope: SourceScope =
    EMAIL_SCOPE_RE.test(text) || NOT_DB_SCOPE_RE.test(text) ? "email" : "any";

  if (!text) {
    return {
      intent: "smalltalk",
      path: "fast",
      maxRounds: FAST_MAX_ROUNDS,
      verify: false,
      reason: "empty message",
      hint: "",
      sourceScope,
    };
  }

  // 0. Pure greeting / chit-chat FIRST → fast, no verification (no facts to
  //    check). Checked before everything else so «شكراً جداً» is not dragged into
  //    the deep path by a stray word. Two forms: the whole message is a greeting,
  //    or it OPENS with one and carries no data signal («صباح الخير يا هندسة»).
  const hasDataSignal =
    ANALYTIC_RE.test(text) ||
    COUNT_RE.test(text) ||
    EMAIL_RE.test(text) ||
    REPORT_DELIVERY_RE.test(text) ||
    (DOC_RE.test(text) && DOC_NUMBER_RE.test(text));
  if (
    (SMALLTALK_EXACT_RE.test(text) || (SMALLTALK_PREFIX_RE.test(text) && !hasDataSignal)) &&
    words(text) <= 5
  ) {
    return {
      intent: "smalltalk",
      path: "fast",
      maxRounds: FAST_MAX_ROUNDS,
      verify: false,
      reason: "greeting only",
      hint: "",
      sourceScope,
    };
  }

  // 1. A delivery/report request → deep (generation + delivery). Checked BEFORE
  //    the analytic rule: «ابعت تقرير بالأرقام الناقصة» both asks for a file and
  //    contains aggregate wording, and the FILE is the primary ask.
  if (REPORT_DELIVERY_RE.test(text)) {
    return {
      intent: "report",
      path: "deep",
      maxRounds: DEEP_MAX_ROUNDS,
      verify: true,
      reason: "report/file delivery wording",
      hint: "طلب تقرير/ملف: استخدم أدوات الحصر مع exportCsv/exportPdf، أو generate_pdf.",
      sourceScope,
    };
  }

  // 2. Email / attachment questions → deep (mailbox reading is rarely one round).
  //    Checked before analytics/supplier so «الفواتير غير المدفوعة للمورد EDC»
  //    phrased with a mailbox is not reduced to a single supplier lookup.
  if (EMAIL_RE.test(text)) {
    return {
      intent: "email_search",
      path: "deep",
      maxRounds: DEEP_MAX_ROUNDS,
      verify: true,
      reason: "email/attachment wording",
      hint:
        "سؤال بريد: search_emails للحصر النقطي، scan_emails للحصر الكامل، scan_email_items للبنود داخل المرفقات. " +
        "إن كان النطاق كبيرًا (سنة كاملة/مئات الرسائل) فاستخدم start_census_job ليعمل الحصر في الخلفية ويصل التقرير تلقائيًا.",
      sourceScope,
    };
  }

  // 3. Analytical / comparative / scope question → deep, verify is worthwhile.
  //    Outstanding-work wording is checked FIRST: «متأخر»/«overdue» are also
  //    analytic words, so if the generic rule ran first these questions would
  //    lose the tool hint that makes the answer exact.
  if (PROCUREMENT_OPS_RE.test(text)) {
    return {
      intent: "procurement_ops",
      path: "deep",
      maxRounds: DEEP_MAX_ROUNDS,
      verify: true,
      reason: "outstanding-work wording",
      hint:
        "سؤال عن المتأخر/المعلَّق: استخدم get_overdue_deliveries لتسليمات العملاء المتأخرة، " +
        "وget_unfulfilled_orders لبنود أوامر الشراء غير المستلمة. النتيجة محسوبة في قاعدة البيانات " +
        "للفترة/المورد المطلوب؛ اذكر العدد الإجمالي وأقدم الحالات، ولا تعتمد على عيّنة قرأتها.",
      sourceScope,
    };
  }

  if (ANALYTIC_RE.test(text)) {
    return {
      intent: "analytics",
      path: "deep",
      maxRounds: DEEP_MAX_ROUNDS,
      verify: true,
      reason: "aggregate/comparison wording",
      hint:
        "سؤال تحليلي/حصر: استخدم الأدوات التي تُجمِع في قاعدة البيانات أو أدوات الحصر في البريد، " +
        "ولا تُجرِ الجمع يدويًا. اذكر دائمًا هل النتيجة كاملة أم عيّنة." +
        // The table choice is the failure this hint prevents: the supplier table
        // holds 39 headers / 65 lines against the customer table's 767 / 1,993,
        // so answering a customer-order question from it reports a small number
        // and denies real records. Naming the tool removes the choice.
        (CUSTOMER_PO_RE.test(text) || CUSTOMER_PO_CODE_RE.test(text)
          ? " هذه أسئلة عن أوامر شراء **العملاء**: استخدم aggregate_customer_po_items " +
            "(جدول customer_po_items) وليس aggregate_po_items — الأخيرة تقرأ جدول أوامر " +
            "الموردين وهو صغير جدًا وسيُنفي وجود آلاف السجلات الموجودة."
          : ""),
      sourceScope,
    };
  }

  // 3b. A customer-PO internal number (CPO-YYYY-NNNNNN) is unambiguous: it exists
  //     ONLY in customer_pos (supplier POs are numbered PO-YYYY-NNNNNN), so the
  //     question is answerable without guessing between two tables. Checked
  //     before the generic document rule, whose hint names the supplier tool by
  //     default and would send the model to the small table.
  if (CUSTOMER_PO_CODE_RE.test(text)) {
    return {
      intent: "document_lookup",
      path: "fast",
      maxRounds: FAST_MAX_ROUNDS,
      verify: true,
      reason: "customer-PO internal number",
      hint:
        "رقم أمر شراء عميل داخلي (CPO-…) — موجود في جدول customer_pos وحده. " +
        "استخدم lookup_document بنوع customer_po، وللحصر/التجميع استخدم " +
        "aggregate_customer_po_items (customer_po_items) وليس aggregate_po_items.",
      sourceScope,
    };
  }

  // 4. Counting question → fast, but verification stays ON because the answer
  //    is numeric and a wrong count is exactly the failure mode we guard.
  if (COUNT_RE.test(text)) {
    return {
      intent: "count_aggregate",
      path: "fast",
      maxRounds: FAST_MAX_ROUNDS,
      verify: true,
      reason: "counting wording",
      hint:
        "سؤال عدّ: استخدم count_database أو دالة تجميع في قاعدة البيانات، لا تعتمد على عيّنة." +
        (CUSTOMER_PO_RE.test(text) || CUSTOMER_PO_CODE_RE.test(text)
          ? " هذا عدّ لأوامر/أصناف **العملاء**: استخدم aggregate_customer_po_items أو " +
            "count_database على customer_pos / customer_po_items — وليس purchase_orders " +
            "(جدول الموردين الصغير) وإلا فسيكون العدد ناقصًا بشكل خطير."
          : ""),
      sourceScope,
    };
  }

  // 5. A specific document number → fast single-record lookup. Either a document
  //    noun WITH a number, or a bare sheet-style code that is unambiguous on its
  //    own («P26E13477 اتبعت لمين؟»).
  if ((DOC_RE.test(text) && DOC_NUMBER_RE.test(text)) || PO_CODE_RE.test(text)) {
    return {
      intent: "document_lookup",
      path: "fast",
      maxRounds: FAST_MAX_ROUNDS,
      verify: true,
      reason: "document noun + number",
      hint: "سؤال عن مستند بعينه: استخدم lookup_document بالرقم مباشرة، ثم أجب من نتيجة الأداة.",
      sourceScope,
    };
  }

  // 6. Question about a supplier → fast single-entity overview. The PLURAL form
  //    («الموردين») is a set question and falls through to the analytics default,
  //    which is correct: listing/comparing suppliers is analysis, not a lookup.
  if (SUPPLIER_RE.test(text) && !SUPPLIER_PLURAL_RE.test(text)) {
    return {
      intent: "supplier_lookup",
      path: "fast",
      maxRounds: FAST_MAX_ROUNDS,
      verify: true,
      reason: "supplier wording",
      hint: "سؤال عن مورد: استخدم supplier_overview لجلب كل شيء في استدعاء واحد.",
      sourceScope,
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
    sourceScope,
  };
}

/** Convenience: the router's hint as a system-prompt fragment (may be empty). */
export function routeHint(plan: RoutePlan): string {
  const scopeHint =
    plan.sourceScope === "email"
      ? "\n\nمصدر هذه الجولة مقيَّد: المستخدم طلب البيانات من البريد الإلكتروني تحديدًا (لا من قاعدة البيانات الداخلية). " +
        "استخدم أدوات البريد (scan_emails / scan_email_items / search_emails) فقط، " +
        "ولا تبنِ الإجابة على جدول purchase_orders. إن كانت النتيجة ناقصة فاذكر النطاق بوضوح."
      : "";
  if (!plan.hint) return scopeHint;
  return `\n\nتوجيه هذه الجولة (${plan.path === "fast" ? "مسار سريع" : "مسار تحليلي"}): ${plan.hint}${scopeHint}`;
}

/**
 * Answer-side checks for the WhatsApp assistant: how confident a reply may be,
 * whether its figures are grounded in tool results, whether a refusal or a
 * mail-access failure must be disclosed, and the fallback answer when a run
 * ends without one.
 *
 * Moved out of agent.ts. Behaviour-neutral: the functions are the same, now
 * exported so they can be tested directly.
 */
import { db } from "@workspace/db";
import { and } from "drizzle-orm";
import { logger } from "../../shared/logger";
import { chatCompletion, type ChatMessage, type ToolCall } from "./llm";
import { type AiSettings } from "./config";
import { type EntityName } from "./db-tools";
import type { AiAssistantMemory } from "@workspace/db";
import { type OrgProfile } from "./org-profiles";
import { toolCacheKey } from "./task-loop";
import { EMAIL_TOOL_NAMES } from "./tool-scope";
import type { Confidence } from "./evidence";
import { VOCAB_PROMPT_LIMIT } from "./system-prompt";

/**
 * The evidence level to show against an answer on the dashboard.
 *
 * Deliberately derived from what actually happened in the run, not from a claim:
 * a reply that used no tool has nothing behind its figures, a numeric
 * reconciliation that disagreed is explicitly partial, and a reply that needed
 * the grounding-correction round is downgraded — a correction means the first
 * draft contained something the evidence did not support.
 */
export function answerConfidence(
  toolCalls: number,
  verificationRan: boolean,
  numericDisagreed: boolean,
): Confidence {
  if (numericDisagreed) return "PARTIALLY_VERIFIED";
  // No tool ran: a greeting or a meta question. Nothing to verify, and nothing
  // was claimed from data, so this is not a weak answer.
  if (toolCalls === 0) return "VERIFIED";
  if (verificationRan) return "PARTIALLY_VERIFIED";
  return "VERIFIED";
}

/**
 * Tools whose figures come from the mailbox rather than the database.
 *
 * Imported from `tool-scope` rather than duplicated. The two copies had already
 * drifted — the local one lacked `send_email`/`start_census_job`/`job_status` —
 * so a live run that started a mail census job was labelled «لم يُقرأ البريد في
 * هذه الجولة» by a set that simply did not recognise the tool. The scope module
 * is also the one that decides which tools the model CAN call, so it is the only
 * correct source for "what counts as reading the mail".
 */
export const EMAIL_TOOLS = EMAIL_TOOL_NAMES;

/**
 * Markers of a mailbox READ FAILURE, as opposed to an empty result.
 *
 * The distinction is the whole point: «لا توجد رسائل من EDC» is a claim about
 * the mailbox, and it may only be made after the mailbox was actually opened.
 * Live, an unauthorised service account made every read throw while the
 * assistant reported an empty mailbox for it (see `findMailAccessFailure`).
 */
const MAIL_ACCESS_FAILURE_RE =
  /غير مُفوَّض|unauthorized_client|invalid_grant|admin_policy_enforced|invalid delegation|تعذّر قراءة|لم يتمكّن من قراءة البريد|ACCESS_DENIED/i;

/** Records a mailbox access failure seen in a tool result, keeping one reason. */
export function noteMailAccessFailure(evidence: string[], text: unknown): void {
  if (typeof text !== "string" || !MAIL_ACCESS_FAILURE_RE.test(text)) return;
  evidence.push(text.slice(0, 300));
}

/**
 * Returns the recorded reason if the run tried to read mail and FAILED.
 *
 * A negative answer about the mail is only trustworthy when the read happened,
 * so this is checked rather than trusting the prompt to caveat itself.
 */
export function findMailAccessFailure(
  usedTools: Array<{ name: string }>,
  evidence: string[],
): string | null {
  if (!evidence.length) return null;
  if (!usedTools.some((t) => EMAIL_TOOLS.has(t.name))) return null;
  return evidence[0];
}

/**
 * Tools that produce NO figures of their own — they launch or inspect work.
 *
 * They must not count as "database" when deciding whether an answer's numbers may
 * be reconciled: a live email-census answer that also called `job_status` was
 * classified as database-sourced and its (correct) email total was compared to a
 * `purchase_order_items` sum, producing the bogus «المرصود … والمحسوب … ⇒
 * PARTIALLY_VERIFIED» footer.
 */
const META_TOOLS = new Set([
  "job_status",
  "start_census_job",
  "generate_pdf",
  "remember_fact",
  "recall_memory",
  "forget_memory",
  "learn_organization",
  "classify_document_number",
  "list_models",
]);

/**
 * Which source an answer's figures came from.
 *
 * The numeric verifier reconciles a reported total against the DATABASE, so it
 * may only run when the database produced the figure. An email census and the
 * database legitimately hold different numbers (the mailbox has orders the
 * system does not), and comparing them flagged every correct email answer as
 * PARTIALLY_VERIFIED — the live «المرصود 235800 والمحسوب من قاعدة البيانات 14265»
 * on a reply that was entirely about the mail.
 */
export function answerSource(
  usedTools: Array<{ name: string }>,
): "database" | "email" | "mixed" | "unknown" {
  if (!usedTools.length) return "unknown";
  // Meta tools carry no figures, so they must not decide the source: an email
  // census that also asked `job_status` is still an EMAIL answer.
  const names = new Set(usedTools.map((t) => t.name).filter((n) => !META_TOOLS.has(n)));
  if (!names.size) return "unknown";
  const email = [...names].some((n) => EMAIL_TOOLS.has(n));
  const db = [...names].some((n) => !EMAIL_TOOLS.has(n));
  if (email && db) return "mixed";
  return email ? "email" : "database";
}

/**
 * Quantity/money totals a tool result reports about ITSELF, so the numeric
 * verifier can reconcile the answer against the tool's own aggregate.
 *
 * Only aggregates that describe a WHOLE result are collected. A per-row `qty`
 * (one line item) is deliberately ignored: the verifier compares a figure to a
 * database SUM, so reconciling against a single line would report a disagreement
 * on a perfectly correct answer.
 */
export function collectToolTotals(toolName: string, content: string): number[] {
  const out: number[] = [];
  const push = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n >= 1000) out.push(n);
  };
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  const data = parsed.data ?? parsed;
  if (typeof data.totalQty === "number") push(data.totalQty);
  if (typeof data.openQty === "number") push(data.openQty);
  if (typeof data.qty === "number") push(data.qty);
  // `aggregate_po_items` returns per-item rows; the sum of those rows IS the
  // dataset total the operator would quote.
  if (Array.isArray(data.items) && toolName === "aggregate_po_items") {
    const sum = data.items.reduce((a: number, r: any) => a + (Number(r?.totalQty) || 0), 0);
    push(sum);
  }
  return out;
}

export function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// `toolCacheKey` moved to `./task-loop` (pure module) so the Mastra engine can
// share the identical dedup rule without a circular import. Re-exported here
// because it is part of this module's public surface.
export { toolCacheKey };

/**
 * Document-number-shaped tokens in a piece of text.
 *
 * Shape matters: only strings that carry BOTH letters and digits (optionally
 * hyphen-separated), like `26R011936`, `P26E13477`, `INV-2026-000045`, are
 * treated as a numbered document. Plain numbers — money amounts, quantities,
 * ids, years — are deliberately excluded, because challenging every `3` in a
 * sentence would reject correct prose.
 */
export function findGroundingNumbers(text: string): string[] {
  if (!text) return [];
  // Capture whole id-shaped runs first (letters/digits plus `._-` separators),
  // because splitting on the hyphen would turn `INV-2026-000045` into a bare
  // number and lose the letter that makes it a document id.
  const candidates = text.match(/[A-Za-z0-9][A-Za-z0-9._-]{2,}/g) ?? [];
  const out: string[] = [];
  for (const raw of candidates) {
    const t = raw.replace(/[._-]+$/, "").toUpperCase();
    if (t.length < 4) continue;
    // Must be a genuine mixed alphanumeric doc id: letters AND digits, and not
    // a bare decimal (money/quantity) which the operator never needs checked.
    if (!/\d/.test(t) || !/[A-Z]/.test(t)) continue;
    if (/^\d+(?:[.,]\d+)*$/.test(t)) continue;
    out.push(t);
  }
  return [...new Set(out)];
}

/**
 * Tokens in the answer that never appeared in any tool result.
 *
 * Compares in a normalised form (uppercase, spaces and hyphens removed) so
 * `26R 011936` and `26R-011936` are recognised as the number the tool returned.
 * A token that is a SUBSTRING of a grounded token is accepted too — that is how
 * the model quoting "011936" out of "26R011936" reads. The reverse (the answer
 * token CONTAINING a grounded one, e.g. an extra trailing digit) is not
 * accepted, because an extended id is not the id the tool returned.
 */
export function findUngroundedNumbers(answer: string, grounded: Set<string>): string[] {
  if (!answer) return [];
  const norm = (s: string) => s.replace(/[\s-]+/g, "").toUpperCase();
  const pool = new Set([...grounded].map(norm));
  const bad: string[] = [];
  for (const token of findGroundingNumbers(answer)) {
    const n = norm(token);
    if (pool.has(n)) continue;
    let covered = false;
    for (const g of pool) {
      if (g.includes(n)) {
        covered = true;
        break;
      }
    }
    if (!covered && !bad.includes(token)) bad.push(token);
  }
  return bad;
}

/**
 * The known supplier/customer names, rendered as a checkable list.
 *
 * Bounded on purpose: the prompt must stay small enough not to crowd out the
 * conversation. We list names (and their internal ids) — never prices or counts,
 * which change and belong in tool results.
 */
/**
 * The learning-loop signal, built from data already loaded for this turn.
 *
 * Two things it changes in the model's behaviour, both of which the operator
 * asked for ("with time, and from the user, it learns everything about the
 * company"):
 *  - it SEES that knowledge is accumulating, which makes the teaching rules in
 *    <knowledge_base> concrete rather than aspirational;
 *  - a thin knowledge base becomes an explicit reason to ASK instead of guess,
 *    which is the only way a gap gets filled rather than papered over.
 *
 * Deliberately derived from `memories`/`orgProfiles` that the caller already
 * fetched: an extra query here would sit on the path of every question.
 */
export function renderLearningLead(input: {
  memories: AiAssistantMemory[];
  orgProfiles: OrgProfile[];
  vocabulary: { suppliers: EntityName[]; customers: EntityName[] };
}): string {
  const { memories, orgProfiles, vocabulary } = input;
  const entityCount = vocabulary.suppliers.length + vocabulary.customers.length;
  const learned = memories.length + orgProfiles.length;
  // Nothing loaded at all: the store may simply be unreadable, and claiming
  // "you know nothing" would make the model interrogate the operator about
  // facts the system holds. Stay silent instead of misleading.
  if (!learned && !entityCount) return "";

  const parts: string[] = [
    "\n\nحالة تعلّمك حتى الآن (هذه حلقة مستمرة، وليست تقريرًا):",
    `- ذاكرتك تحمل ${memories.length} معلومة ذات صلة بهذا السؤال، و${orgProfiles.length} بروفايل جهة متعلَّم.`,
  ];
  if (entityCount) parts.push(`- والنظام يسجّل ${entityCount} جهة حقيقية (موردين وعملاء).`);
  // The teaching rule is already stated in <knowledge_base>; repeating it here as
  // a one-liner is what makes it an active behaviour for THIS turn.
  parts.push(
    "- إن كان سؤالك يحتاج قاعدة عمل أو معنى مصطلح أو اسم جهة لا تجده فيما سبق، فاسأل المدير " +
      "بجملة واحدة قبل أن تجيب، وسجّل ما يعلّمك إياه. الحلقة تكتمل بالسؤال، لا بتخمين يعبر.",
  );
  return parts.join("\n");
}

export function renderVocabularyBlock(known: {
  suppliers: EntityName[];
  customers: EntityName[];
}): string {
  const s = known.suppliers.slice(0, VOCAB_PROMPT_LIMIT);
  const c = known.customers.slice(0, VOCAB_PROMPT_LIMIT);
  if (!s.length && !c.length) return "";
  const line = (e: EntityName) => (e.id != null ? `${e.name} (${e.id})` : e.name);
  const parts = ["\n\nأسماء الجهات الحقيقية في النظام (لا تكتب اسمًا غير موجود في هذه القوائم):"];
  if (s.length) parts.push(`الموردون (${known.suppliers.length}): ${s.map(line).join("، ")}`);
  if (c.length) parts.push(`العملاء (${known.customers.length}): ${c.map(line).join("، ")}`);
  parts.push(
    "إن احتجت موردًا أو عميلًا غير موجود في القائمة فقل إنه غير مسجّل، ولا تخترع اسمًا مشابهًا.",
  );
  return parts.join("\n");
}

/**
 * Does the answer read as "I found nothing"? Deliberately conservative: it needs
 * an explicit negative phrase AND no cited document number or entity name, so an
 * answer that merely contains the word «لا» mid-sentence is not misread as a
 * refusal and re-asked needlessly.
 */
const REFUSAL_PATTERNS = [
  /لا\s+(?:يوجد|توجد|توجد\s+نتائج|أجد|اجد|يوجد\s+نتائج|توجد\s+بيانات)/,
  /لم\s+(?:أجد|اجد|أعثر|اعثر|أتمكن|اتمكن)/,
  /لا\s+توجد\s+بيانات/,
  /غير\s+متوفر/,
  /لا\s+توجد\s+معلومات/,
  /(?:no|nothing|not)\s+(?:results?|found|records?|data)/i,
];

export function isRefusalSentence(text: string): boolean {
  return REFUSAL_PATTERNS.some((re) => re.test(text || ""));
}

/** Does the answer contain anything concrete (a cited id or a multi-digit number)? */
export function looksLikeDataFound(text: string): boolean {
  // Only ids and 2+ digit numbers count as "data". Deliberately NOT keyed on
  // words like «مورد»/«أمر»: those appear in the refusal sentence itself
  // («لا يوجد مورد بهذا الاسم») and would suppress the very re-ask we want.
  return findGroundingNumbers(text).length > 0 || /\d{2,}/.test(text ?? "");
}

/**
 * The verification round: hand the model its own draft plus the specific tokens
 * that the evidence does not support, and ask it to remove or correct them.
 *
 * This is the LangGraph "generator → critic" pattern with a DETERMINISTIC critic
 * (token containment, no model call to decide), so it costs one provider request
 * only when a real problem is suspected — never on an ordinary answer. The draft
 * is kept if the model fails to improve it, so a verification failure can never
 * lose a good reply.
 */
export async function verifyGroundedAnswer(opts: {
  settings: AiSettings;
  messages: ChatMessage[];
  finalText: string;
  ungrounded: string[];
  unknownNames: string[];
  /** True when the draft refused without evidence and should widen its search. */
  reask: boolean;
  /**
   * A deterministic contradiction between the answer and the tool trace (a
   * negative claim against a census that matched, or a completeness claim against
   * `isComplete=false`). Folded into the SAME correction round as the grounding
   * problems, so fixing it costs no extra provider request.
   */
  claimCorrection?: string;
  signal: AbortSignal;
}): Promise<string | null> {
  const problems: string[] = [];
  if (opts.ungrounded.length) {
    problems.push(`أرقامًا لم تظهر في أي نتيجة أداة: ${opts.ungrounded.slice(0, 20).join(", ")}`);
  }
  if (opts.unknownNames.length) {
    problems.push(
      `أسماء جهات غير موجودة في قوائم النظام: ${opts.unknownNames.slice(0, 20).join(", ")}`,
    );
  }

  const instruction = opts.reask
    ? "ردك السابق أعلن عدم العثور على المعلومة دون أن تجرّب أدوات كافية. " +
      "لا تُنهِ الرد قبل أن تحاول مرة أخرى فعليًا:\n" +
      "1) جرّب اسمًا بديلًا أو تهجئة أخرى، أو بريدًا آخر، أو جدولًا آخر، أو وسّع المدة (sinceDays).\n" +
      "2) إن طُلب رقم مستند فجرّب البحث بالجزء منه (آخر أرقامه) لا بالرقم كاملًا فقط.\n" +
      "3) إن فشلت كل المحاولات فعلًا، اذكر بالضبط ما جرّبته (الجدول/الكلمة/المدة) — ولا تقل «غير متوفر» وحدها.\n" +
      "أعد نص الرد النهائي فقط، بدون شرح أو مقدمة."
    : opts.claimCorrection
      ? "مراجعة إلزامية قبل الإرسال — تناقض بين ردّك وبين نتيجة الأداة:\n" +
        opts.claimCorrection +
        "\n\n" +
        (problems.length ? `كذلك الرد يحتوي ${problems.join(" و ")}.\n\n` : "") +
        "أعد كتابة الرد النهائي مع الالتزام بالآتي:\n" +
        "1) لا تنفِ وجود بيانات رجعت الأداة بمطابقات لها — اذكر العدد الحقيقي الذي رجعته الأداة.\n" +
        "2) لا تقل إن الحصر شامل إلا إذا كان isComplete=true في نتيجة الأداة.\n" +
        "3) اذكر النطاق صريحًا: المطابق، والمفحوص، والمتبقي.\n" +
        "4) أبقِ أي معلومة ظهرت فعلًا في نتائج الأدوات كما هي.\n" +
        "أعد نص الرد النهائي فقط، بدون شرح أو مقدمة."
      : "مراجعة إلزامية قبل الإرسال: الردّ التالي يحتوي " +
        problems.join(" و ") +
        ".\n" +
        "أعد كتابة الرد مع الالتزام الصارم بالآتي:\n" +
        "1) احذف أي رقم مستند/طلب/أمر/فاتورة لم يظهر حرفيًا في نتيجة أداة، ولا تستبدله برقم مخمّن.\n" +
        "2) احذف أو صحّح أي اسم مورد/عميل غير موجود في قوائم النظام المعطاة لك، ولا تخترع اسمًا شبيهًا.\n" +
        "3) إن كانت المعلومة المطلوبة تعتمد على تلك الأرقام أو الأسماء، فاذكر صراحةً أنها غير متوفرة ولم تُعثر عليها.\n" +
        "4) أبقِ باقي الرد كما هو — لا تُغيّر ما ظهر فعلًا في نتائج الأدوات.\n" +
        "أعد نص الرد النهائي فقط، بدون شرح أو مقدمة.";

  try {
    const res = await chatCompletion({
      model: opts.settings.model,
      baseUrl: opts.settings.baseUrl,
      messages: [
        ...opts.messages,
        { role: "assistant", content: opts.finalText },
        { role: "user", content: instruction },
      ],
      toolChoice: "none",
      signal: opts.signal,
    });
    const text = res.content?.trim();
    return text ? text : null;
  } catch (err) {
    // The draft is already written; an unavailable verifier must not lose it.
    logger.warn({ err }, "AI assistant: grounding verification round failed");
    return null;
  }
}

/**
 * Message shown when the model spent its whole budget on tools without
 * producing an answer. Naming the tools it did call tells the operator the
 * request was worked on (and that retrying the same way will hit the same wall)
 * instead of the misleading "rephrase your question".
 */
export function exhaustedAnswer(
  usedTools: Array<{ name: string; args: unknown; ok: boolean }>,
): string {
  if (usedTools.length === 0) {
    return "لم أتمكن من الوصول لإجابة. جرّب إعادة صياغة السؤال.";
  }
  // Only calls that actually SUCCEEDED count as «خطوات فعلية». A failed call did
  // no work, and reporting it as work is a lie about the run — the live failure
  // announced two database tools on a question whose scope had removed them.
  const worked = [...new Set(usedTools.filter((t) => t.ok).map((t) => t.name))];
  const failed = [...new Set(usedTools.filter((t) => !t.ok).map((t) => t.name))];
  if (worked.length === 0) {
    return (
      "لم أتمكن من إتمام الطلب: لم تنجح أي من المحاولات التي نفّذتها" +
      (failed.length ? ` (${failed.join(", ")})` : "") +
      ". جرّب سؤالًا أكثر تحديدًا وسأعيد المحاولة."
    );
  }
  return (
    "نفدت محاولات المعالجة قبل الوصول لرد نهائي، لكن تم تنفيذ خطوات فعلية: " +
    worked.join(", ") +
    (failed.length ? ` (وفشل: ${failed.join(", ")})` : "") +
    ". جرّب سؤالًا أكثر تحديدًا (مثل رقم أمر التوريد) وسأجيب مباشرة."
  );
}

/**
 * A promise of work the reply itself does not do: «سأفتح هذا الأمر للتأكد».
 *
 * The run ends when the reply is sent. A sentence that promises a NEXT step is
 * therefore a commitment nobody will keep: the operator waits for a follow-up
 * message that never comes (live: «سأفتح هذا الأمر مباشرة…», then silence). The
 * reply must either have done the step or say plainly that it is still open.
 *
 * Returns the offending sentence, or null. Matches first-person future forms in
 * Modern Standard («سأ…», «سوف أ…») and Egyptian («هـ…» + the verbs below).
 */
const PROMISE_STEMS =
  "فتح|تحقق|بدأ|ابدأ|بحث|ستخرج|راجع|قارن|كمل|كمّل|جرب|عيد|فحص|قوم|غيّر|غير|حاول|جلب|حصر|نفذ|تأكد|شوف|دور|جيب|عمل|طابق|حلل|ستكمل|تابع";
const PROMISE_RE = new RegExp(`(?:^|[\\s.،:؛!؟()\\-])(?:سأ|سوف\\s+أ|ه)(?:${PROMISE_STEMS})`, "u");

export function findUnkeptPromise(text: string): string | null {
  for (const raw of String(text ?? "").split(/(?<=[.!؟?\n])\s*/u)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (PROMISE_RE.test(sentence)) return sentence.slice(0, 160);
  }
  return null;
}

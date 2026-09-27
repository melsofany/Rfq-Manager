/**
 * AI Assistant — deterministic claim checks.
 *
 * ## The failure this exists for
 *
 * Live, the operator asked for the top parts on EDC purchase orders. The
 * assistant answered «لم يتم العثور على أي مرفقات … لا توجد ملفات مرفقة قابلة
 * للقراءة» — a NEGATIVE CLAIM — and then, when pushed, found 334 matching
 * messages and 20 parts. The infrastructure was fine the whole time. The model
 * had searched a 30-row SAMPLE, concluded from it, and stated the absence as
 * fact.
 *
 * ## Why the prompt is not enough
 *
 * The system prompt already forbade this in three separate paragraphs. It still
 * happened, because a prompt rule is a request, not a constraint. The checks here
 * are the constraint: they compare what the answer CLAIMS against what the tool
 * trace PROVES, and a contradiction forces another round.
 *
 * ## What is checkable, and what is not
 *
 * Only claims with a machine-checkable contradiction are handled. Everything here
 * is deliberately narrow: a false positive would make the assistant "correct" a
 * right answer, which is worse than the bug. So:
 *
 *  - a negative claim is only challenged when a census actually ran and returned
 *    matches, or when the run only ever used the SAMPLE tool;
 *  - a completeness claim is only challenged against the tool's own `isComplete`;
 *  - neither fires when the run produced no evidence at all (the model may be
 *    answering from history, or the tool may not have been reached).
 */
import type { ToolExchange } from "./engine";

/**
 * Phrases that assert ABSENCE. Arabic-first, matching how the operator writes and
 * how the assistant answered.
 *
 * `لا توجد` / `لم يتم العثور` / `غير موجود` are the recorded forms. The list
 * deliberately excludes bare `لا` and `مش` — they appear in ordinary prose and
 * would flag correct answers.
 */
const NEGATIVE_CLAIM_RE =
  /(لا\s+توجد|لا\s+يوجد|لم\s+(?:يتم\s+)?(?:العثور|إيجاد|اجد|أجد)|غير\s+موجود(?:ة)?|لا\s+شيء|لم\s+نجد|لا\s+يحتوي|بلا\s+(?:مرفقات|نتائج)|no\s+(?:results|attachments|records)\s+found|not\s+found)/i;

/**
 * Phrases that assert COMPLETENESS. These are the other half of the same bug:
 * «تم الفحص الشامل» over a partial scan.
 */
const COMPLETENESS_CLAIM_RE =
  /(تم\s+الفحص\s+(?:الشامل|الكامل)|فحص(?:ت|نا)?\s+(?:كل|جميع)\s+(?:الرسائل|الأوامر|أوامر|الملفات)|حصر\s+(?:كامل|شامل)|كل\s+الرسائل\s+(?:تم|فُحصت)|isComplete|complete\s+scan|scanned\s+all)/i;

/** Tools whose output is a SAMPLE, never a total. */
const SAMPLE_ONLY_TOOLS = new Set(["search_emails", "search_sent_emails", "search_database"]);

/** Tools whose output is a CENSUS and carries `matched` / `isComplete`. */
const CENSUS_TOOLS = new Set(["scan_emails", "scan_email_items"]);

export interface ClaimCheckInput {
  answer: string;
  exchanges: ToolExchange[];
}

export interface ClaimCheckResult {
  /**
   * A correction instruction to feed back to the model, or null when the answer
   * is consistent with the evidence.
   */
  correction: string | null;
  /** Which rule fired — logged so a bad rule is visible rather than silent. */
  rule?: "negative-vs-census" | "negative-from-sample" | "completeness";
}

/** Parse a tool result defensively — a non-JSON payload must not throw here. */
function parseToolData(content: string): Record<string, unknown> | null {
  if (!content || content.startsWith("ERROR:")) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Tool results are sometimes wrapped as text; fall through to a scan.
  }
  return null;
}

/** Read a numeric field from a tool payload, tolerating string numerals. */
function numField(data: Record<string, unknown>, key: string): number | null {
  const v = data[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

/**
 * Check the answer against the tool trace.
 *
 * Returns a correction instruction when the answer contradicts the evidence. The
 * instruction NAMES the tool and the figure, because "be more careful" is not
 * actionable — the recorded failures were all cases of the model not knowing
 * which call was authoritative.
 */
export function checkClaims(input: ClaimCheckInput): ClaimCheckResult {
  const answer = input.answer ?? "";
  const exchanges = input.exchanges ?? [];
  if (!answer.trim() || exchanges.length === 0) return { correction: null };

  const censusExchanges = exchanges.filter((e) => CENSUS_TOOLS.has(e.name));
  const sampleExchanges = exchanges.filter((e) => SAMPLE_ONLY_TOOLS.has(e.name));

  // ── Rule 1: a negative claim while a census DID match something ──────────
  if (NEGATIVE_CLAIM_RE.test(answer)) {
    for (const ex of censusExchanges) {
      const data = parseToolData(ex.content);
      if (!data) continue;
      const matched = numField(data, "matched");
      const items = numField(data, "count") ?? numField(data, "totalItems");
      const matchedSomething = (matched ?? 0) > 0 || (items ?? 0) > 0;
      if (matchedSomething) {
        const figure = matched != null ? `${matched} رسالة` : `${items} بند`;
        return {
          rule: "negative-vs-census",
          correction:
            `ردّك يقول إنه لا يوجد شيء، لكن أداة الحصر «${ex.name}» رجعت ${figure} مطابقة فعلًا. ` +
            `الرد الذي ينفي وجود بيانات موجودة خطأ فادح. أعد صياغة الرد من نتيجة الأداة نفسها: ` +
            `اذكر العدد الحقيقي وما فُحص من أصل المطابق، ولا تقل «لا يوجد» إلا إذا كان matched=0 صراحةً.`,
        };
      }
    }
  }

  // ── Rule 2: a negative claim built ONLY from a sample tool ───────────────
  if (NEGATIVE_CLAIM_RE.test(answer)) {
    const usedCensus = censusExchanges.length > 0;
    if (!usedCensus && sampleExchanges.length > 0) {
      const names = [...new Set(sampleExchanges.map((e) => e.name))].join("، ");
      return {
        rule: "negative-from-sample",
        correction:
          `ردّك ينفي وجود البيانات اعتمادًا على «${names}» وحدها، وهذه أداة عيّنة (حدّ أقصى ~30 صفًا من نافذة زمنية محدودة) ` +
          `ولا تصلح للحكم بعدم الوجود. استخدم أداة الحصر الكامل (scan_email_items للحصر داخل مرفقات البريد، ` +
          `أو scan_emails لحصر الرسائل) قبل أي حكم بعدم الوجود، واذكر ما بحثت فيه فعلًا وعدده.`,
      };
    }
  }

  // ── Rule 3: a completeness claim the tool contradicts ────────────────────
  if (COMPLETENESS_CLAIM_RE.test(answer)) {
    for (const ex of censusExchanges) {
      const data = parseToolData(ex.content);
      if (!data) continue;
      // `isComplete` is authoritative; `remainingMessages > 0` is its equivalent
      // on the item census, which reports the cursor rather than a boolean.
      const isComplete = data.isComplete;
      const remaining = numField(data, "remainingMessages");
      const incomplete = isComplete === false || (remaining != null && remaining > 0);
      if (incomplete) {
        const scope =
          remaining != null && remaining > 0
            ? `ما زال هناك ${remaining} رسالة لم تُفتح`
            : "الأداة رجعت isComplete=false";
        return {
          rule: "completeness",
          correction:
            `ردّك يقول إن الفحص شامل/كامل، لكن «${ex.name}» يقول إن الحصر لم يكتمل (${scope}). ` +
            `لا تقل «تم الفحص الشامل» إلا إذا كان isComplete=true. اذكر النطاق صريحًا: ` +
            `المطابق، والمفحوص، والمتبقي، وأكمل الحصر بنداء آخر بنفس الوسائط قبل الحكم النهائي.`,
        };
      }
    }
  }

  return { correction: null };
}

/**
 * Job-state claims: an INVENTED job number or progress percentage.
 *
 * ## The failure this exists for
 *
 * Live, a mail census was started for «MAICO EZ EX». The operator then asked
 * «إيه حالة المهمة؟» / «الي أين وصلت» repeatedly, and the assistant produced a
 * whole progress narrative — 12% … 48% … 82% … 95% … 100% — for **#213**, a job
 * id that does not exist in the database (the max id at the time was 212, and no
 * row had 213). When pressed, it blamed a failed WhatsApp delivery; then, asked
 * again, it said «لم أجد أي مهمة برقم 213» and offered to start over. Every one
 * of those progress figures was fabricated, and the operator rearranged their
 * afternoon around them.
 *
 * ## Why the existing checks missed it
 *
 * `findGroundingNumbers` deliberately challenges only MIXED alphanumeric ids
 * (letters AND digits) so ordinary money/quantities are never second-guessed. A
 * bare job number (`213`) and a bare percentage (`82%`) are exactly the shapes it
 * skips — so the two facts the operator most needed checked were the two the
 * check could not see. The catalogue also did not OFFER `job_status` on a mail
 * question, so the model had no way to read the truth even if it wanted to.
 *
 * ## Narrow, because a false positive is worse than the bug
 *
 * Only numbers in an explicit JOB context are challenged, and only percentages
 * sitting next to job vocabulary. A margin figure, a delivery percentage or a
 * year in ordinary prose is never touched.
 */
const JOB_WORD = "(?:المهم(?:ة|ات)|مهمة|الحصر|حصر|التقدم|job)";

/** `المهمة رقم 213` / `مهمة #213` / `job 213`. */
function citedJobNumbers(answer: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`${JOB_WORD}\\s*(?:رقم|#|no\\.?)?\\s*#?\\s*(\\d{1,6})`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) out.push(m[1]);
  return [...new Set(out)];
}

/** Percentages asserted ABOUT a job: `تم 82%`, `82% من الحصر`, `اكتمل بنسبة 100%`. */
function citedJobPercents(answer: string): string[] {
  const out: string[] = [];
  const patterns = [
    new RegExp(`(\\d{1,3})\\s*%[^\\n]{0,25}${JOB_WORD}`, "gi"),
    new RegExp(`${JOB_WORD}[^\\n]{0,25}?(\\d{1,3})\\s*%`, "gi"),
    new RegExp(`(?:بنسبة|نسبة)\\s*(\\d{1,3})\\s*(?:%|بالمئة|بالمائة)`, "gi"),
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(answer)) !== null) out.push(m[1]);
  }
  return [...new Set(out)];
}

const JOB_TOOLS = new Set(["job_status", "start_census_job", "cancel_job", "resend_job_report"]);

export interface JobClaimResult {
  correction: string | null;
  rule?: "job-id-not-found" | "job-progress-without-status" | "job-progress-mismatch";
}

/**
 * Challenge a job number or progress percentage that no tool result supports.
 *
 * Grounded ids/percents are read from the job tools' own payloads, so a number
 * the assistant legitimately relayed from `start_census_job` or `job_status` is
 * never challenged.
 */
export function checkJobClaims(answer: string, exchanges: ToolExchange[]): JobClaimResult {
  if (!answer?.trim()) return { correction: null };
  const jobExchanges = (exchanges ?? []).filter((e) => JOB_TOOLS.has(e.name));
  const ranJobTool = jobExchanges.length > 0;

  const groundedIds = new Set<string>();
  const groundedPercents = new Set<string>();
  const notFoundIds = new Set<string>();
  for (const ex of jobExchanges) {
    const data = parseToolData(ex.content);
    if (!data) continue;
    const addId = (v: unknown) => {
      if (typeof v === "number") groundedIds.add(String(v));
      else if (typeof v === "string" && /^\d+$/.test(v)) groundedIds.add(v);
    };
    addId(data.id);
    addId(data.jobId);
    addId(data.askedId);
    const jobs = Array.isArray(data.jobs) ? (data.jobs as Record<string, unknown>[]) : [];
    for (const j of jobs) {
      addId(j.id);
      const p = j.progress as Record<string, unknown> | undefined;
      if (p && p.percent != null) groundedPercents.add(String(p.percent));
    }
    const prog = data.progress as Record<string, unknown> | undefined;
    if (prog && prog.percent != null) groundedPercents.add(String(prog.percent));
    // An explicit "not found" verdict for a named id is itself evidence.
    if (data.found === false && data.askedId != null) notFoundIds.add(String(data.askedId));
  }

  const citedIds = citedJobNumbers(answer);
  const badId = citedIds.find((id) => notFoundIds.has(id) || !groundedIds.has(id));
  if (badId) {
    // Report the truth from the trace when we have it, so the correction is
    // actionable rather than just "be careful".
    const known = [...groundedIds].slice(0, 6).join("، ");
    return {
      rule: "job-id-not-found",
      correction:
        `ردّك يذكر المهمة رقم ${badId}، ولم تُرجِع أي أداة مهام هذا الرقم` +
        (known ? ` (الأرقام الفعلية: ${known})` : "") +
        `. لا تخترع رقم مهمة ولا حالة ولا نسبة تقدم لمهمة غير موجودة. ` +
        `إن سأل المستخدم عن مهمة بهذا الرقم فقل صراحةً إنه غير موجود، واذكر أرقام المهام الحقيقية فقط من نتيجة job_status.`,
    };
  }

  const citedPercents = citedJobPercents(answer);
  if (citedPercents.length) {
    if (!ranJobTool) {
      return {
        rule: "job-progress-without-status",
        correction:
          `ردّك يذكر نسبة تقدم لحصر/مهمة (${citedPercents.join("%، ")}%)، لكنك لم تقرأ حالة أي مهمة في هذه الجولة. ` +
          `لا تُعلن أي نسبة تقدم أو اكتمال دون قراءتها من job_status فعلًا. ` +
          `إن لم تكن قرأتها، اذكر أنك لا تعرف النسبة بدلًا من تقديرها.`,
      };
    }
    const bad = citedPercents.find((p) => !groundedPercents.has(String(Number(p))));
    if (bad) {
      const knownPct = [...groundedPercents].slice(0, 5).join("، ");
      return {
        rule: "job-progress-mismatch",
        correction:
          `ردّك يذكر نسبة تقدم ${bad}%، لكن الأدوات لم تُرجِع هذه النسبة` +
          (knownPct ? ` (النِسب الفعلية: ${knownPct}%)` : "") +
          `. اذكر النسبة التي رجعتها job_status كما هي، ولا تقدّر نسبة من عندك.`,
      };
    }
  }

  return { correction: null };
}

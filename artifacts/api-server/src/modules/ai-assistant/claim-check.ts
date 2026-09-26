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
import type { ToolExchange } from "./mastra-agent";

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

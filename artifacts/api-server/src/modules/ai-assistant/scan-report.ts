/**
 * AI Assistant — the ONE scan report.
 *
 * Every census (an interactive `scan_email_items`, an automatic oversize
 * hand-off, or a background `start_census_job`) has to answer the same ten
 * questions about what it actually did, and the operator asks them in the same
 * words every time: what was searched, how many messages matched, how many were
 * examined, how many PDFs were opened, how many rows came out, how long it took,
 * how much is left, is it complete, and — if not — why it stopped.
 *
 * Those figures existed but were scattered: the job's `progress` carried five of
 * them, the final artifact carried a different five, and the interactive tool
 * phrased its own scope line a third way. Each site was free to omit a count or
 * invent a reason, which is how «النطاق: كل الرسائل المطابقة (0)» was emitted for
 * a scan that had examined nothing, and how a reply stated «الحد 400» when the
 * real ceiling was the time budget.
 *
 * So they are computed ONCE, here, from the run's own counters — never from the
 * model's prose and never from a fresh estimate. `percent` and `complete` are
 * derived from the same evidence as every other field, with two invariants that
 * must not be relaxed:
 *
 *  1. `percent` is 100 ONLY when the scan really reached the end of everything it
 *     was asked to cover. A sample can never be reported as a total.
 *  2. `complete` is true only when envelopes were actually EXAMINED. A scan that
 *     walked nothing has proven nothing, whatever the cursor says.
 */

/** Why a scan stopped short of the end. `complete` is its own value. */
export type ScanStopReason =
  | "complete"
  /** Ran out of the time it was given. */
  | "time"
  /** Hit the message-count ceiling. */
  | "count"
  /** Some messages could not be fetched. */
  | "error"
  /** Examined the mailbox and the search term matched no message. */
  | "no-match"
  /** Matched messages exist, but no readable document was found in them. */
  | "no-readable-files"
  /** Messages were opened but some documents could not be read. */
  | "unreadable"
  /** The operator called the job off. */
  | "cancelled";

export interface ScanReportInput {
  /** What the scan was asked to find — sender, subject, part, mailbox. */
  query: string;
  /** Envelopes matched by the search filter. */
  matched: number;
  /** Envelopes the source actually examined (the proof the mailbox was read). */
  examined: number;
  /** Matched envelopes whose attachments were opened, i.e. cursor progress. */
  opened: number;
  /** PDF attachments opened. */
  pdfs: number;
  /** Item rows extracted. */
  results: number;
  /** PDF pages rendered — evidence of real processing. */
  pages?: number;
  /** Matched envelopes not yet opened. */
  remaining: number;
  /** Did the cursor reach the end of the matched list? */
  reachedEnd: boolean;
  /** The source's own reason for stopping short, when it gave one. */
  truncatedReason?: "time" | "count" | "error" | null;
  /** Documents that could not be read. */
  unreadable?: number;
  /** When the work began (epoch ms). */
  startedAt: number;
  /** Now (epoch ms) — passed in so the calculation stays pure and testable. */
  now: number;
  /** The run's deadline (epoch ms), when there is one. */
  deadline?: number | null;
  /** The operator cancelled the job. */
  cancelled?: boolean;
  /** Human description of the requested scope (mailbox / date range). */
  scopeLabel?: string;
}

export interface ScanReport {
  query: string;
  matched: number;
  examined: number;
  opened: number;
  pdfs: number;
  results: number;
  pages: number;
  elapsedMs: number;
  remainingMs: number | null;
  remaining: number;
  complete: boolean;
  stopReason: ScanStopReason;
  /** Documents that could not be read — named in the stop reason. */
  unreadableDocs: number;
  /** 0–100, and 100 ONLY when `complete` is true. */
  percent: number;
  scopeLabel?: string;
}

/** Whole seconds, floored — the operator reads these as a duration, not a float. */
function toSeconds(ms: number): number {
  return Math.max(0, Math.floor(ms / 1000));
}

/**
 * Decide why the scan stopped, from the counters — never from a caller's guess.
 *
 * Ordered so the most specific fact wins: a cancellation is not a timeout, and a
 * search term that matched nothing is not an unreadable mailbox.
 */
export function deriveStopReason(input: ScanReportInput, complete: boolean): ScanStopReason {
  if (input.cancelled) return "cancelled";
  if (complete) return "complete";
  if (input.matched === 0 && input.pdfs === 0) {
    // `examined > 0` is the difference between "the term matched nothing" and
    // "the mailbox was never read at all" — two opposite diagnoses that used to
    // be reported as the same connection failure.
    return input.examined > 0 ? "no-match" : "error";
  }
  if (input.matched > 0 && input.pdfs === 0) return "no-readable-files";
  if ((input.unreadable ?? 0) > 0 && input.reachedEnd) return "unreadable";
  if (input.truncatedReason === "error") return "error";
  if (input.truncatedReason === "count") return "count";
  return "time";
}

/**
 * Build the report. Everything is derived from the run's counters; the only
 * arithmetic is a percentage that is deliberately withheld at the top end.
 */
export function buildScanReport(input: ScanReportInput): ScanReport {
  const examined = input.examined;
  const matched = Math.max(0, input.matched);
  const opened = Math.max(0, input.opened);
  const unreadable = input.unreadable ?? 0;
  const pdfs = Math.max(0, input.pdfs);

  // Nothing matched but the mailbox WAS read: the SEARCH is complete, there is
  // simply nothing in it. Nothing matched and nothing was read: the scan never
  // started, so it cannot be complete.
  const nothingToOpen = matched === 0;
  const complete = input.cancelled
    ? false
    : nothingToOpen
      ? input.reachedEnd && examined > 0
      : input.reachedEnd && opened >= matched && unreadable === 0 && pdfs > 0;

  const stopReason = deriveStopReason(input, complete);

  // 100% means "covered everything asked for". It is the single most abusable
  // number in the report, so it is gated on `complete` and nothing else — an
  // empty ask stays at 0 rather than reading as a finished census.
  const percent =
    complete && matched > 0
      ? 100
      : matched > 0
        ? Math.min(99, Math.floor((opened / matched) * 100))
        : 0;

  const elapsedMs = Math.max(0, input.now - input.startedAt);
  const remainingMs =
    typeof input.deadline === "number" ? Math.max(0, input.deadline - input.now) : null;

  return {
    query: input.query,
    matched,
    examined,
    opened,
    pdfs,
    results: Math.max(0, input.results),
    pages: Math.max(0, input.pages ?? 0),
    elapsedMs,
    remainingMs,
    remaining: Math.max(0, input.remaining),
    complete,
    stopReason,
    unreadableDocs: unreadable,
    percent,
    scopeLabel: input.scopeLabel,
  };
}

/** Arabic one-line reason for a stop — the operator's ninth question. */
export function describeStopReason(report: ScanReport): string {
  switch (report.stopReason) {
    case "complete":
      // A completed census that matched NOTHING must say what it examined; a
      // bare «اكتمل الحصر» over zero results reads as «لا يوجد أي بريد», which is
      // a stronger claim than the run supports.
      return report.matched === 0
        ? `فُحص ${report.examined} رسالة ولم يطابق أي منها شرط البحث`
        : "اكتمل الحصر على كل النطاق المطلوب";
    case "time":
      return "انتهت ميزانية الوقت المخصصة للمسح";
    case "count":
      return "بلغ حد عدد الرسائل المسموح في المسح الواحد";
    case "error":
      return report.examined === 0
        ? "لم تُقرأ أي رسالة — تعذّر الوصول إلى صندوق البريد"
        : "تعذّر جلب بعض الرسائل";
    case "no-match":
      return `فُحص ${report.examined} رسالة ولم يطابق أي منها شرط البحث`;
    case "no-readable-files":
      return "طابقت رسائل لكن لم يُعثر داخلها على ملف قابل للقراءة";
    case "unreadable":
      return `تعذّرت قراءة ${report.unreadableDocs} مستندًا`;
    case "cancelled":
      return "أُلغي الحصر بناءً على طلبك";
  }
}

/**
 * The report as the operator reads it: a fixed order, every field labelled, and
 * every unknown spelled «غير متوفر» rather than left blank.
 *
 * `unreadableDocs` is carried on the report so the reason line can be exact.
 */
export function renderScanReport(report: ScanReport): string {
  const lines: string[] = [];
  if (report.scopeLabel) lines.push(`النطاق المطلوب: ${report.scopeLabel}`);
  lines.push(`البحث عن: ${report.query?.trim() || "غير محدد"}`);
  lines.push(`رسائل مطابقة: ${report.matched}`);
  lines.push(`رسائل فُحصت: ${report.examined}`);
  lines.push(`رسائل فُتحت: ${report.opened}`);
  lines.push(`ملفات PDF فُتحت: ${report.pdfs}`);
  lines.push(`صفحات قُرئت: ${report.pages}`);
  lines.push(`نتائج استُخرجت: ${report.results}`);
  lines.push(`الوقت المستغرق: ${toSeconds(report.elapsedMs)} ثانية`);
  lines.push(
    report.remainingMs != null
      ? `الوقت المتبقي: ${toSeconds(report.remainingMs)} ثانية`
      : "الوقت المتبقي: غير متوفر",
  );
  lines.push(
    report.complete
      ? "الحالة: مكتمل ✅"
      : `الحالة: جزئي ⚠️ (بقي ${report.remaining} رسالة — ${report.percent}%)`,
  );
  lines.push(`سبب التوقف: ${describeStopReason(report)}`);
  return lines.join("\n");
}

/**
 * The same report flattened for the job's `progress` column.
 *
 * Keeps the legacy keys (`scanned`, `items`, `percent`, …) so existing readers
 * and rows keep working, and adds the ones that were missing — the two durations
 * and the stop reason. A future field is added HERE, never at a call site, so the
 * next census cannot omit it the way `pages` was omitted.
 */
export function scanReportProgress(report: ScanReport): Record<string, unknown> {
  return {
    // legacy keys (kept: rows already in the DB and the dashboard read them)
    scanned: report.examined,
    matched: report.matched,
    attachments: report.pdfs,
    items: report.results,
    pages: report.pages,
    percent: report.percent,
    // the fields the operator asks for that were missing before
    opened: report.opened,
    examined: report.examined,
    pdfs: report.pdfs,
    results: report.results,
    elapsedSeconds: toSeconds(report.elapsedMs),
    remainingSeconds: report.remainingMs != null ? toSeconds(report.remainingMs) : null,
    remaining: report.remaining,
    complete: report.complete,
    stopReason: report.stopReason,
    stopReasonLabel: describeStopReason(report),
    query: report.query,
  };
}

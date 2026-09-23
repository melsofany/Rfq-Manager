/**
 * AI Assistant — evidence envelope.
 *
 * Every business tool returns this shape instead of a bare array. The point is
 * traceability: a figure the assistant prints must be attributable to a source,
 * a filter, and a completeness state. Prompt rules alone did not prevent the
 * assistant presenting a capped sample as a total (the 3,710-message census
 * reported as "10") or a computed margin as fact without showing its inputs —
 * so the envelope carries that information IN the tool result, where the model
 * must read it before it can answer.
 *
 * Consumers rely on four fields above all:
 *  - `data`      the rows/aggregate, always structured
 *  - `source`    where it came from ("database", "email", …)
 *  - `isComplete` whether the result covers EVERYTHING (`false` ⇒ a sample)
 *  - `confidence` VERIFIED | PARTIALLY_VERIFIED | INSUFFICIENT_EVIDENCE
 */

export type Confidence = "VERIFIED" | "PARTIALLY_VERIFIED" | "INSUFFICIENT_EVIDENCE";

export interface EvidenceEnvelope<T = unknown> {
  /** The result payload — rows, aggregate, or a scalar wrapped in an object. */
  data: T;
  /** Where the data came from, for the operator-facing citation line. */
  source: string;
  /** The filters that produced this result (echoed so it can be cited). */
  filters: Record<string, unknown>;
  /** Number of records the result is based on. */
  recordCount: number;
  /** True only when the result covers the WHOLE requested scope. */
  isComplete: boolean;
  /** Anything the operator must know: capping, unreadable files, ambiguity. */
  warnings: string[];
  /** Confidence in the result, derived from completeness + warnings. */
  confidence: Confidence;
  /** How the figures were computed (a one-line, citable explanation). */
  method?: string;
  /** Per-figure provenance, when the data is a computed aggregate. */
  evidence?: Array<Record<string, unknown>>;
}

/**
 * Build an envelope, deriving `confidence` from completeness and warnings.
 *
 * The derivation is deliberately conservative and lives in ONE place: a result
 * with any warning can never be VERIFIED, and a result known to be incomplete
 * degrades to PARTIALLY_VERIFIED even with no warning text. That rule is what
 * stops "I analysed everything" being asserted about a partial scan.
 */
export function evidence<T>(opts: {
  data: T;
  source: string;
  filters?: Record<string, unknown>;
  recordCount?: number;
  isComplete?: boolean;
  warnings?: string[];
  method?: string;
  evidence?: Array<Record<string, unknown>>;
}): EvidenceEnvelope<T> {
  const warnings = opts.warnings ?? [];
  const isComplete = opts.isComplete ?? true;
  const recordCount =
    opts.recordCount ?? (Array.isArray(opts.data) ? (opts.data as unknown[]).length : 0);

  let confidence: Confidence;
  if (!isComplete) {
    // Incomplete by definition cannot be VERIFIED, regardless of warnings.
    confidence = recordCount > 0 ? "PARTIALLY_VERIFIED" : "INSUFFICIENT_EVIDENCE";
  } else if (warnings.length > 0) {
    confidence = "PARTIALLY_VERIFIED";
  } else if (recordCount > 0) {
    confidence = "VERIFIED";
  } else {
    // Complete but empty: nothing was found — that is a verified absence.
    confidence = "VERIFIED";
  }

  return {
    data: opts.data,
    source: opts.source,
    filters: opts.filters ?? {},
    recordCount,
    isComplete,
    warnings,
    confidence,
    method: opts.method,
    evidence: opts.evidence,
  };
}

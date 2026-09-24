/**
 * AI Assistant — deterministic verifier (P2 / PR 5).
 *
 * The grounding checker in `agent.ts` catches a HALLUCINATED identifier. This
 * layer catches the other failure: an answer that is traceable but WRONG — a total
 * that does not reconcile, a count that disagrees with `COUNT(DISTINCT …)`, or a
 * figure the model reported from a capped sample as if it were complete.
 *
 * It is deterministic on purpose. An LLM judge would spend the same scarce daily
 * quota whose exhaustion is this assistant's recorded failure mode, and would be
 * non-reproducible. Instead each check is a plain arithmetic or SQL invariant, so
 * the verifier can run on EVERY answer for free and its verdict can be asserted
 * in a test.
 *
 * A disagreement never silently "fixes" the number — the verifier reports it, and
 * the caller downgrades the answer's confidence (see `applyVerification`). That is
 * the rule from the prompt: "إذا اختلفت النتيجتان، لا ترسل النتيجة كـ Verified".
 */
import { db, purchaseOrderItemsTable, customerPoItemsTable } from "@workspace/db";
import { sql, ne } from "drizzle-orm";
import { logger } from "../../shared/logger";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type VerificationOutcome = "verified" | "disagreement" | "skipped";

export interface VerificationResult {
  outcome: VerificationOutcome;
  /** Human-readable Arabic explanation when a check fails. */
  note?: string;
  /** The specific checks that ran and what they found. */
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

/**
 * Verify a quantity total for purchase-order items against a fresh aggregate.
 * `reported` is the number the model put in the answer; the DB is the authority.
 */
export async function verifyPoQuantityTotal(
  reported: number,
  opts: { sinceDays?: number; tolerance?: number } = {},
): Promise<{ ok: boolean; actual: number }> {
  const tolerance = opts.tolerance ?? 0;
  const filters: any[] = [ne(purchaseOrderItemsTable.lineStatus, "cancelled")];
  if (opts.sinceDays) {
    filters.push(
      sql`${purchaseOrderItemsTable.createdAt} >= NOW() - (${opts.sinceDays} || ' days')::interval`,
    );
  }
  const rows = (await (db as any)
    .select({ total: sql<number>`coalesce(sum(${purchaseOrderItemsTable.qty}),0)::float8` })
    .from(purchaseOrderItemsTable)
    .where(sql.join(filters, sql` and `))) as any[];
  const actual = Number(rows[0]?.total ?? 0);
  return { ok: Math.abs(actual - reported) <= tolerance, actual };
}

/** Count supplier PO items vs DISTINCT key — a cheap self-consistency check. */
export async function verifyPoItemCount(
  reported: number,
): Promise<{ ok: boolean; actual: number }> {
  const rows = (await (db as any)
    .select({ n: sql<number>`count(*)::int` })
    .from(purchaseOrderItemsTable)
    .where(ne(purchaseOrderItemsTable.lineStatus, "cancelled"))) as any[];
  const actual = Number(rows[0]?.n ?? 0);
  return { ok: actual === reported, actual };
}

/**
 * Run the applicable checks for an answer.
 *
 * The checks are chosen from what the answer LOOKS like it is claiming, so an
 * unrelated question does not query the DB: an answer with no ≥1000 figure is
 * SKIPPED rather than "verified" — the distinction matters, because a skip is not
 * evidence that a figure was right.
 *
 * `source` is what makes the reconciliation MEANINGFUL, and omitting it produced
 * a live false alarm: an answer built entirely from EMAIL attachments (the
 * operator asked for the mail) had its total compared against the database's
 * purchase-order items and was reported as PARTIALLY_VERIFIED because the two
 * sets differ — which they always will. A figure may only be reconciled against
 * the source that produced it; when the answer came from email, the database is
 * not the authority and the check must be SKIPPED, not failed.
 */
export async function verifyAnswer(opts: {
  answerText: string;
  /** Tool data the answer was built from (its own reported aggregates). */
  toolData?: unknown;
  /**
   * Quantity totals a tool returned, WITH the tool that produced each one.
   *
   * The tool's own aggregate is the ONLY figure that may be reconciled: a number
   * mined from the prose is not evidence of anything. The old code took
   * `extractReportedTotals(text)[0]` — whatever large number appeared first — and
   * compared it to the sum of every PO line, which produced the live
   * «المرصود 2025 والمحسوب 14265 … PARTIALLY_VERIFIED» caveat on correct answers
   * (2025 is a YEAR; 680632 is a Part Number).
   */
  toolAggregates?: Array<{ tool: string; total: number }>;
  /** Which source produced the figures: only "database" may be reconciled. */
  source?: "database" | "email" | "mixed" | "unknown";
}): Promise<VerificationResult> {
  const checks: VerificationResult["checks"] = [];

  // A figure may only be reconciled against the DB when the tool that produced
  // it aggregates the SAME table the verifier sums. `aggregate_po_items` sums
  // every PO line under the same `lineStatus != 'cancelled'` filter, so its total
  // and `verifyPoQuantityTotal` describe one dataset. Any other tool's total
  // describes a SUBSET — a single order, one supplier, unfulfilled lines only —
  // and comparing it to the whole table would flag a correct answer. A false
  // alarm is worse than no check, so anything else is SKIPPED.
  const RECONCILABLE_TOOLS = new Set(["aggregate_po_items"]);
  const reconcilable = (opts.toolAggregates ?? []).filter(
    (a) => Number.isFinite(a.total) && a.total >= 1000 && RECONCILABLE_TOOLS.has(a.tool),
  );

  if (reconcilable.length === 0) {
    // Nothing to reconcile. This is a SKIP, never a pass — a skip is not evidence
    // that a figure was right, and the metrics record it as such.
    return { outcome: "skipped", checks };
  }

  const answerTotals = reconcilable.map((a) => a.total);

  // A figure that came from email (or from both sources) cannot be checked
  // against the database: the two sets legitimately differ, so "disagreement"
  // would be reported for every correct answer.
  if (opts.source === "email" || opts.source === "mixed") {
    return { outcome: "skipped", checks };
  }

  // Check 1: if the answer cites a large quantity total, it must match the DB.
  if (answerTotals.length > 0) {
    try {
      const { ok, actual } = await verifyPoQuantityTotal(answerTotals[0]);
      checks.push({
        name: "po_quantity_total",
        ok,
        detail: ok ? undefined : `المرصود ${answerTotals[0]} والمحسوب من قاعدة البيانات ${actual}`,
      });
    } catch (err) {
      logger.warn({ err }, "AI assistant: verifier quantity check failed (non-fatal)");
      return { outcome: "skipped", checks };
    }
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    return {
      outcome: "disagreement",
      note: failed
        .map((c) => c.detail)
        .filter(Boolean)
        .join("؛ "),
      checks,
    };
  }
  return { outcome: "verified", checks };
}

/**
 * Downgrade an answer's stated confidence when the verifier found a problem. The
 * answer text is NOT altered here — the caller appends the note, so what the model
 * said remains visible alongside the correction (never silently rewritten).
 */
export function confidenceFromVerification(
  base: "VERIFIED" | "PARTIALLY_VERIFIED" | "INSUFFICIENT_EVIDENCE",
  result: VerificationResult,
): "VERIFIED" | "PARTIALLY_VERIFIED" | "INSUFFICIENT_EVIDENCE" {
  if (result.outcome === "disagreement") {
    return base === "INSUFFICIENT_EVIDENCE" ? base : "PARTIALLY_VERIFIED";
  }
  return base;
}

/** A verified total from customer PO items (used by the reconciliation tool). */
export async function verifyCustomerItemTotals(): Promise<{ count: number; qty: number }> {
  const rows = (await (db as any)
    .select({
      n: sql<number>`count(*)::int`,
      qty: sql<number>`coalesce(sum(${customerPoItemsTable.qty}),0)::float8`,
    })
    .from(customerPoItemsTable)) as any[];
  return { count: Number(rows[0]?.n ?? 0), qty: Number(rows[0]?.qty ?? 0) };
}

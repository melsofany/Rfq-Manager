/**
 * Accounts Module — قواعد العرض المحاسبي (reporting conventions)
 *
 * Every financial statement in this module is derived from the journal lines
 * using one rule: an account's balance is expressed as a signed amount in its
 * OWN normal direction, never as a raw debit-minus-credit figure.
 *
 * This matters for two reasons:
 *
 *  1. Contra accounts. مردود المبيعات (4101) is typed `revenue` but carries a
 *     debit balance; خصم مشتريات (5110) is typed `expense` but carries a credit
 *     balance. Taking Math.abs() of a raw balance makes both INCREASE their
 *     section instead of reducing it. Signing by the account type fixes them
 *     without any special-casing.
 *
 *  2. Balance-sheet balancing. Assets = Liabilities + Equity only holds once
 *     the period result (revenue − expenses) is folded into equity, because
 *     revenue/expense accounts are not closed to retained earnings until
 *     year-end. `currentPeriodResult()` supplies that figure.
 */
import { round2 } from "./tax";

/** Account types recognised by the chart of accounts. */
export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

/**
 * The side on which an account's balance naturally increases.
 * Assets and expenses are debit-natured; liabilities, equity and revenue are
 * credit-natured. (Contra accounts are NOT special-cased — their opposite
 * balance simply comes out negative in their own normal direction.)
 */
export function normalSide(type: string): "debit" | "credit" {
  return type === "asset" || type === "expense" ? "debit" : "credit";
}

/**
 * Express a raw (debit − credit) balance as a signed amount in the account's
 * normal direction:
 *   • debit-natured account  → debit − credit   (positive when it has a balance)
 *   • credit-natured account → credit − debit   (positive when it has a balance)
 *
 * A contra account therefore comes out negative, which is exactly what the
 * statements need in order to net it against its section.
 */
export function signedBalance(type: string, debit: number, credit: number): number {
  return round2(normalSide(type) === "debit" ? debit - credit : credit - debit);
}

/** Signed balance of an account that already has a raw balance figure. */
export function signedFromRaw(type: string, rawBalance: number): number {
  return round2(normalSide(type) === "debit" ? rawBalance : -rawBalance);
}

/**
 * Revenue − expenses over a period, i.e. the result that has not yet been
 * transferred to retained earnings. Positive = profit (يُضاف إلى حقوق الملكية),
 * negative = loss (يُخصم منها).
 */
export function currentPeriodResult(totalRevenue: number, totalExpense: number): number {
  return round2(totalRevenue - totalExpense);
}

// ───────────────────────────────────────────────────────────────────────────
// أعمار الديون — Receivable / payable ageing
//
// A trading company lives or dies by its collection cycle: money owed by
// customers (ذمم مدينة) and money owed to suppliers (ذمم دائنة) is bucketed by
// how far past its due date it is, so the accountant can chase the oldest
// first. Buckets follow the conventional 0/30/60/90/90+ split.
// ───────────────────────────────────────────────────────────────────────────
export const AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  current: "غير مستحق",
  d1_30: "1–30 يوم",
  d31_60: "31–60 يوم",
  d61_90: "61–90 يوم",
  d90_plus: "أكثر من 90 يوم",
};

/** Whole days between two YYYY-MM-DD dates (b − a). */
export function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const dbb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(dbb)) return 0;
  return Math.floor((dbb - da) / 86_400_000);
}

/**
 * Bucket an outstanding balance by its overdue age.
 * `dueDate` null/blank means the debt is not yet scheduled → "current".
 */
export function agingBucket(dueDate: string | null | undefined, asOf: string): AgingBucket {
  if (!dueDate) return "current";
  const overdue = daysBetween(dueDate, asOf);
  if (overdue <= 0) return "current";
  if (overdue <= 30) return "d1_30";
  if (overdue <= 60) return "d31_60";
  if (overdue <= 90) return "d61_90";
  return "d90_plus";
}

/** An empty bucket→amount map, all zero. */
export function emptyBuckets(): Record<AgingBucket, number> {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
}

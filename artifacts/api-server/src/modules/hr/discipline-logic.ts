/** Pure rules for disciplinary cases and pay adjustments. */

export const CASE_STATUSES = ["open", "investigation", "decided", "closed"] as const;
export const PENALTY_TYPES = ["warning", "fine", "suspension", "dismissal"] as const;
export const ADJUSTMENT_KINDS = ["bonus", "incentive", "deduction"] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];
export type PenaltyType = (typeof PENALTY_TYPES)[number];

/** Allowed status transitions. A decided case can only be closed. */
const NEXT: Record<CaseStatus, CaseStatus[]> = {
  open: ["investigation", "decided", "closed"],
  investigation: ["decided", "closed"],
  decided: ["closed"],
  closed: [],
};

export function canTransition(from: string, to: string): boolean {
  if (!(CASE_STATUSES as readonly string[]).includes(from)) return false;
  return NEXT[from as CaseStatus].includes(to as CaseStatus);
}

/** Period must be YYYY-MM with a real month. */
export function isValidPeriod(p: unknown): p is string {
  return typeof p === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(p);
}

/** Amount as a non-negative decimal with at most 2 places. */
export function parseMoney(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  if (Math.round(n * 100) !== n * 100) return null;
  return n;
}

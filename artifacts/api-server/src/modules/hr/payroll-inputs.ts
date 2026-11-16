/**
 * Payroll inputs — مدخلات المسير (خصومات/مكافآت/جزاءات) لشهر معيّن.
 *
 * The draft run reads these once, and approval must read the SAME ones. A second
 * copy of the query is how a fine or a deduction added after the draft was
 * calculated gets silently ignored — the draft looks settled while the money
 * never moves.
 *
 * All figures are read from the period's rows so a change is detectable: the
 * caller compares the stored payslip against a fresh read.
 */
import { db, hrPayAdjustmentsTable, hrDisciplinaryCasesTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { round2 } from "./payroll-logic";

export interface PeriodAdjustment {
  employeeId: number;
  kind: string;
  amount: number;
  days: number;
}

/** Every pay adjustment (bonus / incentive / deduction) recorded for the period. */
export async function loadPeriodAdjustments(
  period: string,
  employeeIds: number[],
): Promise<PeriodAdjustment[]> {
  if (!employeeIds.length) return [];
  const rows = await db
    .select()
    .from(hrPayAdjustmentsTable)
    .where(
      and(
        eq(hrPayAdjustmentsTable.period, period),
        inArray(hrPayAdjustmentsTable.employeeId, employeeIds),
      ),
    );
  return rows.map((a) => ({
    employeeId: a.employeeId,
    kind: a.kind,
    amount: Number(a.amount ?? 0),
    days: a.days === null ? 0 : Number(a.days),
  }));
}

/**
 * Decided fines for the period, per employee. A fine counts in the month it was
 * DECIDED (matching the payslip rule), so a case decided after the draft was
 * calculated is visible here and the draft is correctly reported as stale.
 */
export async function loadPeriodFines(
  period: string,
  employeeIds: number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!employeeIds.length) return out;
  const rows = await db
    .select()
    .from(hrDisciplinaryCasesTable)
    .where(
      and(
        inArray(hrDisciplinaryCasesTable.employeeId, employeeIds),
        eq(hrDisciplinaryCasesTable.penaltyType, "fine"),
      ),
    );
  for (const k of rows) {
    if (!k.decidedAt) continue;
    if (new Date(k.decidedAt).toISOString().slice(0, 7) !== period) continue;
    out.set(k.employeeId, round2((out.get(k.employeeId) ?? 0) + Number(k.penaltyAmount ?? 0)));
  }
  return out;
}

export interface PayslipAdjustmentFields {
  bonuses: number;
  deductions: number;
  finesApplied: number;
}

/**
 * Which of the stored payslip's ADJUSTMENT figures no longer match the period's
 * records. A deduction or a fine added to the Discipline & rewards tab AFTER the
 * draft was calculated must not be approved silently — the operator would see
 * money "not counted" because the slip still holds the pre-change numbers.
 *
 * The expected values use the exact rules the draft run uses (day-based
 * adjustments at this month's daily rate, fines capped at monthlyCapDays).
 */
export function staleAdjustmentFields(
  slip: PayslipAdjustmentFields,
  adjustments: PeriodAdjustment[],
  finesTotal: number,
  dailyRate: number,
  finesCapDays: number | null,
): string[] {
  const sumKind = (kind: string) =>
    adjustments.filter((a) => a.kind === kind).reduce((acc, a) => acc + a.amount, 0);
  const daysOf = (kind: string) =>
    adjustments.filter((a) => a.kind === kind && a.days > 0).reduce((acc, a) => acc + a.days, 0);
  const expectedBonuses = round2(sumKind("bonus") + round2(daysOf("bonus") * dailyRate));
  const expectedDeductions = round2(sumKind("deduction") + round2(daysOf("deduction") * dailyRate));
  const finesCap = finesCapDays === null ? finesTotal : round2(finesCapDays * dailyRate);
  const expectedFines = round2(Math.min(finesTotal, finesCap));
  const out: string[] = [];
  if (round2(slip.bonuses) !== expectedBonuses) out.push("bonuses");
  if (round2(slip.deductions) !== expectedDeductions) out.push("deductions");
  if (round2(slip.finesApplied) !== expectedFines) out.push("fines");
  return out;
}

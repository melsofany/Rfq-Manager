/**
 * Final settlement (تسوية نهاية الخدمة) — pure math.
 *
 * Rules come from Settings (end_of_service, absence) and are not assumed here:
 *  - Wage basis = basic + allowances (monthly).
 *  - End-of-service = days of wage per year for the first N years, then months of wage per year after,
 *    multiplied by the eligibility percentage entered for the exit reason (100 = full).
 *  - Final salary = days worked in the exit month ÷ daily divisor × monthly wage (capped at one month).
 *  - Unused annual leave = remaining balance × daily rate (basic ÷ daily divisor).
 *  - Insurance and income tax are NOT applied to the settlement here; the accountant decides that.
 */
import { round2 } from "./payroll-logic";

export interface EndOfServiceRule {
  firstYearsDays: number;
  firstYearsLimit: number;
  laterMonthsPerYear: number;
  /** Share of the entitlement (0–100) for each exit reason, set by HR in Settings. */
  eligibilityByReason: Record<ExitReason, number>;
}

export type ExitReason = "resignation" | "termination" | "end_of_contract";
export const EXIT_REASONS: readonly ExitReason[] = [
  "resignation",
  "termination",
  "end_of_contract",
];

const DAY_MS = 86400000;
const toUtc = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);

/** Service length in years (days ÷ 365), never negative. */
export function serviceYears(hireYmd: string, exitYmd: string): number {
  const days = Math.round((toUtc(exitYmd) - toUtc(hireYmd)) / DAY_MS);
  return Math.max(0, days) / 365;
}

export function endOfServiceAmount(
  wage: number,
  years: number,
  rule: EndOfServiceRule,
  eligibilityPct: number,
): number {
  const first = Math.min(years, rule.firstYearsLimit);
  const later = Math.max(0, years - rule.firstYearsLimit);
  const full = wage * (rule.firstYearsDays / 30) * first + wage * rule.laterMonthsPerYear * later;
  return round2((full * eligibilityPct) / 100);
}

/** Pay for days worked in the exit month, capped at one full month. */
export function finalSalaryAmount(monthlyWage: number, exitYmd: string, divisor: number): number {
  const dayOfMonth = Number(exitYmd.slice(8, 10));
  return round2((Math.min(dayOfMonth, divisor) / divisor) * monthlyWage);
}

export interface SettlementInput {
  hireDate: string;
  exitDate: string;
  reason: ExitReason;
  basic: number;
  allowances: number;
  divisor: number;
  rule: EndOfServiceRule;
  eligibilityPct: number;
  unusedLeaveDays: number;
  deductions: number;
  /** True when the exit month's payroll already paid this employee's days — final salary is then not added again. */
  finalSalaryPaid?: boolean;
}

export interface SettlementResult {
  years: number;
  monthlyWage: number;
  dailyRate: number;
  finalSalary: number;
  endOfService: number;
  unusedLeaveDays: number;
  leavePayout: number;
  deductions: number;
  total: number;
}

export function computeSettlement(i: SettlementInput): SettlementResult {
  const monthlyWage = round2(i.basic + i.allowances);
  const dailyRate = round2(i.basic / i.divisor);
  const years = serviceYears(i.hireDate, i.exitDate);
  const finalSalary = i.finalSalaryPaid ? 0 : finalSalaryAmount(monthlyWage, i.exitDate, i.divisor);
  const endOfService = endOfServiceAmount(monthlyWage, years, i.rule, i.eligibilityPct);
  const leavePayout = round2(i.unusedLeaveDays * dailyRate);
  const total = round2(finalSalary + endOfService + leavePayout - i.deductions);
  return {
    years: round2(years),
    monthlyWage,
    dailyRate,
    finalSalary,
    endOfService,
    unusedLeaveDays: i.unusedLeaveDays,
    leavePayout,
    deductions: round2(i.deductions),
    total,
  };
}

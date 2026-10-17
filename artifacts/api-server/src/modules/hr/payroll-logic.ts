/**
 * Payroll math — pure functions, no DB. Every rule comes from HR settings; nothing is assumed.
 *
 * Assumptions made explicit here (confirm with the accountant):
 *  - Insurance is calculated on the basic salary only, capped at the scheme's cap if one is set.
 *  - Income tax brackets from settings are applied to the monthly taxable income
 *    (gross minus employee insurance and absence deduction).
 *  - Daily rate = basic salary ÷ daily divisor from settings.
 *  - Fines: decided fines are deducted in the month of the decision, capped at
 *    monthlyCapDays × daily rate. The excess is shown as deferred, not deducted.
 */

export interface PayrollSettings {
  social: {
    employeeRatePct: number | null;
    employerRatePct: number | null;
    capAmount: number | null;
  } | null;
  health: {
    employeeRatePct: number | null;
    employerRatePct: number | null;
    capAmount: number | null;
  } | null;
  tax: { brackets: { upTo: number | null; ratePct: number }[] } | null;
  absence: { dailyDivisor: number; weeklyOffDays: number[] } | null;
  fines: { monthlyCapDays: number | null } | null;
}

/** Which required settings are still missing. Empty list = payroll can run. */
export function missingPayrollSettings(s: PayrollSettings): string[] {
  const missing: string[] = [];
  if (!s.social || s.social.employeeRatePct === null) missing.push("social_insurance");
  if (!s.health || s.health.employeeRatePct === null) missing.push("health_insurance");
  if (!s.tax || !s.tax.brackets.length) missing.push("income_tax");
  if (!s.absence || !Array.isArray(s.absence.weeklyOffDays)) missing.push("absence");
  return missing;
}

/**
 * Calendar dates of a payroll month on which an employee could be absent:
 * from the later of the 1st and the hire date, up to the earlier of the last day
 * and today (future days are not counted yet), skipping the weekly day(s) off.
 * Dates are YYYY-MM-DD; weekday is taken in UTC so the result is timezone-stable.
 */
export function absenceDates(
  period: string,
  hireDate: string | null,
  todayYmd: string,
  weeklyOffDays: number[],
): string[] {
  const [y, m] = period.split("-").map(Number);
  const monthStart = `${period}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthEnd = `${period}-${String(lastDay).padStart(2, "0")}`;
  const from = hireDate && hireDate > monthStart ? hireDate : monthStart;
  const to = todayYmd < monthEnd ? todayYmd : monthEnd;
  const out: string[] = [];
  if (from > to) return out;
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    if (!weeklyOffDays.includes(cursor.getUTCDay())) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Progressive tax on a monthly amount using bracket limits (upTo = top of each bracket, null = and above). */
export function monthlyIncomeTax(
  taxable: number,
  brackets: { upTo: number | null; ratePct: number }[],
): number {
  if (taxable <= 0) return 0;
  let tax = 0;
  let prev = 0;
  for (const b of brackets) {
    const top = b.upTo ?? Number.POSITIVE_INFINITY;
    if (taxable <= prev) break;
    const portion = Math.min(taxable, top) - prev;
    if (portion > 0) tax += (portion * b.ratePct) / 100;
    prev = top;
  }
  return round2(tax);
}

export interface PayslipInput {
  basic: number;
  allowances: number;
  bonuses: number;
  incentives: number;
  deductions: number;
  absenceDays: number;
  /** Total decided fines for the month (before the cap). */
  finesTotal: number;
}

export interface PayslipResult {
  basic: number;
  allowances: number;
  bonuses: number;
  incentives: number;
  deductions: number;
  absenceDays: number;
  absenceAmount: number;
  finesApplied: number;
  finesDeferred: number;
  socialEmployee: number;
  healthEmployee: number;
  incomeTax: number;
  gross: number;
  net: number;
  dailyRate: number;
}

function insurable(basic: number, cap: number | null): number {
  return cap === null ? basic : Math.min(basic, cap);
}

/** Compute one payslip. Settings must already pass missingPayrollSettings(). */
export function computePayslip(input: PayslipInput, s: PayrollSettings): PayslipResult {
  const divisor = s.absence!.dailyDivisor;
  const dailyRate = round2(input.basic / divisor);
  const absenceAmount = round2(dailyRate * input.absenceDays);

  const socialEmployee = round2(
    (insurable(input.basic, s.social!.capAmount) * (s.social!.employeeRatePct ?? 0)) / 100,
  );
  const healthEmployee = round2(
    (insurable(input.basic, s.health!.capAmount) * (s.health!.employeeRatePct ?? 0)) / 100,
  );

  const gross = round2(input.basic + input.allowances + input.bonuses + input.incentives);
  const taxableIncome = Math.max(
    0,
    round2(gross - absenceAmount - socialEmployee - healthEmployee),
  );
  const incomeTax = monthlyIncomeTax(taxableIncome, s.tax!.brackets);

  const cap = s.fines?.monthlyCapDays ?? null;
  const finesCap = cap === null ? input.finesTotal : round2(cap * dailyRate);
  const finesApplied = round2(Math.min(input.finesTotal, finesCap));
  const finesDeferred = round2(input.finesTotal - finesApplied);

  const net = round2(
    gross -
      absenceAmount -
      socialEmployee -
      healthEmployee -
      incomeTax -
      input.deductions -
      finesApplied,
  );

  return {
    basic: round2(input.basic),
    allowances: round2(input.allowances),
    bonuses: round2(input.bonuses),
    incentives: round2(input.incentives),
    deductions: round2(input.deductions),
    absenceDays: input.absenceDays,
    absenceAmount,
    finesApplied,
    finesDeferred,
    socialEmployee,
    healthEmployee,
    incomeTax,
    gross,
    net,
    dailyRate,
  };
}

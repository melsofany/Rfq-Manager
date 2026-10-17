import { describe, it, expect } from "vitest";
import {
  computePayslip,
  missingPayrollSettings,
  monthlyIncomeTax,
  withMissingPayrollSettingsAsDefaults,
  type PayrollSettings,
} from "../modules/hr/payroll-logic";

const full: PayrollSettings = {
  social: { employeeRatePct: 11, employerRatePct: 18.75, capAmount: 12600 },
  health: { employeeRatePct: 1, employerRatePct: 3, capAmount: null },
  tax: {
    brackets: [
      { upTo: 1000, ratePct: 0 },
      { upTo: 5000, ratePct: 10 },
      { upTo: null, ratePct: 20 },
    ],
  },
  absence: { dailyDivisor: 30, weeklyOffDays: [5] },
  fines: { monthlyCapDays: 5 },
};

describe("missing settings", () => {
  it("lists every required rule that is not configured", () => {
    const empty: PayrollSettings = {
      social: null,
      health: null,
      tax: null,
      absence: null,
      fines: null,
    };
    expect(missingPayrollSettings(empty)).toEqual([
      "social_insurance",
      "health_insurance",
      "income_tax",
      "absence",
    ]);
  });
  it("passes when everything is set", () => {
    expect(missingPayrollSettings(full)).toEqual([]);
  });
});

describe("income tax", () => {
  it("applies brackets progressively", () => {
    // 1000 at 0% + 4000 at 10% + 1000 at 20% = 600
    expect(monthlyIncomeTax(6000, full.tax!.brackets)).toBe(600);
  });
  it("is zero at or below the first limit", () => {
    expect(monthlyIncomeTax(900, full.tax!.brackets)).toBe(0);
    expect(monthlyIncomeTax(0, full.tax!.brackets)).toBe(0);
  });
});

describe("payslip", () => {
  it("computes gross, insurance, absence, tax and net", () => {
    const r = computePayslip(
      {
        basic: 6000,
        allowances: 1000,
        bonuses: 500,
        incentives: 0,
        deductions: 100,
        absenceDays: 2,
        finesTotal: 0,
      },
      full,
    );
    expect(r.gross).toBe(7500);
    expect(r.dailyRate).toBe(200);
    expect(r.absenceAmount).toBe(400);
    expect(r.socialEmployee).toBe(660); // 11% of 6000 (under cap)
    expect(r.healthEmployee).toBe(60); // 1% of 6000
    // taxable = 7500 - 400 - 660 - 60 = 6380 → 1000@0% + 4000@10% + 1380@20% = 676
    expect(r.incomeTax).toBe(676);
    expect(r.net).toBe(7500 - 400 - 660 - 60 - 676 - 100);
  });
  it("caps the social insurance base", () => {
    const r = computePayslip(
      {
        basic: 20000,
        allowances: 0,
        bonuses: 0,
        incentives: 0,
        deductions: 0,
        absenceDays: 0,
        finesTotal: 0,
      },
      full,
    );
    expect(r.socialEmployee).toBe(1386); // 11% of 12600 cap
  });
  it("caps fines at the monthly day limit and defers the rest", () => {
    // daily = 200, cap = 5 days = 1000
    const r = computePayslip(
      {
        basic: 6000,
        allowances: 0,
        bonuses: 0,
        incentives: 0,
        deductions: 0,
        absenceDays: 0,
        finesTotal: 1500,
      },
      full,
    );
    expect(r.finesApplied).toBe(1000);
    expect(r.finesDeferred).toBe(500);
  });
});

describe("payroll runs with missing settings", () => {
  it("fills missing settings with defaults so the run can compute", () => {
    const empty = { social: null, health: null, tax: null, absence: null, fines: null };
    const filled = withMissingPayrollSettingsAsDefaults(empty);
    expect(missingPayrollSettings(filled)).toEqual(["income_tax"]);
    const slip = computePayslip(
      {
        basic: 3000,
        allowances: 0,
        bonuses: 0,
        incentives: 0,
        deductions: 0,
        absenceDays: 0,
        finesTotal: 0,
      },
      filled,
    );
    expect(slip.socialEmployee).toBe(0);
    expect(slip.healthEmployee).toBe(0);
    expect(slip.incomeTax).toBe(0);
    expect(slip.net).toBe(3000);
  });
  it("keeps settings that already exist", () => {
    const full = {
      social: { employeeRatePct: 11, employerRatePct: 18.75, capAmount: null },
      health: { employeeRatePct: 1, employerRatePct: 3, capAmount: null },
      tax: { brackets: [{ upTo: null, ratePct: 10 }] },
      absence: { dailyDivisor: 26, weeklyOffDays: [5] },
      fines: null,
    };
    expect(withMissingPayrollSettingsAsDefaults(full)).toEqual(full);
  });
});

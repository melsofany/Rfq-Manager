import { describe, it, expect } from "vitest";
import {
  computeSettlement,
  endOfServiceAmount,
  serviceYears,
  finalSalaryAmount,
} from "../modules/hr/settlement-logic";
import { validateSetting } from "../modules/hr/settings-logic";

const rule = {
  firstYearsDays: 15,
  firstYearsLimit: 5,
  laterMonthsPerYear: 1,
  eligibilityByReason: { resignation: 50, termination: 100, end_of_contract: 100 },
};

describe("settlement math", () => {
  it("counts service in years", () => {
    expect(serviceYears("2020-01-01", "2025-01-01")).toBeCloseTo(1827 / 365, 5);
    expect(serviceYears("2025-01-01", "2020-01-01")).toBe(0);
  });
  it("end of service: days per year for first years, months after", () => {
    // 7 years, wage 3000: 5 years × 15/30 × 3000 = 7500, + 2 years × 1 × 3000 = 6000 → 13500
    expect(endOfServiceAmount(3000, 7, rule, 100)).toBe(13500);
  });
  it("eligibility percent scales end of service", () => {
    expect(endOfServiceAmount(3000, 7, rule, 50)).toBe(6750);
  });
  it("final salary is pro-rata for the exit day and capped at one month", () => {
    expect(finalSalaryAmount(3000, "2026-10-15", 30)).toBe(1500);
    expect(finalSalaryAmount(3000, "2026-10-31", 30)).toBe(3000);
  });
  it("total = final salary + end of service + leave payout − deductions", () => {
    const r = computeSettlement({
      hireDate: "2019-10-16",
      exitDate: "2026-10-15",
      reason: "termination",
      basic: 2000,
      allowances: 1000,
      divisor: 30,
      rule,
      eligibilityPct: 100,
      unusedLeaveDays: 3,
      deductions: 200,
    });
    expect(r.monthlyWage).toBe(3000);
    expect(r.dailyRate).toBe(66.67);
    expect(r.finalSalary).toBe(1500);
    expect(r.leavePayout).toBe(200.01);
    expect(r.total).toBe(round(1500 + r.endOfService + 200.01 - 200));
  });
});

function round(n: number) {
  return Math.round(n * 100) / 100;
}

describe("no double pay for the exit month", () => {
  it("skips final salary when the exit month payroll already paid the employee", () => {
    const r = computeSettlement({
      hireDate: "2019-10-16",
      exitDate: "2026-10-15",
      reason: "resignation",
      basic: 2000,
      allowances: 1000,
      divisor: 30,
      rule,
      eligibilityPct: 100,
      unusedLeaveDays: 0,
      deductions: 0,
      finalSalaryPaid: true,
    });
    expect(r.finalSalary).toBe(0);
    expect(r.endOfService).toBeGreaterThan(0);
  });
});

describe("end_of_service setting validator", () => {
  it("accepts a complete rule", () => {
    expect(validateSetting("end_of_service", rule)).toEqual({ value: rule });
  });
  it("refuses an incomplete rule", () => {
    expect(validateSetting("end_of_service", { firstYearsDays: 15 })).toHaveProperty("error");
  });
  it("requires an eligibility percentage for every exit reason", () => {
    const { eligibilityByReason: _omit, ...noReasons } = rule;
    expect(validateSetting("end_of_service", noReasons)).toHaveProperty("error");
    expect(
      validateSetting("end_of_service", {
        ...rule,
        eligibilityByReason: { resignation: 50, termination: 100 },
      }),
    ).toHaveProperty("error");
    expect(
      validateSetting("end_of_service", {
        ...rule,
        eligibilityByReason: { resignation: 150, termination: 100, end_of_contract: 100 },
      }),
    ).toHaveProperty("error");
  });
  it("null means not configured", () => {
    expect(validateSetting("end_of_service", null)).toEqual({ value: null });
  });
});

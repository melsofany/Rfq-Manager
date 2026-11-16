import { describe, it, expect } from "vitest";
import { staleAdjustmentFields } from "../modules/hr/payroll-inputs";

/**
 * A deduction or a fine added on the Discipline & rewards tab AFTER the draft
 * was calculated must make the draft STALE, or the operator approves a payslip
 * whose net still ignores the money they just recorded — which is exactly the
 * "الخصم مش بيتحسب" report.
 */
describe("staleAdjustmentFields", () => {
  const noAdj: never[] = [];

  it("reports nothing when the stored figures match the period records", () => {
    const changed = staleAdjustmentFields(
      { bonuses: 0, deductions: 50, finesApplied: 153 },
      [{ employeeId: 1, kind: "deduction", amount: 50, days: 0 }],
      153,
      230.77,
      20,
    );
    expect(changed).toEqual([]);
  });

  it("detects a deduction added AFTER the draft was calculated", () => {
    // The slip still holds the pre-change figure (0), the period now has 50.
    const changed = staleAdjustmentFields(
      { bonuses: 0, deductions: 0, finesApplied: 0 },
      [{ employeeId: 1, kind: "deduction", amount: 50, days: 0 }],
      0,
      230.77,
      20,
    );
    expect(changed).toContain("deductions");
  });

  it("detects a fine decided after the draft was calculated", () => {
    const changed = staleAdjustmentFields(
      { bonuses: 0, deductions: 0, finesApplied: 0 },
      noAdj,
      192,
      230.77,
      20,
    );
    expect(changed).toContain("fines");
  });

  it("detects a bonus added after the draft was calculated", () => {
    const changed = staleAdjustmentFields(
      { bonuses: 0, deductions: 0, finesApplied: 0 },
      [{ employeeId: 1, kind: "bonus", amount: 500, days: 0 }],
      0,
      230.77,
      20,
    );
    expect(changed).toContain("bonuses");
  });

  it("converts a day-based deduction at the month's daily rate", () => {
    // 2 days × 200 = 400; the slip already reflects it.
    const changed = staleAdjustmentFields(
      { bonuses: 0, deductions: 400, finesApplied: 0 },
      [{ employeeId: 1, kind: "deduction", amount: 0, days: 2 }],
      0,
      200,
      20,
    );
    expect(changed).toEqual([]);
  });

  it("caps fines at monthlyCapDays × daily rate", () => {
    // cap = 2 × 100 = 200, so 500 of fines applies as 200.
    const changed = staleAdjustmentFields(
      { bonuses: 0, deductions: 0, finesApplied: 200 },
      noAdj,
      500,
      100,
      2,
    );
    expect(changed).toEqual([]);
  });

  it("treats a null cap as no cap", () => {
    const changed = staleAdjustmentFields(
      { bonuses: 0, deductions: 0, finesApplied: 500 },
      noAdj,
      500,
      100,
      null,
    );
    expect(changed).toEqual([]);
  });
});

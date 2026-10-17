import { describe, it, expect } from "vitest";
import { absenceDates, missingPayrollSettings } from "../modules/hr/payroll-logic";

const FRI = 5;

describe("absenceDates", () => {
  it("counts every day of a past month except weekly days off", () => {
    // October 2026: 31 days, Fridays are the 2nd, 9th, 16th, 23rd, 30th → 5 Fridays
    const days = absenceDates("2026-10", null, "2026-11-30", [FRI]);
    expect(days).toHaveLength(31 - 5);
    expect(days).not.toContain("2026-10-02");
    expect(days).toContain("2026-10-01");
  });

  it("starts from the hire date inside the month", () => {
    const days = absenceDates("2026-10", "2026-10-20", "2026-11-30", []);
    expect(days[0]).toBe("2026-10-20");
    expect(days).toHaveLength(12);
  });

  it("ignores hire dates before the month", () => {
    expect(absenceDates("2026-10", "2020-01-01", "2026-11-30", [])).toHaveLength(31);
  });

  it("does not count future days of the current month", () => {
    const days = absenceDates("2026-10", null, "2026-10-10", []);
    expect(days[days.length - 1]).toBe("2026-10-10");
    expect(days).toHaveLength(10);
  });

  it("returns nothing for a month that has not started or a hire after month end", () => {
    expect(absenceDates("2026-10", null, "2026-09-15", [])).toEqual([]);
    expect(absenceDates("2026-10", "2026-11-01", "2026-12-01", [])).toEqual([]);
  });
});

describe("missingPayrollSettings with weekly off", () => {
  const base = {
    social: { employeeRatePct: 11, employerRatePct: 18.75, capAmount: null },
    health: { employeeRatePct: 1, employerRatePct: 3, capAmount: null },
    tax: { brackets: [{ upTo: null, ratePct: 10 }] },
    fines: null,
  };
  it("asks for absence settings that have no weekly off list yet", () => {
    expect(missingPayrollSettings({ ...base, absence: { dailyDivisor: 30 } as never })).toContain(
      "absence",
    );
  });
  it("is complete once the weekly off list is set", () => {
    expect(
      missingPayrollSettings({ ...base, absence: { dailyDivisor: 30, weeklyOffDays: [] } }),
    ).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { validateSetting, isSettingKey } from "../modules/hr/settings-logic";

describe("HR settings keys", () => {
  it("knows its keys", () => {
    expect(isSettingKey("income_tax")).toBe(true);
    expect(isSettingKey("nope")).toBe(false);
  });
  it("null means not configured and is accepted for every key", () => {
    for (const k of [
      "social_insurance",
      "income_tax",
      "absence",
      "fines",
      "allowance_types",
      "bank_export",
    ] as const) {
      expect(validateSetting(k, null)).toEqual({ value: null });
    }
  });
});

describe("insurance", () => {
  it("accepts rates and a cap", () => {
    const r = validateSetting("social_insurance", {
      employeeRatePct: 11,
      employerRatePct: 18.75,
      capAmount: 12600,
    });
    expect(r).toEqual({ value: { employeeRatePct: 11, employerRatePct: 18.75, capAmount: 12600 } });
  });
  it("allows blank parts (not yet known)", () => {
    expect(
      validateSetting("health_insurance", {
        employeeRatePct: null,
        employerRatePct: 3,
        capAmount: null,
      }),
    ).toEqual({
      value: { employeeRatePct: null, employerRatePct: 3, capAmount: null },
    });
  });
  it("refuses rates above 100 or negative caps", () => {
    expect(
      validateSetting("social_insurance", {
        employeeRatePct: 120,
        employerRatePct: 1,
        capAmount: 1,
      }),
    ).toHaveProperty("error");
    expect(
      validateSetting("social_insurance", {
        employeeRatePct: 1,
        employerRatePct: 1,
        capAmount: -5,
      }),
    ).toHaveProperty("error");
  });
});

describe("income tax brackets", () => {
  it("accepts ascending brackets ending with an open one", () => {
    const r = validateSetting("income_tax", {
      brackets: [
        { upTo: 1000, ratePct: 0 },
        { upTo: 5000, ratePct: 10 },
        { upTo: null, ratePct: 22.5 },
      ],
    });
    expect("value" in r).toBe(true);
  });
  it("refuses non-ascending limits", () => {
    expect(
      validateSetting("income_tax", {
        brackets: [
          { upTo: 5000, ratePct: 10 },
          { upTo: 1000, ratePct: 0 },
          { upTo: null, ratePct: 20 },
        ],
      }),
    ).toHaveProperty("error");
  });
  it("refuses a middle bracket without a limit", () => {
    expect(
      validateSetting("income_tax", {
        brackets: [
          { upTo: null, ratePct: 1 },
          { upTo: null, ratePct: 2 },
        ],
      }),
    ).toHaveProperty("error");
  });
  it("refuses a last bracket with a limit", () => {
    expect(
      validateSetting("income_tax", { brackets: [{ upTo: 1000, ratePct: 1 }] }),
    ).toHaveProperty("error");
  });
});

describe("absence, fines, allowances, bank", () => {
  it("absence divisor is a whole number 1–31", () => {
    expect(validateSetting("absence", { dailyDivisor: 30, weeklyOffDays: [5] })).toEqual({
      value: { dailyDivisor: 30, weeklyOffDays: [5] },
    });
    expect(validateSetting("absence", { dailyDivisor: 30.5, weeklyOffDays: [] })).toHaveProperty(
      "error",
    );
    expect(validateSetting("absence", { dailyDivisor: 0, weeklyOffDays: [] })).toHaveProperty(
      "error",
    );
  });
  it("absence requires the weekly off list (0–6), an empty list is allowed", () => {
    expect(validateSetting("absence", { dailyDivisor: 30 })).toHaveProperty("error");
    expect(validateSetting("absence", { dailyDivisor: 30, weeklyOffDays: [] })).toEqual({
      value: { dailyDivisor: 30, weeklyOffDays: [] },
    });
    expect(validateSetting("absence", { dailyDivisor: 30, weeklyOffDays: [7] })).toHaveProperty(
      "error",
    );
    expect(validateSetting("absence", { dailyDivisor: 30, weeklyOffDays: [5, 5, 6] })).toEqual({
      value: { dailyDivisor: 30, weeklyOffDays: [5, 6] },
    });
  });
  it("fines cap is a whole number of days", () => {
    expect(validateSetting("fines", { monthlyCapDays: 5 })).toEqual({
      value: { monthlyCapDays: 5 },
    });
    expect(validateSetting("fines", { monthlyCapDays: 99 })).toHaveProperty("error");
  });
  it("allowance types are trimmed, de-duplicated and blanks dropped", () => {
    expect(validateSetting("allowance_types", { items: [" سكن ", "", "نقل", "سكن"] })).toEqual({
      value: { items: ["سكن", "نقل"] },
    });
  });
  it("bank export keeps format and notes, blanks become null", () => {
    expect(validateSetting("bank_export", { format: "  ", notes: "ملف CSV" })).toEqual({
      value: { format: null, notes: "ملف CSV" },
    });
  });
});

describe("work shift", () => {
  it("accepts a start, an end and a grace period", () => {
    expect(
      validateSetting("work_shift", { start: "08:30", end: "16:30", lateGraceMinutes: 15 }),
    ).toEqual({ value: { start: "08:30", end: "16:30", lateGraceMinutes: 15 } });
  });
  it("defaults the grace period to 0 when it is omitted", () => {
    expect(validateSetting("work_shift", { start: "09:00", end: "17:00" })).toEqual({
      value: { start: "09:00", end: "17:00", lateGraceMinutes: 0 },
    });
  });
  it("rejects a malformed start or end time", () => {
    expect(validateSetting("work_shift", { start: "9:00", end: "17:00" })).toHaveProperty("error");
    expect(validateSetting("work_shift", { start: "09:00", end: "25:00" })).toHaveProperty("error");
    expect(validateSetting("work_shift", { start: "", end: "17:00" })).toHaveProperty("error");
  });
  it("rejects a negative or excessive grace period", () => {
    expect(
      validateSetting("work_shift", { start: "09:00", end: "17:00", lateGraceMinutes: -1 }),
    ).toHaveProperty("error");
    expect(
      validateSetting("work_shift", { start: "09:00", end: "17:00", lateGraceMinutes: 500 }),
    ).toHaveProperty("error");
  });
  it("null means not configured", () => {
    expect(validateSetting("work_shift", null)).toEqual({ value: null });
  });
});

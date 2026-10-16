import { describe, it, expect } from "vitest";
import { money, fmtMoney, periodLabel, clockTime } from "@/lib/format";

/**
 * Accounting figures must use Latin digits with thousands grouping. An
 * Arabic-Indic rendering (١٬٢٣٤٫٥٠) cannot be compared against a bank or
 * e-invoice statement, which is why the helpers opt out of the ar-EG locale
 * even though the surrounding UI is Arabic.
 */
describe("money / fmtMoney", () => {
  it("formats with Latin digits, grouping and two decimals", () => {
    expect(money("1234.5")).toBe("1,234.50");
    expect(fmtMoney(1234.5)).toBe("1,234.50");
    expect(money(1234567.891)).toBe("1,234,567.89");
  });

  it("never emits Arabic-Indic digits", () => {
    const out = money(9876543.21);
    expect(out).toMatch(/^[0-9,.]+$/);
    expect(out).not.toMatch(/[٠-٩]/);
  });

  it("renders small and negative values", () => {
    expect(money("0")).toBe("0.00");
    expect(money(-42.5)).toBe("-42.50");
  });

  it("uses a dash for absent or invalid values", () => {
    expect(money(null)).toBe("-");
    expect(money("")).toBe("-");
    expect(fmtMoney(null)).toBe("-");
    expect(money("abc")).toBe("-");
  });
});

describe("periodLabel", () => {
  it("keeps the Arabic month name with Latin year digits", () => {
    expect(periodLabel("2026-09")).toBe("سبتمبر 2026");
  });
});

describe("clockTime", () => {
  it("formats a full timestamp in 12-hour form with Latin digits", () => {
    expect(clockTime("2026-10-16 09:05:00")).toBe("9:05 AM");
    expect(clockTime("2026-10-16T21:30:00")).toBe("9:30 PM");
  });

  it("uses 12 for midnight and noon instead of 0", () => {
    expect(clockTime("2026-10-16 00:00:00")).toBe("12:00 AM");
    expect(clockTime("2026-10-16 12:00:00")).toBe("12:00 PM");
  });

  it("accepts a bare HH:MM value", () => {
    expect(clockTime("14:45")).toBe("2:45 PM");
    expect(clockTime("09:00")).toBe("9:00 AM");
  });

  it("marks the AM/PM boundary at 11 and 12", () => {
    expect(clockTime("11:59")).toBe("11:59 AM");
    expect(clockTime("12:01")).toBe("12:01 PM");
    expect(clockTime("23:59")).toBe("11:59 PM");
  });

  it("uses a dash for absent or unparseable values", () => {
    expect(clockTime(null)).toBe("—");
    expect(clockTime(undefined)).toBe("—");
    expect(clockTime("")).toBe("—");
    expect(clockTime("not a time")).toBe("—");
    expect(clockTime("99:99")).toBe("—");
  });

  it("never leaks a 24-hour hour into the output", () => {
    for (const v of ["13:00", "17:30", "23:00"]) {
      expect(clockTime(v)).not.toMatch(/^(1[3-9]|2[0-3]):/);
    }
  });
});

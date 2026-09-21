import { describe, it, expect } from "vitest";
import { money, fmtMoney, periodLabel } from "@/lib/format";

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

import { describe, it, expect } from "vitest";
import { parseDays } from "../modules/hr/discipline-logic";

describe("parseDays (day-based bonus)", () => {
  it("accepts half-day steps between 0.5 and 31", () => {
    expect(parseDays(0.5)).toBe(0.5);
    expect(parseDays("2")).toBe(2);
    expect(parseDays(1.5)).toBe(1.5);
    expect(parseDays(31)).toBe(31);
  });

  it("rejects zero, above 31, quarter days, and non-numbers", () => {
    expect(parseDays(0)).toBeUndefined();
    expect(parseDays(32)).toBeUndefined();
    expect(parseDays(1.25)).toBeUndefined();
    expect(parseDays("abc")).toBeUndefined();
  });
});

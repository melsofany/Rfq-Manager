import { describe, expect, it } from "vitest";
import { otifScoreOf } from "../../shared/supplier-otif";

describe("otifScoreOf", () => {
  it("is null when there are no due lines", () => {
    expect(otifScoreOf(0, 0)).toBeNull();
  });

  it("is the rounded share of lines hit", () => {
    expect(otifScoreOf(4, 3)).toBe(75);
    expect(otifScoreOf(3, 1)).toBe(33);
    expect(otifScoreOf(2, 2)).toBe(100);
    expect(otifScoreOf(5, 0)).toBe(0);
  });

  it("clamps hits into the valid range", () => {
    expect(otifScoreOf(2, 5)).toBe(100);
    expect(otifScoreOf(2, -1)).toBe(0);
  });
});

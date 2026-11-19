import { describe, it, expect } from "vitest";
import { standingOf, STANDING_MIN_SAMPLE } from "../../shared/supplier-standing";

describe("standingOf", () => {
  it("is not_rated when there is no score", () => {
    expect(standingOf(null, 10)).toBe("not_rated");
  });

  it("is not_rated below the minimum sample, even with a high score", () => {
    expect(standingOf(95, STANDING_MIN_SAMPLE - 1)).toBe("not_rated");
  });

  it("grades preferred at 80 and above", () => {
    expect(standingOf(80, STANDING_MIN_SAMPLE)).toBe("preferred");
    expect(standingOf(100, 50)).toBe("preferred");
  });

  it("grades watch from 60 up to 79", () => {
    expect(standingOf(60, STANDING_MIN_SAMPLE)).toBe("watch");
    expect(standingOf(79, STANDING_MIN_SAMPLE)).toBe("watch");
  });

  it("grades restricted below 60", () => {
    expect(standingOf(59, STANDING_MIN_SAMPLE)).toBe("restricted");
    expect(standingOf(0, STANDING_MIN_SAMPLE)).toBe("restricted");
  });
});

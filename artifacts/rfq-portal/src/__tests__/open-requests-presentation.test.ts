import { describe, it, expect } from "vitest";
import {
  asUrgency,
  progressPct,
  URGENCY_ROW_ACCENT,
  URGENCY_STYLES,
} from "@/modules/customer-rfq/pages/open-requests-presentation";

/**
 * The countdown label and the urgency bucket come from the server, so what is
 * pinned here is only that an unknown or hostile value can never render as
 * «calm» — the failure direction that would hide the most urgent rows.
 */
describe("asUrgency", () => {
  it("passes through every known bucket", () => {
    for (const u of ["overdue", "today", "soon", "normal"] as const) {
      expect(asUrgency(u)).toBe(u);
    }
  });

  it("defaults an unknown value to «none» rather than to a calm bucket", () => {
    // «normal» would claim the request is comfortably open; «none» only claims
    // the close date is unknown, which is what an unrecognised value means.
    expect(asUrgency("whatever")).toBe("none");
    expect(asUrgency(undefined)).toBe("none");
    expect(asUrgency(null)).toBe("none");
    expect(asUrgency(7)).toBe("none");
    expect(asUrgency({})).toBe("none");
  });

  it("has a style and an accent for every bucket it can return", () => {
    for (const u of ["overdue", "today", "soon", "normal", "none"] as const) {
      expect(URGENCY_STYLES[u]).toBeTruthy();
      expect(URGENCY_ROW_ACCENT[u]).toBeTruthy();
    }
    // Only the urgent buckets may tint the row, or the accent stops meaning
    // anything.
    expect(URGENCY_ROW_ACCENT.normal).not.toContain("red");
    expect(URGENCY_ROW_ACCENT.overdue).toContain("red");
  });
});

describe("progressPct", () => {
  it("clamps to 0..100 and rounds", () => {
    expect(progressPct(0)).toBe(0);
    expect(progressPct(50.4)).toBe(50);
    expect(progressPct(100)).toBe(100);
    expect(progressPct(140)).toBe(100);
    expect(progressPct(-5)).toBe(0);
  });

  it("treats an absent or non-finite share as 0, never as complete", () => {
    expect(progressPct(null)).toBe(0);
    expect(progressPct(undefined)).toBe(0);
    expect(progressPct(Number.NaN)).toBe(0);
    expect(progressPct(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import {
  resolveEmployeeShift,
  lateMinutesFor,
  isAbsent,
} from "../modules/hr/attendance-exception-logic";

const shift = { start: "08:00", end: "16:00", lateGraceMinutes: 0 };

describe("resolveEmployeeShift", () => {
  it("keeps the company shift when the employee has no exception", () => {
    const r = resolveEmployeeShift(shift, null);
    expect(r.start).toBe("08:00");
    expect(r.lateGraceMinutes).toBe(0);
    expect(r.exemptFromPunch).toBe(false);
    expect(r.hasException).toBe(false);
  });

  it("ignores an INACTIVE exception — a disabled policy must not apply", () => {
    const r = resolveEmployeeShift(shift, {
      startTime: "11:00",
      lateGraceMinutes: 0,
      exemptFromPunch: true,
      isActive: false,
    });
    expect(r.start).toBe("08:00");
    expect(r.exemptFromPunch).toBe(false);
    expect(r.hasException).toBe(false);
  });

  it("applies the employee's own start time", () => {
    const r = resolveEmployeeShift(shift, {
      startTime: "11:00",
      lateGraceMinutes: null,
      exemptFromPunch: false,
      isActive: true,
    });
    expect(r.start).toBe("11:00");
    expect(r.lateGraceMinutes).toBe(0);
    expect(r.hasException).toBe(true);
  });

  it("keeps the company grace when the exception does not set one", () => {
    const r = resolveEmployeeShift(
      { start: "08:00", end: "16:00", lateGraceMinutes: 30 },
      { startTime: "11:00", lateGraceMinutes: null, exemptFromPunch: false, isActive: true },
    );
    expect(r.lateGraceMinutes).toBe(30);
  });

  it("IGNORES a malformed stored start rather than moving the cutoff", () => {
    for (const bad of ["", "  ", "25:00", "11", "abc", null]) {
      const r = resolveEmployeeShift(shift, {
        startTime: bad as string | null,
        lateGraceMinutes: null,
        exemptFromPunch: false,
        isActive: true,
      });
      expect(r.start, `bad start ${JSON.stringify(bad)} must not apply`).toBe("08:00");
    }
  });

  it("ignores an out-of-range stored grace", () => {
    for (const bad of [-5, 999, 1.5]) {
      const r = resolveEmployeeShift(shift, {
        startTime: null,
        lateGraceMinutes: bad,
        exemptFromPunch: false,
        isActive: true,
      });
      expect(r.lateGraceMinutes).toBe(0);
    }
  });
});

describe("lateMinutesFor", () => {
  it("computes lateness against the resolved start", () => {
    // The reported case: shift 08:00, employee allowed to start 11:00.
    const r = { start: "11:00", lateGraceMinutes: 0, exemptFromPunch: false };
    expect(lateMinutesFor(r, "11:00:00")).toBe(0);
    expect(lateMinutesFor(r, "11:30:00")).toBe(30);
    // 08:00 would be 180 late on the company shift — the exception removes it.
    expect(lateMinutesFor(r, "08:00:00")).toBe(0);
  });

  it("subtracts the grace", () => {
    const r = { start: "11:00", lateGraceMinutes: 15, exemptFromPunch: false };
    expect(lateMinutesFor(r, "11:10:00")).toBe(0);
    expect(lateMinutesFor(r, "11:40:00")).toBe(25);
  });

  it("never reports lateness for an employee exempt from punching", () => {
    const r = { start: "11:00", lateGraceMinutes: 0, exemptFromPunch: true };
    // Even a wildly late stray punch must not count.
    expect(lateMinutesFor(r, "18:00:00")).toBe(0);
  });

  it("reports 0 when there is no punch", () => {
    expect(
      lateMinutesFor({ start: "11:00", lateGraceMinutes: 0, exemptFromPunch: false }, null),
    ).toBe(0);
  });
});

describe("isAbsent", () => {
  it("is absent with no punch and no excuse", () => {
    expect(
      isAbsent({ punchCount: 0, exemptFromPunch: false, fullDayMission: false, onLeave: false }),
    ).toBe(true);
  });

  it("is present when a punch exists", () => {
    expect(
      isAbsent({ punchCount: 1, exemptFromPunch: false, fullDayMission: false, onLeave: false }),
    ).toBe(false);
  });

  it("is NOT absent when exempt from punching — the day counts as normal", () => {
    expect(
      isAbsent({ punchCount: 0, exemptFromPunch: true, fullDayMission: false, onLeave: false }),
    ).toBe(false);
  });

  it("is not absent on a full-day mission or approved leave", () => {
    expect(
      isAbsent({ punchCount: 0, exemptFromPunch: false, fullDayMission: true, onLeave: false }),
    ).toBe(false);
    expect(
      isAbsent({ punchCount: 0, exemptFromPunch: false, fullDayMission: false, onLeave: true }),
    ).toBe(false);
  });
});

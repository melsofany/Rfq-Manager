import { describe, it, expect } from "vitest";
import {
  pairDayPunches,
  isDayComplete,
  PUNCH_IN,
  PUNCH_OUT,
  PUNCH_OT_IN,
  PUNCH_OT_OUT,
} from "../modules/hr/punch-pairing";

/**
 * The device sends a DIRECTION with every punch. Ignoring it recorded a rep who
 * punched only on the way OUT as ARRIVING at their departure time — the whole
 * day read as an extreme late arrival. These tests pin the direction-aware
 * pairing that fixes it.
 */
describe("pairDayPunches — direction aware", () => {
  it("uses the check-in as arrival and the check-out as departure", () => {
    const day = pairDayPunches([
      { time: "08:05:00", status: PUNCH_OUT }, // device clock oddity: an out before an in
      { time: "08:10:00", status: PUNCH_IN },
      { time: "16:00:00", status: PUNCH_OUT },
    ]);
    expect(day.firstIn).toBe("08:10:00");
    expect(day.lastOut).toBe("16:00:00");
    expect(day.incomplete).toBe(false);
    expect(day.missing).toBeNull();
  });

  it("treats a lone check-out as missing the arrival (not a very late arrival)", () => {
    const day = pairDayPunches([{ time: "16:00:00", status: PUNCH_OUT }]);
    expect(day.firstIn).toBeNull();
    expect(day.lastOut).toBe("16:00:00");
    expect(day.incomplete).toBe(true);
    expect(day.missing).toBe("in");
  });

  it("treats a lone check-in as missing the departure", () => {
    const day = pairDayPunches([{ time: "08:00:00", status: PUNCH_IN }]);
    expect(day.firstIn).toBe("08:00:00");
    expect(day.lastOut).toBeNull();
    expect(day.incomplete).toBe(true);
    expect(day.missing).toBe("out");
  });

  it("accepts overtime codes as in/out directions", () => {
    const day = pairDayPunches([
      { time: "08:00:00", status: PUNCH_OT_IN },
      { time: "20:00:00", status: PUNCH_OT_OUT },
    ]);
    expect(day.firstIn).toBe("08:00:00");
    expect(day.lastOut).toBe("20:00:00");
    expect(day.incomplete).toBe(false);
  });

  it("takes the earliest in and the latest out among many punches", () => {
    const day = pairDayPunches([
      { time: "08:00:00", status: PUNCH_IN },
      { time: "12:00:00", status: PUNCH_OUT },
      { time: "12:30:00", status: PUNCH_IN },
      { time: "17:00:00", status: PUNCH_OUT },
    ]);
    expect(day.firstIn).toBe("08:00:00");
    expect(day.lastOut).toBe("17:00:00");
    expect(day.punchCount).toBe(4);
  });
});

describe("pairDayPunches — firmware without directions", () => {
  it("falls back to first/last and marks a single punch incomplete", () => {
    const day = pairDayPunches([
      { time: "08:00:00", status: null },
      { time: "17:00:00", status: null },
    ]);
    expect(day.firstIn).toBe("08:00:00");
    expect(day.lastOut).toBe("17:00:00");
    expect(day.incomplete).toBe(false);
  });

  it("treats a single undirected punch as an arrival but incomplete", () => {
    const day = pairDayPunches([{ time: "08:00:00", status: null }]);
    expect(day.firstIn).toBe("08:00:00");
    expect(day.lastOut).toBeNull();
    expect(day.incomplete).toBe(true);
    expect(day.missing).toBe("out");
  });

  it("returns an empty day when there are no punches", () => {
    const day = pairDayPunches([]);
    expect(day).toEqual({
      firstIn: null,
      lastOut: null,
      punchCount: 0,
      incomplete: false,
      missing: null,
    });
  });
});

describe("isDayComplete", () => {
  it("is complete only with both sides", () => {
    const both = pairDayPunches([
      { time: "08:00:00", status: PUNCH_IN },
      { time: "17:00:00", status: PUNCH_OUT },
    ]);
    expect(isDayComplete(both, false)).toBe(true);
  });

  it("is NOT complete for a one-sided day, so an absence is not hidden", () => {
    const oneSide = pairDayPunches([{ time: "16:00:00", status: PUNCH_OUT }]);
    expect(isDayComplete(oneSide, false)).toBe(false);
  });

  it("is complete when the employee is exempt from punching", () => {
    const none = pairDayPunches([]);
    expect(isDayComplete(none, true)).toBe(true);
  });
});

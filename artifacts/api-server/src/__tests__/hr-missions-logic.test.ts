import { describe, it, expect } from "vitest";
import {
  isHhMm,
  isMissionType,
  toMinutes,
  validateMissionWindow,
  isFullDayMission,
  approvedWindow,
  missionExcusal,
  withinMissionWindow,
  type MissionLike,
} from "../modules/hr/missions-logic";

const m = (over: Partial<MissionLike> = {}): MissionLike => ({
  missionType: "full_day",
  status: "approved",
  startTime: null,
  endTime: null,
  ...over,
});

describe("mission validation", () => {
  it("accepts only the two mission types", () => {
    expect(isMissionType("full_day")).toBe(true);
    expect(isMissionType("timed")).toBe(true);
    expect(isMissionType("half_day")).toBe(false);
    expect(isMissionType(null)).toBe(false);
  });

  it("validates an HH:MM time", () => {
    expect(isHhMm("08:00")).toBe(true);
    expect(isHhMm("23:59")).toBe(true);
    expect(isHhMm("24:00")).toBe(false);
    expect(isHhMm("8:00")).toBe(false);
    expect(isHhMm("")).toBe(false);
  });

  it("converts a time to minutes from midnight", () => {
    expect(toMinutes("00:00")).toBe(0);
    expect(toMinutes("08:30")).toBe(510);
    expect(toMinutes("16:00")).toBe(960);
  });
});

describe("validateMissionWindow", () => {
  it("requires a window for a timed mission", () => {
    expect(validateMissionWindow("timed", null, null)).toEqual({
      error: expect.stringContaining("وقت بداية"),
    });
    expect(validateMissionWindow("timed", "08:00", null)).toHaveProperty("error");
    expect(validateMissionWindow("timed", null, "12:00")).toHaveProperty("error");
  });

  it("rejects an end time at or before the start", () => {
    expect(validateMissionWindow("timed", "12:00", "12:00")).toEqual({
      error: expect.stringContaining("بعد وقت البداية"),
    });
    expect(validateMissionWindow("timed", "14:00", "09:00")).toHaveProperty("error");
  });

  it("keeps a valid timed window", () => {
    expect(validateMissionWindow("timed", "08:00", "12:00")).toEqual({
      startTime: "08:00",
      endTime: "12:00",
    });
  });

  it("drops times supplied on a full-day mission", () => {
    // A full-day mission carrying times would look timed while covering
    // everything — the ignore must be explicit, not silent.
    expect(validateMissionWindow("full_day", "08:00", "12:00")).toEqual({
      startTime: null,
      endTime: null,
    });
  });
});

describe("missionExcusal", () => {
  it("treats an approved full-day mission as a whole-day excusal", () => {
    const e = missionExcusal([m({ missionType: "full_day" })]);
    expect(e.fullDay).toBe(true);
    expect(e.windows).toHaveLength(0);
  });

  it("does not excuse anything while the mission is pending", () => {
    // The operator's rule: the manager approves. A pending request must not
    // clear an absence on its own.
    const e = missionExcusal([m({ status: "pending" })]);
    expect(e.fullDay).toBe(false);
    expect(e.windows).toHaveLength(0);
  });

  it("does not excuse a rejected mission", () => {
    const e = missionExcusal([m({ status: "rejected" })]);
    expect(e.fullDay).toBe(false);
    expect(e.windows).toHaveLength(0);
  });

  it("excuses only the window of an approved timed mission", () => {
    const e = missionExcusal([m({ missionType: "timed", startTime: "08:00", endTime: "12:00" })]);
    expect(e.fullDay).toBe(false);
    expect(e.windows).toEqual([{ start: 480, end: 720, startTime: "08:00", endTime: "12:00" }]);
  });

  it("ignores a timed mission whose window is unusable", () => {
    expect(
      missionExcusal([m({ missionType: "timed", startTime: null, endTime: null })]).windows,
    ).toHaveLength(0);
    expect(
      missionExcusal([m({ missionType: "timed", startTime: "12:00", endTime: "08:00" })]).windows,
    ).toHaveLength(0);
  });

  it("collects several windows sorted by start", () => {
    const e = missionExcusal([
      m({ missionType: "timed", startTime: "13:00", endTime: "15:00" }),
      m({ missionType: "timed", startTime: "08:00", endTime: "10:00" }),
    ]);
    expect(e.windows.map((w) => w.startTime)).toEqual(["08:00", "13:00"]);
  });

  it("a full-day mission wins over timed ones on the same day", () => {
    const e = missionExcusal([
      m({ missionType: "timed", startTime: "08:00", endTime: "10:00" }),
      m({ missionType: "full_day" }),
    ]);
    expect(e.fullDay).toBe(true);
  });
});

describe("isFullDayMission / approvedWindow", () => {
  it("only an approved full-day mission counts as full day", () => {
    expect(isFullDayMission(m())).toBe(true);
    expect(isFullDayMission(m({ status: "pending" }))).toBe(false);
    expect(isFullDayMission(m({ missionType: "timed" }))).toBe(false);
  });

  it("returns null for a non-approved or full-day mission", () => {
    expect(approvedWindow(m())).toBeNull();
    expect(approvedWindow(m({ status: "cancelled" }))).toBeNull();
    expect(
      approvedWindow(
        m({ missionType: "timed", status: "pending", startTime: "08:00", endTime: "09:00" }),
      ),
    ).toBeNull();
  });
});

describe("withinMissionWindow", () => {
  const windows = missionExcusal([
    m({ missionType: "timed", startTime: "08:00", endTime: "12:00" }),
  ]).windows;

  it("accepts a punch inside the window", () => {
    expect(withinMissionWindow(windows, toMinutes("08:00"))).toBe(true);
    expect(withinMissionWindow(windows, toMinutes("10:30"))).toBe(true);
    expect(withinMissionWindow(windows, toMinutes("12:00"))).toBe(true);
  });

  it("rejects a punch outside the window", () => {
    expect(withinMissionWindow(windows, toMinutes("07:59"))).toBe(false);
    expect(withinMissionWindow(windows, toMinutes("12:01"))).toBe(false);
  });

  it("never covers anything when there are no windows", () => {
    expect(withinMissionWindow([], toMinutes("10:00"))).toBe(false);
  });
});

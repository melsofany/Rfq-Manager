import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  hrLeaveTypesTable: {},
  hrLeaveRequestsTable: {},
  hrEmployeesTable: {},
  hrAttendanceDevicesTable: {},
  hrAttendancePunchesTable: {},
  employeesTable: {},
}));
vi.mock("../shared/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  inclusiveDays,
  rangesOverlap,
  remainingBalance,
  isValidYmd,
  daysInYear,
} from "../modules/hr/leave-logic";

describe("leave day counting", () => {
  it("counts both ends inclusively", () => {
    expect(inclusiveDays("2026-10-15", "2026-10-15")).toBe(1);
    expect(inclusiveDays("2026-10-15", "2026-10-17")).toBe(3);
  });
  it("crosses month and year boundaries", () => {
    expect(inclusiveDays("2026-12-30", "2027-01-02")).toBe(4);
    expect(inclusiveDays("2024-02-28", "2024-03-01")).toBe(3); // leap year
  });
  it("returns 0 when end is before start", () => {
    expect(inclusiveDays("2026-10-17", "2026-10-15")).toBe(0);
  });
});

describe("overlap", () => {
  it("detects overlapping and touching ranges", () => {
    expect(rangesOverlap("2026-10-10", "2026-10-15", "2026-10-15", "2026-10-20")).toBe(true);
    expect(rangesOverlap("2026-10-10", "2026-10-14", "2026-10-15", "2026-10-20")).toBe(false);
  });
});

describe("balance", () => {
  it("never goes negative", () => {
    expect(remainingBalance(21, 5)).toBe(16);
    expect(remainingBalance(21, 25)).toBe(0);
  });
});

describe("date validation", () => {
  it("rejects impossible dates", () => {
    expect(isValidYmd("2026-02-30")).toBe(false);
    expect(isValidYmd("2026-02-28")).toBe(true);
    expect(isValidYmd("2026-1-5")).toBe(false);
  });
});

describe("days inside a year", () => {
  it("splits a request across two years", () => {
    expect(daysInYear("2026-12-29", "2027-01-03", 2026)).toBe(3);
    expect(daysInYear("2026-12-29", "2027-01-03", 2027)).toBe(3);
  });
});

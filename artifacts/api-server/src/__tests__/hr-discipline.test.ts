import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  hrEmployeesTable: {},
  hrDisciplinaryCasesTable: {},
  hrCaseNotesTable: {},
  hrPayAdjustmentsTable: {},
  hrLeaveTypesTable: {},
  hrLeaveRequestsTable: {},
  hrAttendanceDevicesTable: {},
  hrAttendancePunchesTable: {},
  employeesTable: {},
}));
vi.mock("../shared/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { canTransition, isValidPeriod, parseMoney } from "../modules/hr/discipline-logic";

describe("case status transitions", () => {
  it("follows open → investigation → decided → closed", () => {
    expect(canTransition("open", "investigation")).toBe(true);
    expect(canTransition("investigation", "decided")).toBe(true);
    expect(canTransition("decided", "closed")).toBe(true);
  });
  it("blocks skipping back or reopening", () => {
    expect(canTransition("decided", "open")).toBe(false);
    expect(canTransition("closed", "open")).toBe(false);
    expect(canTransition("investigation", "open")).toBe(false);
  });
  it("rejects unknown statuses", () => {
    expect(canTransition("bogus", "closed")).toBe(false);
  });
});

describe("pay period", () => {
  it("accepts YYYY-MM only", () => {
    expect(isValidPeriod("2026-10")).toBe(true);
    expect(isValidPeriod("2026-13")).toBe(false);
    expect(isValidPeriod("2026-1")).toBe(false);
  });
});

describe("money parsing", () => {
  it("accepts up to two decimals", () => {
    expect(parseMoney("150.5")).toBe(150.5);
    expect(parseMoney(20)).toBe(20);
  });
  it("rejects negatives, junk and >2 decimals", () => {
    expect(parseMoney("-5")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("1.234")).toBeNull();
    expect(parseMoney("")).toBeNull();
  });
});

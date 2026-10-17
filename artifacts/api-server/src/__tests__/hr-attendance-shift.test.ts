import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => {
  const state = {
    /** Rows returned for the `work_shift` settings lookup. */
    settingRows: [] as Record<string, unknown>[],
    /** Punches returned for the day. */
    punchRows: [] as Record<string, unknown>[],
    /** Approved missions returned for the day. */
    missionRows: [] as Record<string, unknown>[],
    /** Per-employee attendance exceptions. */
    exceptionRows: [] as Record<string, unknown>[],
    /** Which table the current select is reading from. */
    table: "",
  };
  return { state };
});

vi.mock("@workspace/db", () => {
  const table = (name: string) => ({ __table: name });
  const employeesTable = table("employees");
  const hrEmployeesTable = table("hrEmployees");
  const hrSettingsTable = table("hrSettings");
  const hrAttendancePunchesTable = table("punches");
  const hrAttendanceDevicesTable = table("devices");
  return {
    employeesTable,
    hrEmployeesTable,
    hrSettingsTable,
    hrAttendancePunchesTable,
    hrAttendanceDevicesTable,
    hrLeaveRequestsTable: table("leaveRequests"),
    hrLeaveTypesTable: table("leaveTypes"),
    hrMissionsTable: table("missions"),
    hrAttendanceExceptionsTable: table("attendanceExceptions"),
    db: {
      select: () => ({
        from: (t: { __table: string }) => {
          H.state.table = t.__table;
          const rowsFor = () => {
            if (t.__table === "hrSettings") return H.state.settingRows;
            if (t.__table === "punches") return H.state.punchRows;
            if (t.__table === "missions") return H.state.missionRows;
            if (t.__table === "attendanceExceptions") return H.state.exceptionRows;
            if (t.__table === "employees")
              return [{ role: "admin", permissions: null, isActive: true }];
            if (t.__table === "hrEmployees")
              return [
                {
                  id: 1,
                  employeeNo: "24940001",
                  fullName: "Ahmed",
                  department: null,
                  biometricPin: "24940001",
                  status: "active",
                },
              ];
            return [];
          };
          const chain: Record<string, unknown> = {};
          const self = () => chain;
          chain.where = self;
          chain.orderBy = self;
          chain.innerJoin = self;
          chain.limit = async () => rowsFor();
          chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(rowsFor()).then(resolve, reject);
          return chain;
        },
      }),
    },
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ __and: a }),
  eq: (col: unknown, value: unknown) => ({ __eq: [col, value] }),
  gte: (col: unknown, value: unknown) => ({ __gte: [col, value] }),
  lt: (col: unknown, value: unknown) => ({ __lt: [col, value] }),
  lte: (col: unknown, value: unknown) => ({ __lte: [col, value] }),
  inArray: (col: unknown, values: unknown) => ({ __inArray: [col, values] }),
  desc: (col: unknown) => ({ __desc: col }),
  asc: (col: unknown) => ({ __asc: col }),
}));

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: { session?: unknown }, _res: unknown, next: () => void) => {
    req.session = { employeeId: 1, role: "admin" };
    next();
  },
}));

vi.mock("../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import router from "../modules/hr/routes";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: unknown }).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  next();
});
app.use("/api", router);

beforeEach(() => {
  H.state.settingRows = [];
  H.state.punchRows = [];
  H.state.missionRows = [];
  H.state.exceptionRows = [];
});

describe("attendance shift start from HR settings", () => {
  it("uses the configured work_shift start when the query omits one", async () => {
    H.state.settingRows = [
      { key: "work_shift", value: { start: "08:00", end: "16:00", lateGraceMinutes: 0 } },
    ];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.status).toBe(200);
    expect(res.body.shiftStart).toBe("08:00");
  });

  it("falls back to 09:00 when work_shift is not configured", async () => {
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.status).toBe(200);
    expect(res.body.shiftStart).toBe("09:00");
  });

  it("lets an explicit query parameter override the configured shift", async () => {
    H.state.settingRows = [
      { key: "work_shift", value: { start: "08:00", end: "16:00", lateGraceMinutes: 0 } },
    ];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16&shiftStart=10:00");
    expect(res.status).toBe(200);
    expect(res.body.shiftStart).toBe("10:00");
  });

  it("subtracts the configured grace period from late minutes", async () => {
    H.state.settingRows = [
      { key: "work_shift", value: { start: "09:00", end: "17:00", lateGraceMinutes: 15 } },
    ];
    // 09:10 arrival is 10 minutes after 09:00 — inside the 15-minute grace.
    H.state.punchRows = [{ pin: "24940001", punchedAt: "2026-10-16 09:10:00" }];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.status).toBe(200);
    expect(res.body.lateGraceMinutes).toBe(15);
    expect(res.body.rows[0].lateMinutes).toBe(0);
  });

  it("reports late minutes beyond the grace period", async () => {
    H.state.settingRows = [
      { key: "work_shift", value: { start: "09:00", end: "17:00", lateGraceMinutes: 15 } },
    ];
    H.state.punchRows = [{ pin: "24940001", punchedAt: "2026-10-16 09:40:00" }];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.status).toBe(200);
    expect(res.body.rows[0].lateMinutes).toBe(25);
  });

  it("ignores a malformed stored start and keeps the 09:00 fallback", async () => {
    H.state.settingRows = [{ key: "work_shift", value: { start: "not-a-time" } }];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.status).toBe(200);
    expect(res.body.shiftStart).toBe("09:00");
  });
});

describe("attendance with missions (مأموريات)", () => {
  it("does NOT report an employee absent when a full-day mission is approved", async () => {
    // The reported problem: sent to the bank at 08:00, no punch → absent.
    H.state.missionRows = [
      {
        id: 1,
        employeeId: 1,
        missionDate: "2026-10-16",
        missionType: "full_day",
        status: "approved",
      },
    ];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.status).toBe(200);
    expect(res.body.rows[0].absent).toBe(false);
    expect(res.body.rows[0].onMission).toBe(true);
    expect(res.body.rows[0].missionFullDay).toBe(true);
    expect(res.body.totals.absent).toBe(0);
    expect(res.body.totals.onMission).toBe(1);
  });

  it("still reports absence when the mission is only pending (manager has not approved)", async () => {
    H.state.missionRows = [];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.status).toBe(200);
    expect(res.body.rows[0].absent).toBe(true);
    expect(res.body.rows[0].onMission).toBe(false);
  });

  it("excuses lateness for a punch inside an approved timed window", async () => {
    // Shift 09:00, grace 0. A 10:00 punch is normally 60 minutes late, but the
    // employee was on a mission from 08:00 to 12:00.
    H.state.settingRows = [
      { key: "work_shift", value: { start: "09:00", end: "17:00", lateGraceMinutes: 0 } },
    ];
    H.state.punchRows = [{ pin: "24940001", punchedAt: "2026-10-16 10:00:00" }];
    H.state.missionRows = [
      {
        id: 2,
        employeeId: 1,
        missionDate: "2026-10-16",
        missionType: "timed",
        startTime: "08:00",
        endTime: "12:00",
        status: "approved",
      },
    ];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.status).toBe(200);
    expect(res.body.rows[0].lateMinutes).toBe(0);
    expect(res.body.rows[0].onMission).toBe(true);
    expect(res.body.rows[0].missionFullDay).toBe(false);
    expect(res.body.rows[0].missionWindows).toEqual(["08:00-12:00"]);
  });

  it("still counts lateness for a punch outside the timed window", async () => {
    H.state.settingRows = [
      { key: "work_shift", value: { start: "09:00", end: "17:00", lateGraceMinutes: 0 } },
    ];
    H.state.punchRows = [{ pin: "24940001", punchedAt: "2026-10-16 13:00:00" }];
    H.state.missionRows = [
      {
        id: 3,
        employeeId: 1,
        missionDate: "2026-10-16",
        missionType: "timed",
        startTime: "08:00",
        endTime: "12:00",
        status: "approved",
      },
    ];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.status).toBe(200);
    // 13:00 vs 09:00 = 240 minutes, outside the 08:00-12:00 mission window.
    expect(res.body.rows[0].lateMinutes).toBe(240);
  });

  it("keeps a timed mission with no punch absent, but flags the mission", async () => {
    H.state.missionRows = [
      {
        id: 4,
        employeeId: 1,
        missionDate: "2026-10-16",
        missionType: "timed",
        startTime: "08:00",
        endTime: "12:00",
        status: "approved",
      },
    ];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.status).toBe(200);
    // A timed mission excuses a WINDOW, not the day: with no punch at all there
    // is no evidence the employee was ever on site, so the absence stands — but
    // the flag tells HR the mission explains why, so it is not read as a no-show.
    expect(res.body.rows[0].absent).toBe(true);
    expect(res.body.rows[0].onMission).toBe(true);
    expect(res.body.rows[0].missingPunchWarning).toBe(true);
  });
});

describe("per-employee attendance exceptions (استثناءات الحضور)", () => {
  it("counts a punch at 11:00 as NOT late when the employee's start is 11:00", async () => {
    // The reported request: shift 08:00, but this employee may punch at 11:00
    // with no lateness.
    H.state.settingRows = [
      { key: "work_shift", value: { start: "08:00", end: "16:00", lateGraceMinutes: 0 } },
    ];
    H.state.punchRows = [{ pin: "24940001", punchedAt: "2026-10-16 11:00:00" }];
    H.state.exceptionRows = [
      {
        employeeId: 1,
        startTime: "11:00",
        lateGraceMinutes: null,
        exemptFromPunch: false,
        isActive: true,
      },
    ];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.status).toBe(200);
    expect(res.body.rows[0].lateMinutes).toBe(0);
    expect(res.body.rows[0].shiftStart).toBe("11:00");
    expect(res.body.rows[0].hasException).toBe(true);
  });

  it("still counts lateness against the employee's own start", async () => {
    H.state.settingRows = [
      { key: "work_shift", value: { start: "08:00", end: "16:00", lateGraceMinutes: 0 } },
    ];
    H.state.punchRows = [{ pin: "24940001", punchedAt: "2026-10-16 11:30:00" }];
    H.state.exceptionRows = [
      {
        employeeId: 1,
        startTime: "11:00",
        lateGraceMinutes: null,
        exemptFromPunch: false,
        isActive: true,
      },
    ];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.body.rows[0].lateMinutes).toBe(30);
  });

  it("treats the day as normal when the employee is exempt from punching", async () => {
    // The second half of the request: allow the employee not to punch at all
    // and still count a normal day.
    H.state.settingRows = [
      { key: "work_shift", value: { start: "08:00", end: "16:00", lateGraceMinutes: 0 } },
    ];
    H.state.exceptionRows = [
      {
        employeeId: 1,
        startTime: null,
        lateGraceMinutes: null,
        exemptFromPunch: true,
        isActive: true,
      },
    ];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.status).toBe(200);
    expect(res.body.rows[0].absent).toBe(false);
    expect(res.body.rows[0].exemptFromPunch).toBe(true);
    expect(res.body.totals.absent).toBe(0);
  });

  it("does NOT apply an exception belonging to another employee", async () => {
    H.state.settingRows = [
      { key: "work_shift", value: { start: "08:00", end: "16:00", lateGraceMinutes: 0 } },
    ];
    H.state.punchRows = [{ pin: "24940001", punchedAt: "2026-10-16 11:00:00" }];
    // Exception is for employee 99, not the punching employee 1.
    H.state.exceptionRows = [
      {
        employeeId: 99,
        startTime: "11:00",
        lateGraceMinutes: null,
        exemptFromPunch: true,
        isActive: true,
      },
    ];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.body.rows[0].lateMinutes).toBe(180);
    expect(res.body.rows[0].exemptFromPunch).toBe(false);
    expect(res.body.rows[0].hasException).toBe(false);
  });

  it("ignores a disabled exception", async () => {
    H.state.settingRows = [
      { key: "work_shift", value: { start: "08:00", end: "16:00", lateGraceMinutes: 0 } },
    ];
    H.state.punchRows = [{ pin: "24940001", punchedAt: "2026-10-16 11:00:00" }];
    H.state.exceptionRows = [
      {
        employeeId: 1,
        startTime: "11:00",
        lateGraceMinutes: null,
        exemptFromPunch: true,
        isActive: false,
      },
    ];
    const res = await request(app).get("/api/hr/attendance?date=2026-10-16");
    expect(res.body.rows[0].lateMinutes).toBe(180);
    expect(res.body.rows[0].absent).toBe(false);
  });
});

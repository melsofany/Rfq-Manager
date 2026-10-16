import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => {
  const state = {
    /** Rows returned for the `work_shift` settings lookup. */
    settingRows: [] as Record<string, unknown>[],
    /** Punches returned for the day. */
    punchRows: [] as Record<string, unknown>[],
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
    db: {
      select: () => ({
        from: (t: { __table: string }) => {
          H.state.table = t.__table;
          const rowsFor = () => {
            if (t.__table === "hrSettings") return H.state.settingRows;
            if (t.__table === "punches") return H.state.punchRows;
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

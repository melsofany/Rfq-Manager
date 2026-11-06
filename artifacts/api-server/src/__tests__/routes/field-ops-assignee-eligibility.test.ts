/**
 * The control page must never hand a task to somebody the app will not show it
 * to. Employment status and mobile access are separate switches: an operator can
 * keep an HR record active while cutting the app off (lost phone, long leave),
 * and login already refuses such an account. Assigning to it would create work
 * nobody can open, so `resolveAssignee` refuses it too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../shared/permissions", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

const notifyMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../modules/field-ops/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../modules/field-ops/service")>();
  return {
    ...actual,
    notify: notifyMock,
    loadFieldOpsSettings: vi.fn(async () => actual.FIELD_OPS_DEFAULT_SETTINGS),
  };
});

const tables = {
  workOrderAssignmentsTable: { _: "woa" },
  hrEmployeesTable: { _: "hrEmployees" },
  hrFieldAssignmentsTable: { _: "hrFieldAssignments" },
  hrSettingsTable: { _: "hrSettings" },
  purchaseOrdersTable: { _: "po" },
  purchaseOrderItemsTable: { _: "poItems" },
  suppliersTable: { _: "suppliers" },
  customerPosTable: { _: "customerPos" },
  auditLogTable: { _: "audit" },
  mobileSessionsTable: { _: "mobileSessions" },
};

let selectQueue: any[] = [];

function chainable(rows: any): any {
  const api: any = {
    from: vi.fn(() => api),
    leftJoin: vi.fn(() => api),
    innerJoin: vi.fn(() => api),
    where: vi.fn(() => chainable(rows)),
    limit: vi.fn(() => chainable(rows)),
    orderBy: vi.fn(() => chainable(rows)),
    then: (resolve: any) => Promise.resolve(rows).then(resolve),
  };
  return api;
}

const updateCalls: any[] = [];

const dbMock: any = {
  select: vi.fn(() => chainable(selectQueue.shift() ?? [])),
  update: vi.fn(() => {
    const set = vi.fn((vals: any) => {
      const where = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 1 }])) }));
      updateCalls.push({ vals });
      return { where };
    });
    return { set };
  }),
  insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve(undefined)) })),
  transaction: vi.fn(async (cb: any) => cb(dbMock)),
};

vi.mock("@workspace/db", () => ({
  ...tables,
  db: dbMock,
  FIELD_ASSIGNMENT_STATUS: { ACTIVE: "active" },
  WORK_ORDER_KIND: { RECEIPT: "receipt", DELIVERY: "delivery" },
}));

let testApp: express.Express;

async function buildApp() {
  const { default: controlRouter } = await import("../../modules/field-ops/control-routes");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { employeeId: 1, role: "admin" };
    next();
  });
  app.use("/api", controlRouter);
  return app;
}

const TASK_ROW = { id: 5, poId: 1, kind: "receipt", status: "sent" };

beforeEach(async () => {
  vi.clearAllMocks();
  selectQueue = [];
  updateCalls.length = 0;
  if (!testApp) testApp = await buildApp();
});

describe("POST /api/hr/field-ops/tasks/:id/assign — assignee eligibility", () => {
  it("refuses an active employee whose mobile access is disabled", async () => {
    selectQueue = [
      [TASK_ROW],
      [
        {
          id: 9,
          fullName: "موقوف",
          employeeNo: "E-9",
          status: "active",
          mobileAccessEnabled: false,
        },
      ],
    ];

    const res = await request(testApp)
      .post("/api/hr/field-ops/tasks/5/assign")
      .send({ hrEmployeeId: 9 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("موقوف");
    // Nothing was written and nobody was notified.
    expect(updateCalls).toHaveLength(0);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("refuses an inactive employee", async () => {
    selectQueue = [
      [TASK_ROW],
      [
        {
          id: 9,
          fullName: "منتهي",
          employeeNo: "E-9",
          status: "resigned",
          mobileAccessEnabled: true,
        },
      ],
    ];

    const res = await request(testApp)
      .post("/api/hr/field-ops/tasks/5/assign")
      .send({ hrEmployeeId: 9 });

    expect(res.status).toBe(400);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("refuses an employee who is not an active field representative", async () => {
    selectQueue = [
      [TASK_ROW],
      [
        {
          id: 9,
          fullName: "غير مندوب",
          employeeNo: "E-9",
          status: "active",
          mobileAccessEnabled: true,
        },
      ],
      [], // no active field assignment
    ];

    const res = await request(testApp)
      .post("/api/hr/field-ops/tasks/5/assign")
      .send({ hrEmployeeId: 9 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("مندوب");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("assigns to an active representative whose mobile access is enabled", async () => {
    selectQueue = [
      [TASK_ROW],
      [
        {
          id: 9,
          fullName: "مندوب سليم",
          employeeNo: "E-9",
          status: "active",
          mobileAccessEnabled: true,
        },
      ],
      [{ id: 77 }], // active field assignment
    ];

    const res = await request(testApp)
      .post("/api/hr/field-ops/tasks/5/assign")
      .send({ hrEmployeeId: 9 });

    expect(res.status).toBe(200);
    expect(res.body.assignedTo).toBe(9);
    expect(updateCalls[0].vals.hrEmployeeId).toBe(9);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(9, expect.objectContaining({ kind: "task_assigned" }));
  });
});

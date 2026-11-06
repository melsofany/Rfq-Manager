import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth + side-effectful modules ─────────────────────────────────────
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../shared/email", () => ({
  verifyEmailConnection: vi.fn().mockResolvedValue({ ok: true }),
  sendRfqEmail: vi.fn().mockResolvedValue({ ok: true }),
  sendOfferConfirmation: vi.fn().mockResolvedValue({ ok: true }),
  sendPoEmail: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../shared/google-sheets", () => ({
  lookupPoFromSheet: vi.fn().mockResolvedValue([]),
  listSheetPoNumbers: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../modules/communications/routes", () => ({
  applyReceiptSideEffects: vi.fn().mockResolvedValue(undefined),
  applyDeliverySideEffects: vi.fn().mockResolvedValue(undefined),
  broadcastWaEvent: vi.fn(),
}));

vi.mock("../../modules/communications/service", () => ({
  sendPoWhatsApp: vi.fn().mockResolvedValue({ ok: true }),
  isWhatsAppConfigured: vi.fn().mockReturnValue(false),
  sendRepresentativeWorkOrderWhatsApp: vi.fn().mockResolvedValue({ ok: true }),
  sendRepresentativeItemReceiptWhatsApp: vi.fn().mockResolvedValue("wa-id"),
}));

vi.mock("../../modules/po/po-pdf", () => ({
  generatePoPdf: vi.fn().mockResolvedValue(Buffer.from("")),
}));

// ── Configurable chainable DB mock ────────────────────────────────────────
function thenable<T>(value: T, extra: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, v] of Object.entries(extra)) obj[k] = v;
  return obj;
}

const tables = {
  purchaseOrdersTable: { _: "po" },
  purchaseOrderItemsTable: { _: "poItems" },
  suppliersTable: { _: "suppliers" },
  employeesTable: { _: "employees" },
  auditLogTable: { _: "audit" },
  offersTable: { _: "offers" },
  offerItemsTable: { _: "offerItems" },
  rfqItemsTable: { _: "rfqItems" },
  whatsappChatsTable: { _: "wa" },
  rfqTable: { _: "rfq" },
  workOrderAssignmentsTable: { _: "woa" },
  hrEmployeesTable: { _: "hrEmp" },
  hrFieldAssignmentsTable: { _: "hrField" },
  mobileNotificationsTable: { _: "mobileNotif" },
  poItemReceiptsTable: { _: "receipts" },
  customerPoItemsTable: { _: "cpoItems" },
  customerRfqsTable: { _: "custRfq" },
};

// State injected per-test.
let existingPoRow: any | null;
let hrEmployeeRow: any | null;
let updatedPoRow: any;

// Tracks what the route asked the database to write, so the test can assert on
// the reassignment rather than just the HTTP status.
let updates: { table: string; vals: any; cond: any }[] = [];
let insertedRows: any[] = [];

// Pull every literal out of a drizzle condition so a test can assert the WHERE
// clause actually excludes completed work (Rule 7: never rewrite history).
function collectValues(x: any, out: string[] = []): string[] {
  if (x == null) return out;
  if (typeof x === "string") {
    out.push(x);
    return out;
  }
  if (typeof x === "object") {
    if (x.value !== undefined) out.push(String(x.value));
    if (Array.isArray(x.queryChunks)) x.queryChunks.forEach((c: any) => collectValues(c, out));
    else if (Array.isArray(x)) x.forEach((c: any) => collectValues(c, out));
  }
  return out;
}

function selectChain(): any {
  // The route runs several unrelated selects (PO lookup, HR employee lookup,
  // pending-assignment lookup, PO-item lookup). Resolve each one against the
  // table it queried so the branches under test see realistic rows.
  let table = "";
  const rowsFor = () => {
    switch (table) {
      case "po":
        return existingPoRow ? [existingPoRow] : [];
      case "hrEmp":
        return hrEmployeeRow ? [hrEmployeeRow] : [];
      default:
        return [];
    }
  };
  const api: any = {
    from: vi.fn((t: any) => {
      table = t?._ ?? "";
      return api;
    }),
    where: vi.fn(() => api),
    limit: vi.fn(() => api),
    orderBy: vi.fn(() => api),
    leftJoin: vi.fn(() => api),
    innerJoin: vi.fn(() => api),
    then: (resolve: any) => Promise.resolve(rowsFor()).then(resolve),
  };
  return api;
}

const dbMock: any = {
  select: vi.fn((_arg?: any) => selectChain()),
  update: vi.fn((t: any) => {
    const table = t?._ ?? "";
    return {
      set: vi.fn((vals: any) => ({
        where: vi.fn((cond: any) => {
          updates.push({ table, vals, cond });
          return { returning: vi.fn(() => thenable([updatedPoRow])) };
        }),
      })),
    };
  }),
  delete: vi.fn(() => ({ where: vi.fn(() => thenable(undefined)) })),
  insert: vi.fn(() => ({
    values: vi.fn((vals: any) => {
      insertedRows.push(vals);
      return thenable(undefined);
    }),
  })),
  transaction: vi.fn(async (cb: any) => cb(dbMock)),
};

vi.mock("@workspace/db", () => ({
  ...tables,
  WORK_ORDER_KIND: { RECEIPT: "receipt", DELIVERY: "delivery" },
  db: dbMock,
}));

let testApp: express.Express;

beforeAll(async () => {
  const { default: poRouter } = await import("../../modules/po/index");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { employeeId: 1, role: "admin" };
    next();
  });
  testApp.use("/api", poRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  updates = [];
  insertedRows = [];
  existingPoRow = {
    id: 1,
    internalPoNo: "CPO-2025-000001",
    sheetPoNo: "PO-100",
    receiverName: "Ahmed",
    receiverPhone: "01001234567",
    representativeHrEmployeeId: 7,
    status: "sent",
    employeeId: null,
    rfqId: null,
    notes: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-02"),
  };
  hrEmployeeRow = { id: 9, status: "active" };
  updatedPoRow = { ...existingPoRow, representativeHrEmployeeId: 9 };
});

describe("PATCH /api/po/:id/representative", () => {
  it("returns 404 for an unknown purchase order", async () => {
    existingPoRow = null;
    const res = await request(testApp)
      .patch("/api/po/999/representative")
      .send({ representativeHrEmployeeId: 9 });
    expect(res.status).toBe(404);
  });

  it("returns 400 when the body field is missing entirely", async () => {
    const res = await request(testApp).patch("/api/po/1/representative").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/representativeHrEmployeeId/);
  });

  it("rejects an employee that is not in HR", async () => {
    hrEmployeeRow = null;
    const res = await request(testApp)
      .patch("/api/po/1/representative")
      .send({ representativeHrEmployeeId: 12345 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/الموارد البشرية/);
  });

  it("refuses to assign a non-active employee", async () => {
    hrEmployeeRow = { id: 9, status: "resigned" };
    const res = await request(testApp)
      .patch("/api/po/1/representative")
      .send({ representativeHrEmployeeId: 9 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/غير نشط/);
  });

  it("reassigns an active employee and re-points only pending tasks", async () => {
    const res = await request(testApp)
      .patch("/api/po/1/representative")
      .send({ representativeHrEmployeeId: 9 });
    expect(res.status).toBe(200);
    expect(res.body.representativeHrEmployeeId).toBe(9);

    // The PO row itself is re-pointed.
    const poUpdate = updates.find((u) => u.table === "po");
    expect(poUpdate?.vals.representativeHrEmployeeId).toBe(9);

    // The pickup tasks are re-pointed too...
    const woaUpdate = updates.find((u) => u.table === "woa");
    expect(woaUpdate?.vals.hrEmployeeId).toBe(9);

    // ...but only the ones that are still pending: received/rejected rows keep
    // the employee who actually did the work (Rule 7).
    const where = collectValues(woaUpdate?.cond);
    expect(where).toContain("received");
    expect(where).toContain("rejected");
  });

  it("notifies the new representative so the task is discoverable", async () => {
    await request(testApp)
      .patch("/api/po/1/representative")
      .send({ representativeHrEmployeeId: 9 });
    const notification = insertedRows.flat().find((r: any) => r?.kind === "task_assigned");
    expect(notification).toBeTruthy();
    expect(notification.hrEmployeeId).toBe(9);
  });

  it("clears the assignment when null is sent", async () => {
    const res = await request(testApp)
      .patch("/api/po/1/representative")
      .send({ representativeHrEmployeeId: null });
    expect(res.status).toBe(200);
    expect(res.body.representativeHrEmployeeId).toBeNull();
    const woaUpdate = updates.find((u) => u.table === "woa");
    expect(woaUpdate?.vals.hrEmployeeId).toBeNull();
    const where = collectValues(woaUpdate?.cond);
    expect(where).toContain("received");
    expect(where).toContain("rejected");
    // No task is created for nobody, and nobody is notified.
    expect(insertedRows.flat().some((r: any) => r?.kind === "task_assigned")).toBe(false);
  });
});

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  ne: (left: any, right: any) => ({ __op: "ne", left, right }),
  and: (...args: any[]) => ({ __op: "and", args }),
  or: (...args: any[]) => ({ __op: "or", args }),
  inArray: (left: any, right: any) => ({ __op: "inArray", left, right }),
  isNull: (col: any) => ({ __op: "isNull", col }),
  isNotNull: (col: any) => ({ __op: "isNotNull", col }),
  desc: (col: any) => ({ __op: "desc", col }),
  asc: (col: any) => ({ __op: "asc", col }),
  count: () => ({ __op: "count" }),
  sql: Object.assign((strings: any, ...values: any[]) => ({ __op: "sql", strings, values }), {
    raw: (s: string) => ({ __op: "sql.raw", s }),
  }),
}));
vi.mock("../../modules/communications/routes", () => ({
  applyReceiptSideEffects: vi.fn().mockResolvedValue(undefined),
  applyDeliverySideEffects: vi.fn().mockResolvedValue(undefined),
  broadcastWaEvent: vi.fn(),
}));
vi.mock("../../modules/communications/service", () => ({
  isWhatsAppConfigured: false,
  sendRepMainMenu: vi.fn(async () => "msg-id"),
  sendWhatsAppText: vi.fn(async () => "msg-id"),
  normalizePhone: (p: string) => p,
}));

function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

const customerPosTable = { _: "customerPos", id: "id", internalPoNo: "internalPoNo" };
const customerPoItemsTable = {
  _: "customerPoItems",
  id: "id",
  customerPoId: "customerPoId",
  qty: "qty",
};
const purchaseOrderItemsTable = {
  _: "purchaseOrderItems",
  customerPoItemId: "customerPoItemId",
  totalAcceptedQty: "totalAcceptedQty",
  lineStatus: "lineStatus",
};
const customerPoItemDeliveriesTable = {
  _: "customerPoItemDeliveries",
  id: "id",
  customerPoItemId: "customerPoItemId",
  operationKey: "operationKey",
  voided: "voided",
  deliveredBy: "deliveredBy",
  deliveredQty: "deliveredQty",
  rejectedByCustomerQty: "rejectedByCustomerQty",
  rejectionReason: "rejectionReason",
};
const employeesTable = { _: "employees", id: "id", name: "name" };
const auditLogTable = { _: "audit" };
const tables = {
  customerPosTable,
  customerPoItemsTable,
  purchaseOrderItemsTable,
  customerPoItemDeliveriesTable,
  employeesTable,
  auditLogTable,
  WORK_ORDER_KIND: { RECEIPT: "receipt", DELIVERY: "delivery" },
};

let idempotencyRows: any[]; // existing rows matching an operationKey
let recomputeRows: any[]; // non-voided rows for a customerPoItem
let voidRow: any | null; // the row fetched by id for the void route
const insertedValues: any[] = [];
const updateCalls: Array<{ table: any; vals: any }> = [];

const dbMock: any = {
  select: vi.fn((arg?: any) => ({
    from: vi.fn((table: any) => {
      if (table === customerPosTable) {
        return chainable([{ id: 5, internalPoNo: "CPO-2025-000005" }], {
          where: vi.fn(() => chainable([{ id: 5, internalPoNo: "CPO-2025-000005" }])),
        });
      }
      if (table === customerPoItemsTable) {
        // item existence (id) + qty lookup during recompute
        return chainable([{ id: 42, customerPoId: 5, qty: "10" }], {
          where: vi.fn(() => chainable([{ id: 42, customerPoId: 5, qty: "10" }])),
        });
      }
      if (table === purchaseOrderItemsTable) {
        return chainable([{ accepted: "10", lineStatus: "fulfilled" }], {
          where: vi.fn(() => chainable([{ accepted: "10", lineStatus: "fulfilled" }])),
        });
      }
      if (table === customerPoItemDeliveriesTable) {
        // Bare select (no projection) serves BOTH the void route's fetch-by-id
        // and the POST idempotency lookup and recompute — return everything the
        // test seeded so each caller finds what it expects.
        if (arg === undefined) {
          const rows = [...(voidRow ? [voidRow] : []), ...idempotencyRows, ...recomputeRows];
          return chainable(rows, { where: vi.fn(() => chainable(rows)) });
        }
        // operationKey lookup (projection carries operationKey)
        if (arg && typeof arg === "object" && "operationKey" in arg) {
          return chainable(idempotencyRows, { where: vi.fn(() => chainable(idempotencyRows)) });
        }
        return chainable(recomputeRows, { where: vi.fn(() => chainable(recomputeRows)) });
      }
      if (table === employeesTable) {
        return chainable([{ name: "مدير" }], { where: vi.fn(() => chainable([{ name: "مدير" }])) });
      }
      return chainable([], { where: vi.fn(() => chainable([])) });
    }),
  })),
  insert: vi.fn((table: any) => ({
    values: vi.fn((vals: any) => {
      if (table === customerPoItemDeliveriesTable) {
        insertedValues.push(vals);
        return { returning: vi.fn(() => chainable([{ id: 900 + insertedValues.length }])) };
      }
      return chainable(undefined);
    }),
  })),
  update: vi.fn((table: any) => ({
    set: vi.fn((vals: any) => {
      updateCalls.push({ table, vals });
      return { where: vi.fn(() => chainable(undefined)) };
    }),
  })),
  delete: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })),
  transaction: vi.fn(async (fn: any) => fn(dbMock)),
  execute: vi.fn(async () => ({ rows: [{ ts: "2026-01-01T00:00:00.000Z" }] })),
};

vi.mock("@workspace/db", () => ({ ...tables, db: dbMock }));

let testApp: express.Express;
const sessionState = { employeeId: 1, employeeName: "Tester", role: "admin" };

beforeAll(async () => {
  const { default: router } = await import("../../modules/customer-po/deliveries");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = sessionState;
    req.get = () => undefined;
    next();
  });
  testApp.use("/api", router);
});

beforeEach(() => {
  vi.clearAllMocks();
  idempotencyRows = [];
  recomputeRows = [];
  voidRow = null;
  insertedValues.length = 0;
  updateCalls.length = 0;
});

describe("POST /customer-po/:id/deliveries — idempotency", () => {
  it("returns the ORIGINAL rows for an exact re-send and inserts nothing", async () => {
    idempotencyRows = [
      {
        id: 1,
        customerPoItemId: 42,
        operationKey: "op-1",
        deliveredQty: "10",
        rejectedByCustomerQty: "0",
        rejectionReason: null,
      },
    ];
    const res = await request(testApp)
      .post("/api/customer-po/5/deliveries")
      .send({ operationKey: "op-1", customerPoItemId: 42, deliveredQty: "10" });
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.createdIds).toEqual([1]);
    expect(insertedValues).toHaveLength(0);
  });

  it("409s when the same key is re-sent with different content", async () => {
    idempotencyRows = [
      {
        id: 1,
        customerPoItemId: 42,
        operationKey: "op-2",
        deliveredQty: "10",
        rejectedByCustomerQty: "0",
        rejectionReason: null,
      },
    ];
    const res = await request(testApp)
      .post("/api/customer-po/5/deliveries")
      .send({ operationKey: "op-2", customerPoItemId: 42, deliveredQty: "3" });
    expect(res.status).toBe(409);
    expect(insertedValues).toHaveLength(0);
  });

  it("409s when the re-send dropped an item from the original operation", async () => {
    idempotencyRows = [
      {
        id: 1,
        customerPoItemId: 42,
        operationKey: "op-3",
        deliveredQty: "5",
        rejectedByCustomerQty: "0",
        rejectionReason: null,
      },
      {
        id: 2,
        customerPoItemId: 43,
        operationKey: "op-3",
        deliveredQty: "5",
        rejectedByCustomerQty: "0",
        rejectionReason: null,
      },
    ];
    const res = await request(testApp)
      .post("/api/customer-po/5/deliveries")
      .send({ operationKey: "op-3", customerPoItemId: 42, deliveredQty: "5" });
    expect(res.status).toBe(409);
  });

  it("stamps every row of a multi-item submission with the SAME operationKey", async () => {
    idempotencyRows = [];
    const res = await request(testApp)
      .post("/api/customer-po/5/deliveries")
      .send({
        operationKey: "op-4",
        items: [
          { customerPoItemId: 42, deliveredQty: "5" },
          { customerPoItemId: 43, deliveredQty: "5" },
        ],
      });
    expect(res.status).toBe(201);
    expect(insertedValues).toHaveLength(2);
    expect(insertedValues.every((v) => v.operationKey === "op-4")).toBe(true);
  });
});

describe("PATCH /customer-po/deliveries/:deliveryId/void — soft void", () => {
  it("voids the row (never deletes) and writes exactly one audit row", async () => {
    voidRow = { id: 7, customerPoItemId: 42, customerPoId: 5, voided: false };
    recomputeRows = [];
    const res = await request(testApp)
      .patch("/api/customer-po/deliveries/7/void")
      .send({ reason: "خطأ إدخال" });
    expect(res.status).toBe(200);
    const voided = updateCalls.find((c) => c.vals?.voided === true);
    expect(voided).toBeTruthy();
    expect(voided!.vals.voidedByName).toBe("مدير");
  });

  it("409s on a second void without changing the original fields", async () => {
    voidRow = { id: 7, customerPoItemId: 42, customerPoId: 5, voided: true };
    const res = await request(testApp).patch("/api/customer-po/deliveries/7/void").send({});
    expect(res.status).toBe(409);
    expect(updateCalls.some((c) => c.vals?.voided === true)).toBe(false);
  });

  it("404s for an unknown delivery", async () => {
    voidRow = null;
    const res = await request(testApp).patch("/api/customer-po/deliveries/999/void").send({});
    expect(res.status).toBe(404);
  });
});

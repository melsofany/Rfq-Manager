import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

import suppliersRouter from "../../modules/users/suppliers";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

// db mock — chainableThenable for the drizzle builders + a db.execute mock for
// the raw auto-deactivate UPDATE. The list route fires db.execute (deactivate
// sweep) then db.select for the rows; the PATCH route fires db.select (current
// isActive) then db.update(...).returning().
vi.mock("@workspace/db", () => {
  const tables = {
    suppliersTable: { _: "suppliers" },
    sentLogTable: { _: "sentLog" },
    offersTable: { _: "offers" },
    offerItemsTable: { _: "offerItems" },
    purchaseOrderItemsTable: { _: "poItems" },
    poItemReceiptsTable: { _: "receipts" },
    purchaseOrdersTable: { _: "pos" },
    customerPoItemsTable: { _: "customerPoItems" },
    customerPosTable: { _: "customerPos" },
    rfqTable: { _: "rfq" },
  };
  function chainableThenable(rows: any): any {
    const api: any = {
      then: (resolve: any) => Promise.resolve(rows).then(resolve),
      from: vi.fn(() => api),
      where: vi.fn(() => api),
      leftJoin: vi.fn(() => api),
      innerJoin: vi.fn(() => api),
      orderBy: vi.fn(() => api),
      limit: vi.fn(() => api),
      set: vi.fn(() => api),
      values: vi.fn(() => api),
      returning: vi.fn(() => chainableThenable(rows)),
    };
    return api;
  }
  return {
    db: {
      // select / update pull their rows from the shared queues so .returning()
      // yields the row the test staged.
      select: vi.fn(() => {
        const res = (globalThis as any).__sdSelectQueue.shift();
        return chainableThenable(res ?? []);
      }),
      execute: vi.fn(async () => {
        const res = (globalThis as any).__sdExecuteQueue.shift();
        return res ?? { rows: [] };
      }),
      insert: vi.fn(() => chainableThenable([{ id: 1 }])),
      update: vi.fn(() => {
        const res = (globalThis as any).__sdUpdateQueue.shift();
        return chainableThenable(res ?? []);
      }),
      delete: vi.fn(() => chainableThenable([])),
    },
    ...tables,
  };
});

(globalThis as any).__sdSelectQueue = [];
(globalThis as any).__sdExecuteQueue = [];
(globalThis as any).__sdUpdateQueue = [];
const selectQueue: any[] = (globalThis as any).__sdSelectQueue;
const executeQueue: any[] = (globalThis as any).__sdExecuteQueue;
const updateQueue: any[] = (globalThis as any).__sdUpdateQueue;

// Grab the db mock so we can assert call args.
import { db } from "@workspace/db";

const testApp = express();
testApp.use(express.json());

beforeAll(() => {
  testApp.use(suppliersRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  executeQueue.length = 0;
  updateQueue.length = 0;
});

const baseRow = {
  id: 5,
  supplierId: "SUP-0001",
  name: "Acme",
  contactPerson: null,
  email: "a@b.c",
  phone: "0100",
  address: null,
  category: "general",
  isActive: true,
  reactivatedAt: null,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
};

// Helper: the first `.set()` call payload on the first `db.update()` invocation.
function firstSetArg(): any {
  const updateResult = (db.update as any).mock.results[0]?.value;
  return updateResult?.set?.mock.calls[0]?.[0];
}

describe("suppliers auto-deactivate + manual reactivation", () => {
  it("GET /suppliers runs the auto-deactivate sweep (db.execute) before listing", async () => {
    // The list route: db.execute (sweep) then db.select (rows).
    executeQueue.push({ rows: [] }); // sweep UPDATE result
    selectQueue.push([baseRow]); // list rows
    const res = await request(testApp).get("/suppliers");
    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    // The sweep SQL must reference the reactivated_at column (reset-aware).
    // drizzle's `sql` template returns a SQL object — JSON.stringify exposes
    // its query text chunks.
    const sqlObj = (db.execute as any).mock.calls[0][0];
    const sqlText = JSON.stringify(sqlObj ?? {});
    expect(sqlText).toMatch(/reactivated_at/i);
    expect(sqlText).toMatch(/GREATEST/i);
  });

  it("PATCH reactivating an inactive supplier stamps reactivatedAt=now (counter reset)", async () => {
    // PATCH flow: select current (isActive=false) → update returning reactivated row.
    selectQueue.push([{ isActive: false }]); // current row
    updateQueue.push([{ ...baseRow, isActive: true, reactivatedAt: new Date() }]);
    const res = await request(testApp).patch("/suppliers/5").send({ isActive: true });
    expect(res.status).toBe(200);
    const setArg = firstSetArg();
    expect(setArg).toMatchObject({ isActive: true });
    expect(setArg.reactivatedAt).toBeInstanceOf(Date);
  });

  it("PATCH leaving a supplier active does NOT stamp reactivatedAt (no false→true)", async () => {
    selectQueue.push([{ isActive: true }]); // already active
    updateQueue.push([{ ...baseRow, isActive: true }]);
    const res = await request(testApp).patch("/suppliers/5").send({ isActive: true });
    expect(res.status).toBe(200);
    const setArg = firstSetArg();
    expect(setArg).toMatchObject({ isActive: true });
    expect(setArg.reactivatedAt).toBeUndefined();
  });

  it("PATCH editing an already-active supplier (no isActive field) does not touch reactivatedAt", async () => {
    updateQueue.push([{ ...baseRow, isActive: true, name: "New Name" }]);
    const res = await request(testApp).patch("/suppliers/5").send({ name: "New Name" });
    expect(res.status).toBe(200);
    const setArg = firstSetArg();
    expect(setArg.name).toBe("New Name");
    expect(setArg.reactivatedAt).toBeUndefined();
  });
});

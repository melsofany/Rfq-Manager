import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

import suppliersRouter from "../../modules/users/suppliers";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

// ─── db mock ─────────────────────────────────────────────────────────────────
// chainableThenable is defined inside the factory (vi.mock is hoisted, so the
// factory cannot reference module-scope variables). Runtime state (selectQueue /
// executeQueue) is read through getters registered on `globalThis` below, which
// are set in beforeEach on the module scope.

vi.mock("@workspace/db", () => {
  const tables = {
    suppliersTable: { _: "suppliers" },
    sentLogTable: { _: "sentLog" },
    offersTable: { _: "offers" },
    offerItemsTable: { _: "offerItems" },
    purchaseOrderItemsTable: { _: "poItems" },
    poItemReceiptsTable: { _: "receipts" },
    purchaseOrdersTable: { _: "pos" },
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
      returning: vi.fn(() => chainableThenable(rows)),
    };
    return api;
  }
  return {
    db: {
      select: vi.fn(() => {
        const res = (globalThis as any).__scoreSelectQueue.shift();
        return chainableThenable(res ?? []);
      }),
      execute: vi.fn(async () => {
        const res = (globalThis as any).__scoreExecuteQueue.shift();
        return res ?? { rows: [] };
      }),
      insert: vi.fn(() => chainableThenable([{ id: 1 }])),
      update: vi.fn(() => chainableThenable([])),
      delete: vi.fn(() => chainableThenable([])),
    },
    ...tables,
  };
});

// Module-scope mutable queues, read by the mock through globalThis.
(globalThis as any).__scoreSelectQueue = [];
(globalThis as any).__scoreExecuteQueue = [];
const selectQueue: any[] = (globalThis as any).__scoreSelectQueue;
const executeQueue: any[] = (globalThis as any).__scoreExecuteQueue;

const testApp = express();
testApp.use(express.json());

beforeAll(() => {
  // The router registers absolute paths ("/suppliers/..."), so mount at root.
  testApp.use(suppliersRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  executeQueue.length = 0;
});

let supplierRow = {
  id: 5,
  supplierId: "SUP-0001",
  name: "Acme",
  contactPerson: null,
  email: "a@b.c",
  phone: "0100",
  address: null,
  city: null,
  category: "general",
  paymentTerms: null,
  notes: null,
  isActive: true,
  createdAt: new Date("2025-01-01"),
};

describe("GET /suppliers/:id/score (smoke, real logic)", () => {
  it("computes a weighted scorecard from real data, no fabricated defaults", async () => {
    // supplier lookup (list check in /:id/score)
    selectQueue.push([supplierRow]);
    // 1. count(sent_log)
    selectQueue.push([{ total: 4 }]);
    // 2. count(offers)
    selectQueue.push([{ total: 3 }]);
    // db.execute #1 — response time (1 row: 2h)
    executeQueue.push({ rows: [{ hours: "2" }] });
    // 3. items offered count
    selectQueue.push([{ cnt: 2 }]);
    // db.execute #2 — avg price delta (10% cheaper)
    executeQueue.push({ rows: [{ avg_delta: "-10" }] });
    // 4. wins count (po items)
    selectQueue.push([{ cnt: 1 }]);
    // 5. receipt sums (accepted 90 / rejected 10 → 90%)
    selectQueue.push([{ accepted: "90", rejected: "10" }]);
    // 6. delivery from receipts (none received → null)
    selectQueue.push([{ avg: null, cnt: 0 }]);

    const res = await request(testApp).get("/suppliers/5/score");
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.totalRfqsReceived).toBe(4);
    expect(b.totalOffersSubmitted).toBe(3);
    expect(b.responseRate).toBe(75);
    expect(b.commitmentScore).toBe(75);
    expect(b.avgResponseHours).toBe(2);
    expect(b.responseSpeedScore).toBe(100);
    expect(b.avgPriceDelta).toBe(-10);
    expect(b.priceScore).toBe(85); // 70 + (10/20)*30 = 85
    expect(b.winScore).toBe(50); // 1/2 → 50
    expect(b.receiptQualityScore).toBe(90);
    expect(b.avgDeliveryDays).toBeNull();
    expect(b.deliveryScore).toBeNull();
    // Weighted over all 6 components — non-null
    expect(b.totalScore).not.toBeNull();
    expect(b.rating).not.toBeNull();
  });

  it("returns null totalScore (not a fabricated default) for a supplier with no data", async () => {
    selectQueue.push([supplierRow]); // supplier exists
    selectQueue.push([{ total: 0 }]); // sent
    selectQueue.push([{ total: 0 }]); // offers
    executeQueue.push({ rows: [] }); // response time
    selectQueue.push([{ cnt: 0 }]); // items offered
    selectQueue.push([{ cnt: 0 }]); // wins
    selectQueue.push([{ accepted: null, rejected: null }]); // receipts
    selectQueue.push([{ avg: null }]); // delivery days

    const res = await request(testApp).get("/suppliers/5/score");
    expect(res.status).toBe(200);
    expect(res.body.totalScore).toBeNull();
    expect(res.body.rating).toBeNull();
    expect(res.body.commitmentScore).toBeNull();
    expect(res.body.responseSpeedScore).toBeNull();
    expect(res.body.priceScore).toBeNull();
    expect(res.body.winScore).toBeNull();
    expect(res.body.receiptQualityScore).toBeNull();
    expect(res.body.deliveryScore).toBeNull();
  });

  it("weights only over available components", async () => {
    selectQueue.push([supplierRow]);
    selectQueue.push([{ total: 2 }]); // sent
    selectQueue.push([{ total: 2 }]); // offers → commitment 100
    executeQueue.push({ rows: [] }); // no response times
    selectQueue.push([{ cnt: 0 }]); // no items offered → no price/win/receipt data
    selectQueue.push([{ cnt: 0 }]);
    selectQueue.push([{ accepted: null, rejected: null }]);
    selectQueue.push([{ avg: null }]);

    const res = await request(testApp).get("/suppliers/5/score");
    expect(res.status).toBe(200);
    // Only commitment available (100) → total = 100, rating = 5.0
    expect(res.body.totalScore).toBe(100);
    expect(res.body.rating).toBe(5);
    expect(res.body.commitmentScore).toBe(100);
  });

  it("404 when the supplier does not exist", async () => {
    selectQueue.push([]); // no supplier
    const res = await request(testApp).get("/suppliers/999/score");
    expect(res.status).toBe(404);
  });

  it("delivery score is computed from actual receipts (5 days → 100)", async () => {
    selectQueue.push([supplierRow]);
    selectQueue.push([{ total: 4, replied: 3 }]);
    selectQueue.push([{ avgHours: "2" }]);
    selectQueue.push([{ avg: null }]);           // no competitor prices
    selectQueue.push([{ wins: 0, total: 0 }]);
    selectQueue.push([{ avgReceipt: null }]);
    selectQueue.push([{ avg: "5.00", cnt: 3 }]); // 3 receipts, avg 5 days
    const res = await request(testApp).get("/suppliers/5/score");
    expect(res.status).toBe(200);
    expect(res.body.avgDeliveryDays).toBe(5);
    expect(res.body.deliveryScore).toBe(100);
  });
});

describe("Auto-deactivate suppliers with 10+ sends and no replies", () => {
  it("runs an UPDATE ... FROM sent_log+offers before listing suppliers", async () => {
    // The list endpoint auto-deactivates first (db.execute), then selects suppliers.
    executeQueue.push({ rows: [], rowCount: 2 }); // 2 suppliers deactivated
    selectQueue.push([supplierRow]); // list query

    const res = await request(testApp).get("/suppliers");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("does not fail the list if the auto-deactivate step errors", async () => {
    // execute throwing simulates a SQL failure — list should still succeed.
    const dbModule = await import("@workspace/db");
    vi.mocked(dbModule.db.execute).mockRejectedValueOnce(new Error("SQL boom"));
    selectQueue.push([supplierRow]);

    const res = await request(testApp).get("/suppliers");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

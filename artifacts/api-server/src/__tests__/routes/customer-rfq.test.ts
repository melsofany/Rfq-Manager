import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth ───────────────────────────────────────────────────────────────
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

// ── Chainable + thenable DB mock ─────────────────────────────────────────────
function thenable<T>(value: T, extra: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, v] of Object.entries(extra)) obj[k] = v;
  return obj;
}

// Tables referenced by .from() / eq() / .references() — truthy markers are enough.
const rfqTable = { _: "customerRfqs", createdAt: "createdAt", id: "id" };
const itemsTable = { _: "customerRfqItems", customerRfqId: "customerRfqId" };
const customersTable = { _: "customers", id: "id", name: "name" };
const employeesTbl = { _: "employees", id: "id", name: "name" };
const auditTable = { _: "audit" };
const rfqItemsTbl = { _: "rfqItems", customerRfqItemId: "customerRfqItemId", partNo: "partNo", lineItem: "lineItem" };
const offerItemsTbl = { _: "offerItems", isApproved: "isApproved" };
const tables = {
  customerRfqsTable: rfqTable,
  customerRfqItemsTable: itemsTable,
  customersTable,
  employeesTable: employeesTbl,
  auditLogTable: auditTable,
  rfqItemsTable: rfqItemsTbl,
  offerItemsTable: offerItemsTbl,
};

// Per-test state.
let listRows: any[];
let countRows: any[];
let countRow: { cnt: number };
let insertedRfq: any;
let detailRow: any | null;
let detailItems: any[];
// Approved supplier offer_items returned by resolveApprovedCosts (margin check).
// Each row: { customerRfqItemId, price, taxIncluded }.
let approvedRows: any[];
// Employee row returned for the POST "who entered it" lookup: { name }.
let employeeRow: any;
// Mutable session so individual tests can flip role=admin for override tests.
const sessionState: { employeeId: number; role?: string } = { employeeId: 1 };

// Tracks the exact values written to customer_rfq_items so we can assert the
// lineItem space-stripping behaviour.
const insertedItems: any[] = [];

// Build an object that is BOTH thenable (awaitable directly) and exposes chain
// methods. Each chain method returns a thenable of `value`.
function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

const dbMock: any = {
  // select() builds a chain whose .from(table) decides which data to return.
  select: vi.fn((arg?: any) => ({
    from: vi.fn((table: any) => {
      // generateInternalNo: select({cnt: count()}).from(rfqTable) — awaited directly.
      if (table === rfqTable && arg && typeof arg === "object" && "cnt" in arg) {
        return chainable([countRow]);
      }
      // rfq list/detail (select {rfq: ...} or bare select)
      if (table === rfqTable) {
        // Bare select() (no arg) returns bare rows — used by PATCH to read the
        // existing + updated row directly. select({rfq:...}) wraps in {rfq:...}.
        const bare = arg === undefined;
        const wrapped = bare ? (detailRow ? [detailRow] : []) : (detailRow ? [{ rfq: detailRow }] : []);
        return chainable(wrapped, {
          // list chains .orderBy; detail chains .where
          orderBy: vi.fn(() => chainable(listRows)),
          where: vi.fn(() => chainable(wrapped)),
          limit: vi.fn(() => chainable(wrapped)),
        });
      }
      // item-count aggregate for list: select({customerRfqId, cnt}).from(items).where().groupBy()
      if (table === itemsTable && arg && typeof arg === "object" && "cnt" in arg) {
        return chainable(countRows, {
          where: vi.fn(() => chainable(countRows, { groupBy: vi.fn(() => chainable(countRows)) })),
          groupBy: vi.fn(() => chainable(countRows)),
        });
      }
      // items list for detail (bare select).from(items).where()
      if (table === itemsTable) {
        return chainable(detailItems, {
          where: vi.fn(() => chainable(detailItems)),
        });
      }
      // resolveApprovedCosts: select({...}).from(offerItems).innerJoin(rfqItems).where(...)
      // returns the per-test approvedRows.
      if (table === offerItemsTbl) {
        return chainable(approvedRows, {
          innerJoin: vi.fn(() => chainable(approvedRows, {
            where: vi.fn(() => chainable(approvedRows)),
          })),
        });
      }
      // Employee name lookup: select({name}).from(employees).where().limit() —
      // returns the per-test employeeRow (so POST records who entered the RFQ).
      if (table === employeesTbl) {
        const rows = employeeRow ? [employeeRow] : [];
        return chainable(rows, {
          where: vi.fn(() => chainable(rows, { limit: vi.fn(() => chainable(rows)) })),
          limit: vi.fn(() => chainable(rows)),
        });
      }
      // customer name resolution (select {id}).from(customers).where().limit()
      return chainable([], {
        where: vi.fn(() => chainable([], { limit: vi.fn(() => chainable([])) })),
      });
    }),
  })),
  insert: vi.fn((table: any) => ({
    values: vi.fn((vals: any) => {
      if (table === itemsTable) {
        if (Array.isArray(vals)) insertedItems.push(...vals);
        else insertedItems.push(vals);
        return chainable(undefined);
      }
      // rfq insert: reflect the values the route passed (e.g. numberAutoGenerated)
      // merged over the default row so tests can assert server-computed fields.
      return {
        returning: vi.fn(() => chainable([{ ...insertedRfq, ...vals }])),
      };
    }),
  })),
  update: vi.fn(() => ({
    // Reflect updates onto detailRow so the post-update re-select sees the new
    // values (e.g. status → "sent", numberAutoGenerated → false).
    set: vi.fn((vals: any) => {
      if (vals && typeof vals === "object" && detailRow) detailRow = { ...detailRow, ...vals };
      return { where: vi.fn(() => chainable(undefined)) };
    }),
  })),
  delete: vi.fn((table: any) => ({
    where: vi.fn(() => {
      if (table === rfqTable) return { returning: vi.fn(() => chainable(detailRow ? [detailRow] : [])) };
      return chainable(undefined);
    }),
  })),
};

vi.mock("@workspace/db", () => ({ ...tables, db: dbMock }));

let testApp: express.Express;

beforeAll(async () => {
  const { default: customerRfqRouter } = await import("../../modules/customer-rfq/index");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = sessionState;
    next();
  });
  testApp.use("/api", customerRfqRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  listRows = [];
  countRows = [];
  countRow = { cnt: 5 };
  insertedRfq = {
    id: 42,
    internalNo: "CRFQ-2025-000042",
    customerId: null,
    customerName: "Acme",
    customerRfqNo: "CUST-001",
    numberAutoGenerated: false,
    entryDate: null,
    expiryDate: null,
    buyerName: null,
    employeeId: null,
    employeeName: null,
    status: "draft",
    notes: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-02"),
  };
  detailRow = null;
  detailItems = [];
  approvedRows = [];
  employeeRow = { name: "Tester" };
  sessionState.role = undefined;
  insertedItems.length = 0;
});

describe("POST /api/customer-rfq (create)", () => {
  it("auto-generates the customer RFQ number when blank and flags it", async () => {
    const res = await request(testApp).post("/api/customer-rfq").send({
      customerName: "Acme",
      customerRfqNo: "",
      items: [{ partNo: "P1", lineItem: "AB CD", uom: "pc", qty: 5 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.numberAutoGenerated).toBe(true);
    expect(res.body.customerRfqNo).toMatch(/^CRFQ-\d{4}-/);
  });

  it("keeps the user-provided number and does not flag auto-generation", async () => {
    const res = await request(testApp).post("/api/customer-rfq").send({
      customerName: "Acme",
      customerRfqNo: "RFQ-99",
      items: [{ partNo: "P1", lineItem: "AB CD", uom: "pc", qty: 5 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.numberAutoGenerated).toBe(false);
    expect(res.body.customerRfqNo).toBe("RFQ-99");
  });

  it("strips all spaces from lineItem before saving", async () => {
    await request(testApp).post("/api/customer-rfq").send({
      customerName: "Acme",
      customerRfqNo: "RFQ-1",
      items: [{ partNo: "P1", lineItem: "A B  C D", uom: "pc", qty: 2 }],
    });
    expect(insertedItems).toHaveLength(1);
    expect(insertedItems[0].lineItem).toBe("ABCD");
  });

  it("persists the line-item description", async () => {
    await request(testApp).post("/api/customer-rfq").send({
      customerName: "Acme",
      customerRfqNo: "RFQ-2",
      items: [{ partNo: "P1", lineItem: "AB", description: "  وصف البند  ", uom: "pc", qty: 1 }],
    });
    expect(insertedItems).toHaveLength(1);
    expect(insertedItems[0].description).toBe("وصف البند");
  });

  it("returns 400 when customerName is missing", async () => {
    const res = await request(testApp).post("/api/customer-rfq").send({ customerRfqNo: "X" });
    expect(res.status).toBe(400);
  });

  it("records the logged-in employee who entered the RFQ", async () => {
    employeeRow = { name: "Ahmed" };
    const res = await request(testApp).post("/api/customer-rfq").send({
      customerName: "Acme",
      customerRfqNo: "RFQ-E1",
      items: [{ partNo: "P1", uom: "pc", qty: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.employeeId).toBe(sessionState.employeeId);
    expect(res.body.employeeName).toBe("Ahmed");
  });
});

describe("GET /api/customer-rfq (list)", () => {
  it("returns the list with item counts", async () => {
    listRows = [{ rfq: { ...insertedRfq, id: 1, internalNo: "CRFQ-1", itemCount: undefined } }];
    countRows = [{ customerRfqId: 1, cnt: 3 }];
    const res = await request(testApp).get("/api/customer-rfq");
    expect(res.status).toBe(200);
    expect(res.body[0].internalNo).toBe("CRFQ-1");
    expect(res.body[0].itemCount).toBe(3);
  });
});

describe("GET /api/customer-rfq/numbers", () => {
  it("returns all customer RFQ numbers for the import combobox", async () => {
    // Reuse the list path mock: select().from(rfqTable).orderBy() returns listRows.
    listRows = [
      { customerRfqNo: "RFQ-AAA" },
      { customerRfqNo: "RFQ-BBB" },
    ];
    const res = await request(testApp).get("/api/customer-rfq/numbers");
    expect(res.status).toBe(200);
    expect(res.body.rfqNumbers).toEqual(["RFQ-AAA", "RFQ-BBB"]);
  });
});

describe("GET /api/customer-rfq/:id", () => {
  it("returns 404 when not found", async () => {
    detailRow = null;
    const res = await request(testApp).get("/api/customer-rfq/999");
    expect(res.status).toBe(404);
  });

  it("returns the rfq with items when found", async () => {
    detailRow = insertedRfq;
    detailItems = [
      { id: 1, customerRfqId: 42, partNo: "P1", lineItem: "ABCD", description: "وصف البند", uom: "pc", qty: "3.0000", createdAt: new Date("2025-01-01") },
    ];
    const res = await request(testApp).get("/api/customer-rfq/42");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(42);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].lineItem).toBe("ABCD");
    expect(res.body.items[0].description).toBe("وصف البند");
    // NUMERIC qty "3.0000" is formatted without trailing zeros.
    expect(res.body.items[0].qty).toBe("3");
  });
});

describe("PATCH /api/customer-rfq/:id", () => {
  it("clears numberAutoGenerated when a real number is provided", async () => {
    detailRow = { ...insertedRfq, numberAutoGenerated: true };
    // The PATCH re-selects the row after update; reflect the cleared flag.
    const updatedRow = { ...insertedRfq, numberAutoGenerated: false, customerRfqNo: "RFQ-X" };
    detailRow = updatedRow;
    detailItems = [];
    const res = await request(testApp).patch("/api/customer-rfq/42").send({ customerRfqNo: "RFQ-X" });
    expect(res.status).toBe(200);
    expect(res.body.numberAutoGenerated).toBe(false);
    expect(res.body.customerRfqNo).toBe("RFQ-X");
  });

  it("saves item prices and locks the RFQ (status → sent) when margin clears", async () => {
    detailRow = { ...insertedRfq }; // draft
    detailItems = [
      {
        id: 1,
        customerRfqId: 42,
        partNo: "P1",
        lineItem: "ABCD",
        description: null,
        uom: "pc",
        qty: "3.0000",
        unitPrice: "10.0000",
        createdAt: new Date("2025-01-03"),
      },
    ];
    // Approved supplier price (excl tax) = 8 → 1.06 × 8 = 8.48 ≤ 10 ✓
    approvedRows = [{ customerRfqItemId: 1, price: "8", taxIncluded: false }];
    const res = await request(testApp).patch("/api/customer-rfq/42").send({
      status: "sent",
      items: [{ partNo: "P1", lineItem: "ABCD", uom: "pc", qty: 3, unitPrice: 10 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(res.body.items[0].unitPrice).toBe("10");
    expect(res.body.items[0].total).toBe("30");
  });

  it("blocks finalizing when the customer price is below 1.06× approved cost", async () => {
    detailRow = { ...insertedRfq };
    detailItems = [
      {
        id: 1,
        customerRfqId: 42,
        partNo: "P1",
        lineItem: "ABCD",
        description: null,
        uom: "pc",
        qty: "3.0000",
        unitPrice: "10.0000",
        createdAt: new Date("2025-01-03"),
      },
    ];
    // Approved cost = 10 → 1.06 × 10 = 10.6 > 10 → violation
    approvedRows = [{ customerRfqItemId: 1, price: "10", taxIncluded: false }];
    const res = await request(testApp).patch("/api/customer-rfq/42").send({
      status: "sent",
      items: [{ partNo: "P1", lineItem: "ABCD", uom: "pc", qty: 3, unitPrice: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.marginViolations).toBeDefined();
    expect(res.body.error).toContain("الحد الأدنى");
  });

  it("blocks finalizing when no approved supplier price exists for an item", async () => {
    detailRow = { ...insertedRfq };
    detailItems = [
      {
        id: 1,
        customerRfqId: 42,
        partNo: "P1",
        lineItem: "ABCD",
        description: null,
        uom: "pc",
        qty: "3.0000",
        unitPrice: "10.0000",
        createdAt: new Date("2025-01-03"),
      },
    ];
    // No approved supplier price at all.
    approvedRows = [];
    const res = await request(testApp).patch("/api/customer-rfq/42").send({
      status: "sent",
      items: [{ partNo: "P1", lineItem: "ABCD", uom: "pc", qty: 3, unitPrice: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.marginViolations).toBeDefined();
    expect(res.body.error).toContain("معتمد");
  });

  it("allows an admin to override the margin check (audited)", async () => {
    detailRow = { ...insertedRfq };
    detailItems = [
      {
        id: 1,
        customerRfqId: 42,
        partNo: "P1",
        lineItem: "ABCD",
        description: null,
        uom: "pc",
        qty: "3.0000",
        unitPrice: "10.0000",
        createdAt: new Date("2025-01-03"),
      },
    ];
    approvedRows = []; // would normally block
    sessionState.role = "admin";
    const res = await request(testApp).patch("/api/customer-rfq/42").send({
      status: "sent",
      overrideMarginCheck: true,
      items: [{ partNo: "P1", lineItem: "ABCD", uom: "pc", qty: 3, unitPrice: 10 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
  });

  it("rejects finalizing when an item has no price", async () => {
    detailRow = { ...insertedRfq };
    detailItems = [];
    const res = await request(testApp).patch("/api/customer-rfq/42").send({
      status: "sent",
      items: [{ partNo: "P1", lineItem: "ABCD", uom: "pc", qty: 3 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("سعر");
  });

  it("blocks editing once the RFQ is sent", async () => {
    detailRow = { ...insertedRfq, status: "sent" };
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ notes: "edited after send" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("بعد إرساله");
  });
});

describe("DELETE /api/customer-rfq/:id", () => {
  it("returns 204 when deleted", async () => {
    detailRow = insertedRfq;
    const res = await request(testApp).delete("/api/customer-rfq/42");
    expect(res.status).toBe(204);
  });

  it("returns 404 when not found", async () => {
    detailRow = null;
    const res = await request(testApp).delete("/api/customer-rfq/999");
    expect(res.status).toBe(404);
  });
});

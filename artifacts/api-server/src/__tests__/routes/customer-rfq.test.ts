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
const rfqItemsTbl = {
  _: "rfqItems",
  customerRfqItemId: "customerRfqItemId",
  partNo: "partNo",
  lineItem: "lineItem",
};
const offerItemsTbl = { _: "offerItems", isApproved: "isApproved" };
const customerPoItemsTbl = {
  _: "customerPoItems",
  customerRfqItemId: "customerRfqItemId",
  customerPoId: "customerPoId",
};
const customerPosTbl = { _: "customerPos", customerPoNo: "customerPoNo", id: "id" };
const tables = {
  customerRfqsTable: rfqTable,
  customerRfqItemsTable: itemsTable,
  customersTable,
  employeesTable: employeesTbl,
  auditLogTable: auditTable,
  rfqItemsTable: rfqItemsTbl,
  offerItemsTable: offerItemsTbl,
  customerPoItemsTable: customerPoItemsTbl,
  customerPosTable: customerPosTbl,
  customerPoItemDeliveriesTable: {
    _: "cpoDeliveries",
    customerPoItemId: "customerPoItemId",
    deliveryStatus: "deliveryStatus",
    rejectionReason: "rejectionReason",
    createdAt: "createdAt",
  },
  purchaseOrderItemsTable: {
    _: "poItems",
    customerPoItemId: "customerPoItemId",
    finalActualCost: "finalActualCost",
    referencePrice: "referencePrice",
  },
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
// Customer PO items returned by the request-status PO/delivery lookup. Each row
// matches the shape selected in routes.ts: { customerRfqItemId, qty,
// totalDeliveredQty, deliveryStatus }.
let poItemRows: any[];
// Sheet-view flat rows returned by GET /customer-rfq/sheet-view.
let sheetRows: any[];
// Sheet-view rejected-delivery rows (for the flag column) returned by the
// batched lookup on customer_po_item_deliveries.
let sheetRejectedDeliveries: any[];
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
        const wrapped = bare
          ? detailRow
            ? [detailRow]
            : []
          : detailRow
            ? [{ rfq: detailRow }]
            : [];
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
        // sheet-view: select({...}).from(items).innerJoin(rfq).leftJoin(poItems)
        // .leftJoin(po).leftJoin(purchaseOrderItems).orderBy()
        // returns the per-test sheetRows (already flat, multi-column). The
        // orderBy is the terminal thenable.
        if (arg && typeof arg === "object" && "rfqItemId" in arg) {
          return chainable(sheetRows, {
            innerJoin: vi.fn(() =>
              chainable(sheetRows, {
                leftJoin: vi.fn(() =>
                  chainable(sheetRows, {
                    leftJoin: vi.fn(() =>
                      chainable(sheetRows, {
                        leftJoin: vi.fn(() =>
                          chainable(sheetRows, {
                            orderBy: vi.fn(() => chainable(sheetRows)),
                          }),
                        ),
                      }),
                    ),
                  }),
                ),
              }),
            ),
          });
        }
        return chainable(detailItems, {
          where: vi.fn(() => chainable(detailItems)),
        });
      }
      // resolveApprovedCosts: select({...}).from(offerItems).innerJoin(rfqItems).where(...)
      // returns the per-test approvedRows.
      if (table === offerItemsTbl) {
        return chainable(approvedRows, {
          innerJoin: vi.fn(() =>
            chainable(approvedRows, {
              where: vi.fn(() => chainable(approvedRows)),
            }),
          ),
        });
      }
      // Request-status PO/delivery lookup: select({...}).from(customerPoItems)
      // .where(inArray + isNotNull) — returns the per-test poItemRows.
      if (table === customerPoItemsTbl) {
        return chainable(poItemRows, {
          where: vi.fn(() => chainable(poItemRows)),
        });
      }
      // Sheet-view rejected-delivery batched lookup:
      // select({...}).from(customerPoItemDeliveries).where(and(inArray, eq)).orderBy()
      if (table === (tables as any).customerPoItemDeliveriesTable) {
        return chainable(sheetRejectedDeliveries, {
          where: vi.fn(() =>
            chainable(sheetRejectedDeliveries, {
              orderBy: vi.fn(() => chainable(sheetRejectedDeliveries)),
            }),
          ),
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
      if (table === rfqTable)
        return { returning: vi.fn(() => chainable(detailRow ? [detailRow] : [])) };
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
  poItemRows = [];
  sheetRows = [];
  sheetRejectedDeliveries = [];
  employeeRow = { name: "Tester" };
  sessionState.role = undefined;
  insertedItems.length = 0;
});

describe("POST /api/customer-rfq (create)", () => {
  it("auto-generates the customer RFQ number when blank and flags it", async () => {
    const res = await request(testApp)
      .post("/api/customer-rfq")
      .send({
        customerName: "Acme",
        customerRfqNo: "",
        items: [{ partNo: "P1", lineItem: "AB CD", uom: "pc", qty: 5 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.numberAutoGenerated).toBe(true);
    expect(res.body.customerRfqNo).toMatch(/^CRFQ-\d{4}-/);
  });

  it("keeps the user-provided number and does not flag auto-generation", async () => {
    const res = await request(testApp)
      .post("/api/customer-rfq")
      .send({
        customerName: "Acme",
        customerRfqNo: "RFQ-99",
        items: [{ partNo: "P1", lineItem: "AB CD", uom: "pc", qty: 5 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.numberAutoGenerated).toBe(false);
    expect(res.body.customerRfqNo).toBe("RFQ-99");
  });

  it("strips all spaces from lineItem before saving", async () => {
    await request(testApp)
      .post("/api/customer-rfq")
      .send({
        customerName: "Acme",
        customerRfqNo: "RFQ-1",
        items: [{ partNo: "P1", lineItem: "A B  C D", uom: "pc", qty: 2 }],
      });
    expect(insertedItems).toHaveLength(1);
    expect(insertedItems[0].lineItem).toBe("ABCD");
  });

  it("persists the line-item description", async () => {
    await request(testApp)
      .post("/api/customer-rfq")
      .send({
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
    const res = await request(testApp)
      .post("/api/customer-rfq")
      .send({
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
  it("returns the list with item counts + derived request status", async () => {
    listRows = [{ rfq: { ...insertedRfq, id: 1, internalNo: "CRFQ-1", itemCount: undefined } }];
    // The list now loads the RFQ's actual items (batched) to compute both the
    // item count and the derived request status. Two items, one priced.
    detailItems = [
      {
        id: 10,
        customerRfqId: 1,
        partNo: "P1",
        lineItem: "A1",
        uom: "pc",
        qty: "3",
        unitPrice: "10",
      },
      {
        id: 11,
        customerRfqId: 1,
        partNo: "P2",
        lineItem: "A2",
        uom: "pc",
        qty: "2",
        unitPrice: null,
      },
    ];
    const res = await request(testApp).get("/api/customer-rfq");
    expect(res.status).toBe(200);
    expect(res.body[0].internalNo).toBe("CRFQ-1");
    expect(res.body[0].itemCount).toBe(2);
    // No approved supplier offer + 1 of 2 items priced → "مُسعَّر 50%".
    expect(res.body[0].requestStatus).toBeDefined();
    expect(res.body[0].requestStatus.customerPricingPct).toBe(50);
    expect(res.body[0].requestStatus.poIssued).toBe(false);
    expect(res.body[0].requestStatus.stage).toBe("customer_priced");
  });

  it("request status reflects supplier-priced when an approved offer exists", async () => {
    listRows = [{ rfq: { ...insertedRfq, id: 2, internalNo: "CRFQ-2", itemCount: undefined } }];
    detailItems = [
      {
        id: 20,
        customerRfqId: 2,
        partNo: "P1",
        lineItem: "A1",
        uom: "pc",
        qty: "1",
        unitPrice: null,
      },
    ];
    // resolveSupplierPricedItemIds queries offerItems (mock returns approvedRows
    // for items with an id in the set). Mark item 20 as approved.
    approvedRows = [{ customerRfqItemId: 20, price: "5", taxIncluded: false }];
    const res = await request(testApp).get("/api/customer-rfq");
    expect(res.status).toBe(200);
    expect(res.body[0].requestStatus.supplierPriced).toBe(true);
    // No customer price yet → still "مُسعَّر من المورد".
    expect(res.body[0].requestStatus.stage).toBe("supplier_priced");
  });

  it("marks an unpriced RFQ whose close date passed as expired", async () => {
    listRows = [
      {
        rfq: {
          ...insertedRfq,
          id: 3,
          internalNo: "CRFQ-3",
          itemCount: undefined,
          expiryDate: "2020-01-01",
        },
      },
    ];
    // One item with no price, no approved offer, no PO → would be "received"
    // except the close date is long past → "expired".
    detailItems = [
      {
        id: 30,
        customerRfqId: 3,
        partNo: "P1",
        lineItem: "A1",
        uom: "pc",
        qty: "1",
        unitPrice: null,
      },
    ];
    const res = await request(testApp).get("/api/customer-rfq");
    expect(res.status).toBe(200);
    expect(res.body[0].requestStatus.stage).toBe("expired");
    expect(res.body[0].requestStatus.label).toContain("منتهي");
  });
});

describe("GET /api/customer-rfq/numbers", () => {
  it("returns all customer RFQ numbers for the import combobox", async () => {
    // Reuse the list path mock: select().from(rfqTable).orderBy() returns listRows.
    listRows = [{ customerRfqNo: "RFQ-AAA" }, { customerRfqNo: "RFQ-BBB" }];
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
      {
        id: 1,
        customerRfqId: 42,
        partNo: "P1",
        lineItem: "ABCD",
        description: "وصف البند",
        uom: "pc",
        qty: "3.0000",
        createdAt: new Date("2025-01-01"),
      },
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

  it("flags items with an issued PO and reports poIssued/deliveredPct", async () => {
    detailRow = insertedRfq;
    // Two items: id 1 (on a PO, fully delivered) and id 2 (no PO).
    detailItems = [
      {
        id: 1,
        customerRfqId: 42,
        partNo: "P1",
        lineItem: "A1",
        uom: "pc",
        qty: "3",
        unitPrice: "10",
        createdAt: new Date("2025-01-01"),
      },
      {
        id: 2,
        customerRfqId: 42,
        partNo: "P2",
        lineItem: "A2",
        uom: "pc",
        qty: "5",
        unitPrice: null,
        createdAt: new Date("2025-01-01"),
      },
    ];
    // Item 1 appears on a customer PO and is fully delivered.
    poItemRows = [
      { customerRfqItemId: 1, qty: "3", totalDeliveredQty: "3", deliveryStatus: "delivered" },
    ];
    const res = await request(testApp).get("/api/customer-rfq/42");
    expect(res.status).toBe(200);
    // Item 1 → hasPo true (highlighted green); item 2 → hasPo false.
    expect(res.body.items[0].hasPo).toBe(true);
    expect(res.body.items[1].hasPo).toBe(false);
    // Request status: a PO was issued and that item is delivered → stage "delivered".
    expect(res.body.requestStatus.poIssued).toBe(true);
    expect(res.body.requestStatus.poItemIds).toContain(1);
    expect(res.body.requestStatus.deliveredPct).toBe(100);
    expect(res.body.requestStatus.stage).toBe("delivered");
  });

  it("marks an unpriced RFQ as expired when its close date passed", async () => {
    detailRow = { ...insertedRfq, expiryDate: "2020-01-01" };
    // No price, no approved offer, no PO — but the close date is past.
    detailItems = [
      {
        id: 5,
        customerRfqId: 42,
        partNo: "P1",
        lineItem: "A1",
        uom: "pc",
        qty: "1",
        unitPrice: null,
        createdAt: new Date("2025-01-01"),
      },
    ];
    approvedRows = [];
    poItemRows = [];
    const res = await request(testApp).get("/api/customer-rfq/42");
    expect(res.status).toBe(200);
    expect(res.body.requestStatus.stage).toBe("expired");
    expect(res.body.requestStatus.label).toContain("منتهي");
  });

  it("does not mark a priced RFQ as expired even past its close date", async () => {
    detailRow = { ...insertedRfq, expiryDate: "2020-01-01" };
    // Has a customer price → takes precedence over the expired stage.
    detailItems = [
      {
        id: 6,
        customerRfqId: 42,
        partNo: "P1",
        lineItem: "A1",
        uom: "pc",
        qty: "1",
        unitPrice: "10",
        createdAt: new Date("2025-01-01"),
      },
    ];
    approvedRows = [];
    poItemRows = [];
    const res = await request(testApp).get("/api/customer-rfq/42");
    expect(res.status).toBe(200);
    expect(res.body.requestStatus.stage).toBe("customer_priced");
  });
});

describe("PATCH /api/customer-rfq/:id", () => {
  it("clears numberAutoGenerated when a real number is provided", async () => {
    detailRow = { ...insertedRfq, numberAutoGenerated: true };
    // The PATCH re-selects the row after update; reflect the cleared flag.
    const updatedRow = { ...insertedRfq, numberAutoGenerated: false, customerRfqNo: "RFQ-X" };
    detailRow = updatedRow;
    detailItems = [];
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ customerRfqNo: "RFQ-X" });
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
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({
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
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({
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
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({
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
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({
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
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({
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

  it("blocks a prices-only update on a sent RFQ before its expiry date", async () => {
    detailRow = { ...insertedRfq, status: "sent", expiryDate: "2099-12-31" };
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ items: [{ id: 1, unitPrice: 12 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("بعد إرساله");
  });

  it("allows re-pricing a sent RFQ after its expiry date (prices-only, no status change)", async () => {
    detailRow = { ...insertedRfq, status: "sent", expiryDate: "2020-01-01" };
    detailItems = [
      {
        id: 1,
        customerRfqId: 42,
        partNo: "P1",
        lineItem: "ABCD",
        description: null,
        uom: "pc",
        qty: "3.0000",
        unitPrice: "12.0000",
        createdAt: new Date("2025-01-03"),
      },
    ];
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ items: [{ id: 1, unitPrice: 12 }] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(res.body.items[0].unitPrice).toBe("12");
    expect(res.body.items[0].total).toBe("36");
  });

  it("blocks a prices-only re-price when header fields are also sent", async () => {
    detailRow = { ...insertedRfq, status: "sent", expiryDate: "2020-01-01" };
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ notes: "x", items: [{ id: 1, unitPrice: 12 }] });
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

describe("GET /api/customer-rfq/sheet-view", () => {
  it("returns flat rows with joined PO columns and pagination metadata", async () => {
    sheetRows = [
      {
        rfqItemId: 10,
        lineItem: "A1",
        partNo: "P-100",
        description: "Widget",
        uom: "pc",
        rfqQty: "5",
        rfqUnitPrice: "120",
        customerRfqId: 7,
        customerRfqNo: "CUST-001",
        customerName: "Acme",
        entryDate: "2025-01-10",
        expiryDate: "2025-02-10",
        buyerName: "Sam",
        poItemId: 90,
        poNo: "PO-55",
        poDate: "2025-01-20",
        poQty: "3",
        poUnitPrice: "130",
      },
      {
        rfqItemId: 11,
        lineItem: "A2",
        partNo: null,
        description: "Gadget",
        uom: null,
        rfqQty: "2",
        rfqUnitPrice: null,
        customerRfqId: 7,
        customerRfqNo: "CUST-001",
        customerName: "Acme",
        entryDate: "2025-01-10",
        expiryDate: null,
        buyerName: null,
        poItemId: null,
        poNo: null,
        poDate: null,
        poQty: null,
        poUnitPrice: null,
      },
    ];
    const res = await request(testApp).get("/api/customer-rfq/sheet-view");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0]).toMatchObject({
      lineItem: "A1",
      partNo: "P-100",
      customerRfqNo: "CUST-001",
      poNo: "PO-55",
      poQty: "3",
    });
    // An RFQ item with no PO yet keeps null PO columns.
    expect(res.body.rows[1].poNo).toBeNull();
    expect(res.body.rows[1].poQty).toBeNull();
  });

  it("filters rows by the search term", async () => {
    sheetRows = [
      {
        rfqItemId: 1,
        lineItem: "X1",
        partNo: "P-A",
        description: "Alpha",
        uom: null,
        rfqQty: null,
        rfqUnitPrice: null,
        customerRfqId: 1,
        customerRfqNo: "CUST-A",
        customerName: "Acme",
        entryDate: null,
        expiryDate: null,
        buyerName: null,
        poItemId: null,
        poNo: null,
        poDate: null,
        poQty: null,
        poUnitPrice: null,
      },
      {
        rfqItemId: 2,
        lineItem: "X2",
        partNo: "P-B",
        description: "Beta",
        uom: null,
        rfqQty: null,
        rfqUnitPrice: null,
        customerRfqId: 2,
        customerRfqNo: "CUST-B",
        customerName: "Globex",
        entryDate: null,
        expiryDate: null,
        buyerName: null,
        poItemId: null,
        poNo: null,
        poDate: null,
        poQty: null,
        poUnitPrice: null,
      },
    ];
    const res = await request(testApp).get("/api/customer-rfq/sheet-view?search=globex");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].customerName).toBe("Globex");
  });

  it("paginates with limit and offset", async () => {
    sheetRows = Array.from({ length: 3 }, (_, i) => ({
      rfqItemId: i + 1,
      lineItem: `L${i}`,
      partNo: null,
      description: `Item ${i}`,
      uom: null,
      rfqQty: null,
      rfqUnitPrice: null,
      customerRfqId: 1,
      customerRfqNo: "CUST-1",
      customerName: "Acme",
      entryDate: null,
      expiryDate: null,
      buyerName: null,
      poItemId: null,
      poNo: null,
      poDate: null,
      poQty: null,
      poUnitPrice: null,
    }));
    const res = await request(testApp).get("/api/customer-rfq/sheet-view?limit=2&offset=1");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0].rfqItemId).toBe(2);
  });

  it("hides rows whose value is in the column's Exclude list (Excel autofilter)", async () => {
    sheetRows = [
      {
        rfqItemId: 1,
        lineItem: "A1",
        partNo: "P-100",
        description: "Widget",
        uom: "pc",
        rfqQty: "5",
        rfqUnitPrice: "120",
        customerRfqId: 1,
        customerRfqNo: "CUST-001",
        customerName: "Acme",
        entryDate: "2025-01-10",
        expiryDate: null,
        buyerName: "Sam",
        poItemId: null,
        poNo: "PO-55",
        poDate: null,
        poQty: null,
        poUnitPrice: null,
      },
      {
        rfqItemId: 2,
        lineItem: "A2",
        partNo: "P-200",
        description: "Widget Pro",
        uom: "set",
        rfqQty: "10",
        rfqUnitPrice: "200",
        customerRfqId: 2,
        customerRfqNo: "CUST-002",
        customerName: "Globex",
        entryDate: "2025-03-10",
        expiryDate: null,
        buyerName: "Alex",
        poItemId: null,
        poNo: null,
        poDate: null,
        poQty: null,
        poUnitPrice: null,
      },
    ];
    // Exclude customerName=Globex → only Acme remains.
    const res = await request(testApp).get(
      "/api/customer-rfq/sheet-view?customerNameExclude=Globex",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].rfqItemId).toBe(1);
  });

  it("shows only rows whose value is in the column's Include list", async () => {
    sheetRows = [
      {
        rfqItemId: 1,
        lineItem: "A1",
        partNo: "P-100",
        description: "Widget",
        uom: "pc",
        rfqQty: "5",
        rfqUnitPrice: "120",
        customerRfqId: 1,
        customerRfqNo: "CUST-001",
        customerName: "Acme",
        entryDate: "2025-01-10",
        expiryDate: null,
        buyerName: "Sam",
        poItemId: null,
        poNo: "PO-55",
        poDate: null,
        poQty: null,
        poUnitPrice: null,
      },
      {
        rfqItemId: 2,
        lineItem: "A2",
        partNo: "P-200",
        description: "Widget Pro",
        uom: "set",
        rfqQty: "10",
        rfqUnitPrice: "200",
        customerRfqId: 2,
        customerRfqNo: "CUST-002",
        customerName: "Globex",
        entryDate: "2025-03-10",
        expiryDate: null,
        buyerName: "Alex",
        poItemId: null,
        poNo: null,
        poDate: null,
        poQty: null,
        poUnitPrice: null,
      },
    ];
    // Include customerName=Acme → only Acme remains.
    const res = await request(testApp).get("/api/customer-rfq/sheet-view?customerNameInclude=Acme");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].rfqItemId).toBe(1);
  });

  it("an empty Include list shows nothing for that column", async () => {
    sheetRows = [
      {
        rfqItemId: 1,
        lineItem: "A1",
        partNo: "P-100",
        description: "Widget",
        uom: "pc",
        rfqQty: "5",
        rfqUnitPrice: "120",
        customerRfqId: 1,
        customerRfqNo: "CUST-001",
        customerName: "Acme",
        entryDate: "2025-01-10",
        expiryDate: null,
        buyerName: "Sam",
        poItemId: null,
        poNo: "PO-55",
        poDate: null,
        poQty: null,
        poUnitPrice: null,
      },
    ];
    // Empty include set (deselect all) → show none.
    const res = await request(testApp).get("/api/customer-rfq/sheet-view?customerNameInclude=");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.rows).toHaveLength(0);
  });

  it("Include takes precedence over Exclude for the same column", async () => {
    sheetRows = [
      {
        rfqItemId: 1,
        lineItem: "A1",
        partNo: "P-100",
        description: "Widget",
        uom: "pc",
        rfqQty: "5",
        rfqUnitPrice: "120",
        customerRfqId: 1,
        customerRfqNo: "CUST-001",
        customerName: "Acme",
        entryDate: "2025-01-10",
        expiryDate: null,
        buyerName: "Sam",
        poItemId: null,
        poNo: "PO-55",
        poDate: null,
        poQty: null,
        poUnitPrice: null,
      },
    ];
    // Include present (even though Exclude also present) → only Acme kept by include.
    const res = await request(testApp).get(
      "/api/customer-rfq/sheet-view?customerNameInclude=Acme&customerNameExclude=Acme",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].rfqItemId).toBe(1);
  });

  it("facets: returns distinct values with counts, ignoring the column's own exclude", async () => {
    sheetRows = [
      {
        rfqItemId: 1,
        lineItem: "A1",
        partNo: "P-100",
        description: "Widget",
        uom: "pc",
        rfqQty: "5",
        rfqUnitPrice: "120",
        customerRfqId: 1,
        customerRfqNo: "CUST-001",
        customerName: "Acme",
        entryDate: "2025-01-10",
        expiryDate: null,
        buyerName: "Sam",
        poItemId: null,
        poNo: "PO-55",
        poDate: null,
        poQty: null,
        poUnitPrice: null,
      },
      {
        rfqItemId: 2,
        lineItem: "A2",
        partNo: "P-200",
        description: "Widget Pro",
        uom: "set",
        rfqQty: "10",
        rfqUnitPrice: "200",
        customerRfqId: 2,
        customerRfqNo: "CUST-002",
        customerName: "Acme",
        entryDate: "2025-03-10",
        expiryDate: null,
        buyerName: "Alex",
        poItemId: null,
        poNo: null,
        poDate: null,
        poQty: null,
        poUnitPrice: null,
      },
      {
        rfqItemId: 3,
        lineItem: "A3",
        partNo: "P-300",
        description: "Widget",
        uom: "pc",
        rfqQty: "5",
        rfqUnitPrice: "120",
        customerRfqId: 3,
        customerRfqNo: "CUST-003",
        customerName: "Globex",
        entryDate: "2025-01-10",
        expiryDate: null,
        buyerName: "Sam",
        poItemId: null,
        poNo: null,
        poDate: null,
        poQty: null,
        poUnitPrice: null,
      },
    ];
    // Facet on customerName while excluding customerName=Globex: the dropdown
    // still lists Globex (its own exclude is ignored) with count 1, and Acme
    // (count 2) — but the count reflects the set AFTER other filters (none here).
    const res = await request(testApp).get(
      "/api/customer-rfq/sheet-view/facets?column=customerName&customerNameExclude=Globex",
    );
    expect(res.status).toBe(200);
    expect(res.body.column).toBe("customerName");
    const acme = res.body.values.find((v: any) => v.value === "Acme");
    const globex = res.body.values.find((v: any) => v.value === "Globex");
    expect(acme?.count).toBe(2);
    expect(globex?.count).toBe(1);
  });

  it("facets: 400 for an unknown column", async () => {
    const res = await request(testApp).get("/api/customer-rfq/sheet-view/facets?column=nope");
    expect(res.status).toBe(400);
  });

  it("flag column: surfaces a rejected-delivery reason and a cost overrun, and facets list them", async () => {
    sheetRows = [
      {
        rfqItemId: 1,
        lineItem: "A1",
        partNo: "P-100",
        description: "Widget",
        uom: "pc",
        rfqQty: "5",
        rfqUnitPrice: "120",
        customerRfqId: 1,
        customerRfqNo: "26R008464",
        customerName: "Acme",
        entryDate: "2025-01-10",
        expiryDate: null,
        buyerName: "Sam",
        poItemId: 90,
        poNo: "PO-55",
        poDate: "2025-01-20",
        poQty: "3",
        poUnitPrice: "130",
        deliveryStatus: "rejected",
        poFinalActualCost: "150",
        poReferencePrice: "130",
      },
      {
        rfqItemId: 2,
        lineItem: "A2",
        partNo: "P-200",
        description: "Clean row",
        uom: "pc",
        rfqQty: "1",
        rfqUnitPrice: "10",
        customerRfqId: 1,
        customerRfqNo: "26R008464",
        customerName: "Acme",
        entryDate: "2025-01-10",
        expiryDate: null,
        buyerName: "Sam",
        poItemId: null,
        poNo: null,
        poDate: null,
        poQty: null,
        poUnitPrice: null,
        deliveryStatus: null,
        poFinalActualCost: null,
        poReferencePrice: null,
      },
    ];
    sheetRejectedDeliveries = [
      { customerPoItemId: 90, reason: "تالف", createdAt: new Date("2025-02-01") },
    ];
    const res = await request(testApp).get("/api/customer-rfq/sheet-view");
    expect(res.status).toBe(200);
    // Row 0: rejected delivery (reason تالف) AND cost overrun (150 > 130).
    expect(res.body.rows[0].flagged).toBe(true);
    expect(res.body.rows[0].flagReason).toContain("رفض التسليم: تالف");
    expect(res.body.rows[0].flagReason).toContain("تجاوزت التكلفة");
    // Row 1: clean.
    expect(res.body.rows[1].flagged).toBe(false);
    expect(res.body.rows[1].flagReason).toBeNull();

    // The «السبب» filter dropdown now lists the computed flag reason(s) — not
    // "لا توجد قيم" — plus the (فارغ) entry for clean rows.
    const facets = await request(testApp).get(
      "/api/customer-rfq/sheet-view/facets?column=flagReason",
    );
    expect(facets.status).toBe(200);
    expect(facets.body.column).toBe("flagReason");
    const values = facets.body.values.map((v: any) => v.value);
    expect(values).toContain(res.body.rows[0].flagReason);
    expect(values).toContain(""); // clean rows → empty
  });

  it("flag column: the flagReason filter narrows the table to flagged rows only", async () => {
    const reason = "رفض التسليم: تالف";
    sheetRows = [
      {
        rfqItemId: 1,
        lineItem: "A1",
        partNo: "P-1",
        description: "Bad",
        uom: "pc",
        rfqQty: "5",
        rfqUnitPrice: "120",
        customerRfqId: 1,
        customerRfqNo: "26R008464",
        customerName: "Acme",
        entryDate: "2025-01-10",
        expiryDate: null,
        buyerName: "Sam",
        poItemId: 90,
        poNo: "PO-55",
        poDate: null,
        poQty: "3",
        poUnitPrice: "130",
        deliveryStatus: "rejected",
        poFinalActualCost: null,
        poReferencePrice: null,
      },
      {
        rfqItemId: 2,
        lineItem: "A2",
        partNo: "P-2",
        description: "Good",
        uom: "pc",
        rfqQty: "1",
        rfqUnitPrice: "10",
        customerRfqId: 1,
        customerRfqNo: "26R008464",
        customerName: "Acme",
        entryDate: "2025-01-10",
        expiryDate: null,
        buyerName: "Sam",
        poItemId: null,
        poNo: null,
        poDate: null,
        poQty: null,
        poUnitPrice: null,
        deliveryStatus: null,
        poFinalActualCost: null,
        poReferencePrice: null,
      },
    ];
    sheetRejectedDeliveries = [
      { customerPoItemId: 90, reason: "تالف", createdAt: new Date("2025-02-01") },
    ];
    const res = await request(testApp).get(
      `/api/customer-rfq/sheet-view?flagReasonInclude=${encodeURIComponent(reason)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].rfqItemId).toBe(1);
    expect(res.body.rows[0].flagReason).toBe(reason);
  });
});

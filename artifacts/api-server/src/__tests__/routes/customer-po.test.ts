import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth ───────────────────────────────────────────────────────────────
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) => {
    if (!roles.includes(req.session?.role ?? "")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  },
}));

// ── Chainable + thenable DB mock ─────────────────────────────────────────────
// An object that is BOTH awaitable (`.then`) and exposes chain methods. Each
// chain method returns a chainable of `value`.
function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

// Tables referenced by .from() / eq() / .references() — truthy markers.
const poTable = { _: "customerPos", createdAt: "createdAt", id: "id", internalPoNo: "internalPoNo" };
const poItemsTable = { _: "customerPoItems", customerPoId: "customerPoId", id: "id" };
const rfqsTable = { _: "customerRfqs", customerName: "customerName", createdAt: "createdAt" };
const employeesTbl = { _: "employees", id: "id", name: "name" };
const auditTable = { _: "audit" };
// Supplier-PO tables used by the derived fulfillment status (po_issued check).
const purchaseOrdersTbl = { _: "purchaseOrders", status: "status", sheetPoNo: "sheetPoNo", id: "id" };
const purchaseOrderItemsTbl = { _: "purchaseOrderItems", poId: "poId", customerPoItemId: "customerPoItemId", customerPoId: "customerPoId" };
const tables = {
  customerPosTable: poTable,
  customerPoItemsTable: poItemsTable,
  customerRfqsTable: rfqsTable,
  employeesTable: employeesTbl,
  auditLogTable: auditTable,
  purchaseOrdersTable: purchaseOrdersTbl,
  purchaseOrderItemsTable: purchaseOrderItemsTbl,
};

// Per-test state.
let listRows: any[]; // GET /customer-po list rows: { po: {...} }
let countRows: any[]; // item-count aggregate: { customerPoId, cnt }
let countRow: { maxNo: string | null }; // generateInternalPoNo: { maxNo }
let insertedPo: any; // base row returned by insert().returning()
let detailRow: any | null; // the customer PO itself (bare select)
let detailItems: any[]; // customer_po_items for a PO
let employeeRow: { name: string } | null; // POST employee name lookup
let rfqRows: any[]; // resolveRfqNos: select({id,no}).from(rfqs).where() → [{id, no}]
// Dispatched supplier POs (status="sent") — for the po_issued fulfillment check.
let dispatchedPoRows: any[]; // [{ sheetPoNo }]
// Item-level links: dispatched supplier-PO items joined to customer_po_items.
let linkedPoItemRows: any[]; // [{ customerPoId }]
// resolveReceivedRollup: item-level link rows (customer_po_items joined to
// accepted supplier PO items) + supplier-item rows (by poId).
let receivedItemRows: any[]; // [{ customerPoItemId, lineStatus, acceptedQty, customerPoId }]
let supplierItemRows: any[]; // [{ poId, lineItem, lineStatus, acceptedQty }]
// Tracks exact values written to customer_po_items so tests can assert
// links (insert) or updates (update).
const insertedItems: any[] = [];
const updateCalls: any[] = [];

// Mutable session so tests can flip role/state.
const sessionState: { employeeId: number; role?: string } = { employeeId: 1 };

const dbMock: any = {
  select: vi.fn((arg?: any) => ({
    from: vi.fn((table: any) => {
      // generateInternalPoNo: select({maxNo}).from(poTable).where() — awaited directly.
      if (table === poTable && arg && typeof arg === "object" && "maxNo" in arg) {
        return chainable([{ maxNo: countRow.maxNo }], {
          where: vi.fn(() => chainable([{ maxNo: countRow.maxNo }])),
        });
      }
      // PO list: select({po}).from(poTable).orderBy()
      if (table === poTable) {
        const bare = arg === undefined;
        const wrapped = bare
          ? detailRow
            ? [detailRow]
            : []
          : listRows;
        return chainable(wrapped, {
          orderBy: vi.fn(() => chainable(listRows)),
          where: vi.fn(() => chainable(wrapped)),
        });
      }
      // item-count aggregate: select({customerPoId, cnt}).from(poItems).where().groupBy()
      if (table === poItemsTable && arg && typeof arg === "object" && "cnt" in arg) {
        return chainable(countRows, {
          where: vi.fn(() => chainable(countRows, { groupBy: vi.fn(() => chainable(countRows)) })),
          groupBy: vi.fn(() => chainable(countRows)),
        });
      }
      // customerPoItemIdsFor / delivery rollup: select({id | customerPoId, deliveryStatus})
      // .from(poItems).where(inArray(...)) — return detailItems (the per-test items).
      // Also resolveReceivedRollup item-level: select({...}).from(poItems)
      // .innerJoin(purchaseOrderItems, ...).where(inArray(...)) — return receivedItemRows.
      if (table === poItemsTable) {
        return chainable(detailItems, {
          where: vi.fn(() => chainable(detailItems)),
          innerJoin: vi.fn(() =>
            chainable(receivedItemRows, {
              where: vi.fn(() => chainable(receivedItemRows)),
            }),
          ),
        });
      }
      // Item-level po_issued link: select({customerPoId}).from(purchaseOrderItems)
      // .innerJoin(purchaseOrders).innerJoin(customerPoItems).where(and(...))
      // — return linkedPoItemRows (each carries the owning customerPoId).
      // resolveReceivedRollup supplier-items: select({poId,lineItem,...})
      // .from(purchaseOrderItems).where(inArray(poId)) — return supplierItemRows.
      if (table === purchaseOrderItemsTbl) {
        return chainable(linkedPoItemRows, {
          innerJoin: vi.fn(() =>
            chainable(linkedPoItemRows, {
              innerJoin: vi.fn(() =>
                chainable(linkedPoItemRows, { where: vi.fn(() => chainable(linkedPoItemRows)) }),
              ),
              where: vi.fn(() => chainable(linkedPoItemRows)),
            }),
          ),
          where: vi.fn(() => chainable(supplierItemRows)),
        });
      }
      // Header-level po_issued fallback: select({sheetPoNo}).from(purchaseOrders)
      // .where(eq(status,"sent")) — return dispatchedPoRows.
      if (table === purchaseOrdersTbl) {
        return chainable(dispatchedPoRows, {
          where: vi.fn(() => chainable(dispatchedPoRows)),
        });
      }
      // Employee name lookup: select({name}).from(employees).where().limit()
      if (table === employeesTbl) {
        const rows = employeeRow ? [employeeRow] : [];
        return chainable(rows, {
          where: vi.fn(() => chainable(rows, { limit: vi.fn(() => chainable(rows)) })),
          limit: vi.fn(() => chainable(rows)),
        });
      }
      // customer-rfqs picker list: select({...}).from(rfqs).orderBy()
      // (also serves resolveRfqNos: select({id,no}).from(rfqs).where(inArray))
      if (table === rfqsTable) {
        // resolveRfqNos passes a select with `no`/`id`; return rfqRows.
        const isRfqNoLookup = arg && typeof arg === "object" && "no" in arg;
        const rows = isRfqNoLookup ? rfqRows : [];
        return chainable(rows, {
          orderBy: vi.fn(() => chainable([])),
          where: vi.fn(() => chainable(rows)),
        });
      }
      return chainable([], {
        where: vi.fn(() => chainable([], { limit: vi.fn(() => chainable([])) })),
        orderBy: vi.fn(() => chainable([])),
      });
    }),
  })),
  insert: vi.fn((table: any) => ({
    values: vi.fn((vals: any) => {
      if (table === poItemsTable) {
        if (Array.isArray(vals)) insertedItems.push(...vals);
        else insertedItems.push(vals);
        return chainable(undefined);
      }
      // audit insert (no returning) — just resolve.
      if (table === auditTable) return chainable(undefined);
      // PO insert: reflect values over the default row so tests can assert.
      return { returning: vi.fn(() => chainable([{ ...insertedPo, ...vals }])) };
    }),
  })),
  update: vi.fn((table: any) => ({
    // Reflect updates onto detailRow so the post-update re-select sees new
    // values — but ONLY for PO-header updates (a customer_po_items update,
    // e.g. the cancel-removed-items pass, must not clobber the header row).
    set: vi.fn((vals: any) => {
      updateCalls.push(vals);
      if (table === poTable && vals && typeof vals === "object" && detailRow) {
        detailRow = { ...detailRow, ...vals };
      }
      return { where: vi.fn(() => chainable(undefined)) };
    }),
  })),
  delete: vi.fn((_table: any) => ({
    where: vi.fn(() => chainable(undefined)),
  })),
};

vi.mock("@workspace/db", () => ({ ...tables, db: dbMock }));

let testApp: express.Express;

beforeAll(async () => {
  const { default: customerPoRouter } = await import("../../modules/customer-po/index");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = sessionState;
    next();
  });
  testApp.use("/api", customerPoRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  listRows = [];
  countRows = [];
  countRow = { maxNo: null };
  insertedPo = {
    id: 7,
    internalPoNo: "CPO-2025-000001",
    customerPoNo: "CUST-PO-1",
    customerId: null,
    customerName: null,
    poDate: null,
    buyerName: null,
    employeeId: null,
    employeeName: null,
    notes: null,
    status: "draft",
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-02"),
  };
  detailRow = null;
  detailItems = [];
  employeeRow = { name: "Tester" };
  rfqRows = [];
  dispatchedPoRows = [];
  linkedPoItemRows = [];
  receivedItemRows = [];
  supplierItemRows = [];
  sessionState.role = undefined;
  insertedItems.length = 0;
  updateCalls.length = 0;
});

describe("POST /api/customer-po (create)", () => {
  it("creates a PO, auto-generates the internal number, records the employee, and links items to RFQ items", async () => {
    const res = await request(testApp).post("/api/customer-po").send({
      customerPoNo: "PO-100",
      customerId: 5,
      customerName: "Acme",
      poDate: "2025-02-03",
      buyerName: "Buyer One",
      items: [
        {
          customerRfqId: 3,
          customerRfqItemId: 11,
          partNo: "P1",
          lineItem: "A B C",
          description: "  وصف  ",
          uom: "pc",
          qty: 5,
          unitPrice: 12.5,
          deliveryDate: "2025-03-01",
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.internalPoNo).toMatch(/^CPO-\d{4}-/);
    expect(res.body.customerPoNo).toBe("PO-100");
    expect(res.body.customerId).toBe(5);
    expect(res.body.customerName).toBe("Acme");
    // The entering employee is auto-recorded from the session.
    expect(res.body.employeeName).toBe("Tester");
    expect(res.body.employeeId).toBe(sessionState.employeeId);

    // Inserted item carries the RFQ links and stripped lineItem.
    expect(insertedItems).toHaveLength(1);
    expect(insertedItems[0].customerRfqId).toBe(3);
    expect(insertedItems[0].customerRfqItemId).toBe(11);
    expect(insertedItems[0].lineItem).toBe("ABC");
    expect(insertedItems[0].description).toBe("وصف");
    expect(insertedItems[0].deliveryDate).toBe("2025-03-01");
    expect(insertedItems[0].qty).toBe("5");
    expect(insertedItems[0].unitPrice).toBe("12.5");
  });

  it("returns 400 when customerPoNo is missing", async () => {
    const res = await request(testApp).post("/api/customer-po").send({
      customerName: "Acme",
      items: [{ partNo: "P1", qty: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when customerName is missing (customer must be selected)", async () => {
    const res = await request(testApp).post("/api/customer-po").send({
      customerPoNo: "PO-X",
      items: [{ partNo: "P1", qty: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("العميل");
  });

  it("returns 400 when no valid items are provided", async () => {
    const res = await request(testApp).post("/api/customer-po").send({
      customerPoNo: "PO-X",
      customerName: "Acme",
      items: [{ partNo: "P1" }], // no qty → filtered out
    });
    expect(res.status).toBe(400);
  });

  it("accepts manual items with no customer RFQ link (customerName from the picker)", async () => {
    const res = await request(testApp).post("/api/customer-po").send({
      customerPoNo: "PO-101",
      customerName: "Walk-in",
      items: [{ description: "Manual item", uom: "pc", qty: 2, unitPrice: 5 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.customerName).toBe("Walk-in");
    expect(insertedItems[0].customerRfqId).toBeNull();
    expect(insertedItems[0].customerRfqItemId).toBeNull();
    expect(insertedItems[0].description).toBe("Manual item");
  });

  it("allows the same customer RFQ item on a second PO (partial shipment — no uniqueness error)", async () => {
    const res = await request(testApp).post("/api/customer-po").send({
      customerPoNo: "PO-102",
      customerName: "Acme",
      items: [{ customerRfqId: 3, customerRfqItemId: 11, partNo: "P1", qty: 2, unitPrice: 10 }],
    });
    expect(res.status).toBe(201);
    // The same item id (11) was persisted — the schema does not enforce uniqueness.
    expect(insertedItems[0].customerRfqItemId).toBe(11);
  });
});

describe("GET /api/customer-po (list)", () => {
  it("returns the list with item counts and stored customer names", async () => {
    listRows = [{ po: { ...insertedPo, id: 7, customerPoNo: "PO-100", buyerName: "B", customerName: "Acme" } }];
    countRows = [{ customerPoId: 7, cnt: 4 }];
    const res = await request(testApp).get("/api/customer-po");
    expect(res.status).toBe(200);
    expect(res.body[0].internalPoNo).toBe("CPO-2025-000001");
    expect(res.body[0].itemCount).toBe(4);
    expect(res.body[0].customerName).toBe("Acme");
    // Derived fulfillment status is always present on the list row.
    expect(res.body[0].fulfillmentStatus).toBeTruthy();
    expect(res.body[0].fulfillmentStatus.stage).toBe("draft");
  });

  it("filters by search term (client-side) without erroring", async () => {
    listRows = [{ po: { ...insertedPo, customerPoNo: "PO-100", buyerName: "B", customerName: "Acme" } }];
    countRows = [];
    const res = await request(testApp).get("/api/customer-po?search=PO-100");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

// ── Derived fulfillment status (حالة الطلب) ───────────────────────────────────
// The customer-PO list/detail surface a computed `fulfillmentStatus` that
// advances automatically: draft → sent → po_issued (a supplier PO was
// dispatched) → delivered (partial %) → fulfilled (all items delivered).
describe("Customer PO fulfillment status (derived)", () => {
  it("shows po_issued when a dispatched supplier PO matches the customerPoNo (header fallback)", async () => {
    listRows = [{ po: { ...insertedPo, id: 7, customerPoNo: "CUST-1", status: "sent" } }];
    countRows = [{ customerPoId: 7, cnt: 2 }];
    detailItems = [{ id: 1, customerPoId: 7, deliveryStatus: "pending" }, { id: 2, customerPoId: 7, deliveryStatus: "pending" }];
    // A supplier PO with status=sent and sheetPoNo matching the customer PO.
    dispatchedPoRows = [{ sheetPoNo: "CUST-1" }];
    const res = await request(testApp).get("/api/customer-po");
    expect(res.status).toBe(200);
    expect(res.body[0].fulfillmentStatus.stage).toBe("po_issued");
    expect(res.body[0].fulfillmentStatus.poIssued).toBe(true);
  });

  it("shows po_issued when a dispatched supplier PO links via customerPoItemId", async () => {
    listRows = [{ po: { ...insertedPo, id: 7, customerPoNo: "CUST-2", status: "sent" } }];
    countRows = [{ customerPoId: 7, cnt: 1 }];
    detailItems = [{ id: 50, customerPoId: 7, deliveryStatus: "pending" }];
    linkedPoItemRows = [{ customerPoId: 7 }];
    const res = await request(testApp).get("/api/customer-po");
    expect(res.status).toBe(200);
    expect(res.body[0].fulfillmentStatus.stage).toBe("po_issued");
  });

  it("shows delivered with the delivered-items percentage", async () => {
    listRows = [{ po: { ...insertedPo, id: 7, customerPoNo: "CUST-3", status: "sent" } }];
    countRows = [{ customerPoId: 7, cnt: 4 }];
    // 4 items, 2 delivered → 50%.
    detailItems = [
      { id: 1, customerPoId: 7, deliveryStatus: "delivered" },
      { id: 2, customerPoId: 7, deliveryStatus: "delivered" },
      { id: 3, customerPoId: 7, deliveryStatus: "partial" },
      { id: 4, customerPoId: 7, deliveryStatus: "pending" },
    ];
    dispatchedPoRows = [{ sheetPoNo: "CUST-3" }];
    const res = await request(testApp).get("/api/customer-po");
    expect(res.status).toBe(200);
    expect(res.body[0].fulfillmentStatus.stage).toBe("delivered");
    expect(res.body[0].fulfillmentStatus.deliveredItems).toBe(2);
    expect(res.body[0].fulfillmentStatus.totalItems).toBe(4);
    expect(res.body[0].fulfillmentStatus.deliveredPct).toBe(50);
  });

  it("shows fulfilled when every item is delivered", async () => {
    listRows = [{ po: { ...insertedPo, id: 7, customerPoNo: "CUST-4", status: "sent" } }];
    countRows = [{ customerPoId: 7, cnt: 2 }];
    detailItems = [
      { id: 1, customerPoId: 7, deliveryStatus: "delivered" },
      { id: 2, customerPoId: 7, deliveryStatus: "delivered" },
    ];
    dispatchedPoRows = [{ sheetPoNo: "CUST-4" }];
    const res = await request(testApp).get("/api/customer-po");
    expect(res.status).toBe(200);
    expect(res.body[0].fulfillmentStatus.stage).toBe("fulfilled");
    expect(res.body[0].fulfillmentStatus.deliveredPct).toBe(100);
  });

  it("stays at sent when finalized but no supplier PO dispatched and nothing delivered", async () => {
    listRows = [{ po: { ...insertedPo, id: 7, customerPoNo: "CUST-5", status: "sent" } }];
    countRows = [{ customerPoId: 7, cnt: 1 }];
    detailItems = [{ id: 1, customerPoId: 7, deliveryStatus: "pending" }];
    const res = await request(testApp).get("/api/customer-po");
    expect(res.status).toBe(200);
    expect(res.body[0].fulfillmentStatus.stage).toBe("sent");
    expect(res.body[0].fulfillmentStatus.poIssued).toBe(false);
  });

  it("exposes fulfillmentStatus on the detail response too", async () => {
    detailRow = { ...insertedPo, customerPoNo: "CUST-6", status: "sent" };
    detailItems = [
      { id: 1, customerPoId: 7, deliveryStatus: "delivered", createdAt: new Date("2025-01-05") },
      { id: 2, customerPoId: 7, deliveryStatus: "pending", createdAt: new Date("2025-01-05") },
    ];
    dispatchedPoRows = [{ sheetPoNo: "CUST-6" }];
    const res = await request(testApp).get("/api/customer-po/7");
    expect(res.status).toBe(200);
    expect(res.body.fulfillmentStatus.stage).toBe("delivered");
    expect(res.body.fulfillmentStatus.deliveredPct).toBe(50);
  });
});


describe("GET /api/customer-po/:id", () => {
  it("returns 404 when not found", async () => {
    detailRow = null;
    const res = await request(testApp).get("/api/customer-po/999");
    expect(res.status).toBe(404);
  });

  it("returns the PO with formatted items when found", async () => {
    detailRow = { ...insertedPo, customerName: "Acme" };
    detailItems = [
      {
        id: 1,
        customerPoId: 7,
        customerRfqId: 3,
        customerRfqItemId: 11,
        partNo: "P1",
        lineItem: "ABC",
        description: "وصف",
        uom: "pc",
        qty: "3.0000",
        unitPrice: "10.0000",
        deliveryDate: "2025-03-01",
        createdAt: new Date("2025-01-03"),
      },
    ];
    rfqRows = [{ id: 3, no: "25R010001" }];
    const res = await request(testApp).get("/api/customer-po/7");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    expect(res.body.customerName).toBe("Acme");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].qty).toBe("3");
    expect(res.body.items[0].unitPrice).toBe("10");
    expect(res.body.items[0].total).toBe("30");
    expect(res.body.items[0].deliveryDate).toBe("2025-03-01");
    // The linked customer RFQ number is resolved and exposed per item.
    expect(res.body.items[0].customerRfqId).toBe(3);
    expect(res.body.items[0].customerRfqNo).toBe("25R010001");
  });

  it("exposes customerRfqNo=null for items without an RFQ link", async () => {
    detailRow = { ...insertedPo, customerName: "Acme" };
    detailItems = [
      {
        id: 2,
        customerPoId: 7,
        customerRfqId: null,
        customerRfqItemId: null,
        partNo: "P2",
        lineItem: "XYZ",
        description: "",
        uom: "pc",
        qty: "1.0000",
        unitPrice: "5.0000",
        deliveryDate: null,
        createdAt: new Date("2025-01-04"),
      },
    ];
    const res = await request(testApp).get("/api/customer-po/7");
    expect(res.status).toBe(200);
    expect(res.body.items[0].customerRfqNo).toBeNull();
  });
});

describe("PATCH /api/customer-po/:id", () => {
  it("updates draft fields and replaces items", async () => {
    detailRow = { ...insertedPo };
    detailItems = [];

    const res = await request(testApp)
      .patch("/api/customer-po/7")
      .send({
        customerPoNo: "PO-200",
        customerName: "Acme Updated",
        buyerName: "New Buyer",
        items: [{ customerRfqId: 3, customerRfqItemId: 11, partNo: "P1", qty: 1, unitPrice: 9 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.customerPoNo).toBe("PO-200");
    expect(res.body.customerName).toBe("Acme Updated");
    expect(insertedItems[0].customerRfqItemId).toBe(11);
    expect(insertedItems[0].lineItem).toBeNull(); // lineItem "" → null
  });

  it("finalizes the PO (status → sent) when status:sent is sent", async () => {
    detailRow = { ...insertedPo };
    detailItems = [];
    const res = await request(testApp).patch("/api/customer-po/7").send({ status: "sent" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
  });

  it("soft-cancels removed items instead of hard-deleting them (keeps flag data for the sheet view)", async () => {
    detailRow = { ...insertedPo };
    // Two existing RFQ-linked items; the PATCH keeps only item 11 → item 22
    // (id 55) is detached (customerPoId → null) and marked "cancelled".
    detailItems = [
      { id: 42, customerPoId: 7, customerRfqItemId: 11, customerRfqId: 3, qty: "1.0000", unitPrice: "5.0000", createdAt: new Date("2025-01-03"), deliveryStatus: "pending" },
      { id: 55, customerPoId: 7, customerRfqItemId: 22, customerRfqId: 3, qty: "2.0000", unitPrice: "7.0000", createdAt: new Date("2025-01-04"), deliveryStatus: "pending" },
    ];
    const res = await request(testApp)
      .patch("/api/customer-po/7")
      .send({
        items: [{ customerRfqId: 3, customerRfqItemId: 11, partNo: "P1", qty: 1, unitPrice: 5 }],
      });
    expect(res.status).toBe(200);
    // The removed item was UPDATED to a cancelled detached row (not hard-deleted):
    // its qty/price wiped, deliveryStatus → "cancelled", but its RFQ link,
    // rejection/highlight history and PO number survive for the items sheet view.
    expect(updateCalls).toContainEqual(
      expect.objectContaining({
        customerPoId: null,
        qty: null,
        unitPrice: null,
        deliveryDate: null,
        deliveryStatus: "cancelled",
      }),
    );
    // Kept item re-inserted as before.
    expect(insertedItems).toHaveLength(1);
    expect(insertedItems[0].customerRfqItemId).toBe(11);
  });

  it("hard-deletes everything when nothing was already attached (previous rows empty)", async () => {
    detailRow = { ...insertedPo };
    detailItems = []; // no previous rows → no cancelled update, plain delete+insert
    const res = await request(testApp)
      .patch("/api/customer-po/7")
      .send({ items: [{ partNo: "P1", qty: 1 }] });
    expect(res.status).toBe(200);
    expect(updateCalls.find((u) => u.deliveryStatus === "cancelled")).toBeUndefined();
    expect(insertedItems).toHaveLength(1);
  });

  it("rejects editing a PO that is already sent (no session role)", async () => {
    detailRow = { ...insertedPo, status: "sent" };
    const res = await request(testApp).patch("/api/customer-po/7").send({ buyerName: "X" });
    expect(res.status).toBe(400);
  });

  it("rejects editing a sent PO for a non-privileged role", async () => {
    sessionState.role = "data_entry";
    detailRow = { ...insertedPo, status: "sent" };
    const res = await request(testApp).patch("/api/customer-po/7").send({ buyerName: "X" });
    expect(res.status).toBe(400);
  });

  it("allows an admin to fully edit a sent PO", async () => {
    sessionState.role = "admin";
    detailRow = { ...insertedPo, status: "sent" };
    detailItems = [];
    const res = await request(testApp)
      .patch("/api/customer-po/7")
      .send({ buyerName: "X", notes: "n" });
    expect(res.status).toBe(200);
    expect(res.body.buyerName).toBe("X");
    expect(res.body.notes).toBe("n");
  });

  it("allows a manager to fully edit a sent PO", async () => {
    sessionState.role = "manager";
    detailRow = { ...insertedPo, status: "sent" };
    detailItems = [];
    const res = await request(testApp)
      .patch("/api/customer-po/7")
      .send({ buyerName: "Manager edit" });
    expect(res.status).toBe(200);
    expect(res.body.buyerName).toBe("Manager edit");
  });

  it("returns 404 when the PO does not exist", async () => {
    detailRow = null;
    const res = await request(testApp).patch("/api/customer-po/999").send({ buyerName: "X" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/customer-po/:id", () => {
  it("deletes a draft PO", async () => {
    detailRow = { ...insertedPo };
    const res = await request(testApp).delete("/api/customer-po/7");
    expect(res.status).toBe(204);
  });

  it("rejects deleting a PO that is already sent", async () => {
    detailRow = { ...insertedPo, status: "sent" };
    const res = await request(testApp).delete("/api/customer-po/7");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the PO does not exist", async () => {
    detailRow = null;
    const res = await request(testApp).delete("/api/customer-po/999");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/customer-po/items/:itemId/highlight", () => {
  it("sets a highlight color + note (admin)", async () => {
    sessionState.role = "admin";
    detailItems = [{ id: 42, customerPoId: 7 }];
    const res = await request(testApp)
      .patch("/api/customer-po/items/42/highlight")
      .send({ highlightColor: "yellow", highlightNote: "متابعة مع العميل" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      itemId: 42,
      highlightColor: "yellow",
      highlightNote: "متابعة مع العميل",
    });
    expect(updateCalls).toContainEqual({ highlightColor: "yellow", highlightNote: "متابعة مع العميل" });
  });

  it("clears the highlight with { clear: true } (accountant)", async () => {
    sessionState.role = "accountant";
    detailItems = [{ id: 42, customerPoId: 7 }];
    const res = await request(testApp)
      .patch("/api/customer-po/items/42/highlight")
      .send({ clear: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, highlightColor: null, highlightNote: null });
    expect(updateCalls).toContainEqual({ highlightColor: null, highlightNote: null });
  });

  it("rejects an unknown color", async () => {
    sessionState.role = "admin";
    detailItems = [{ id: 42, customerPoId: 7 }];
    const res = await request(testApp)
      .patch("/api/customer-po/items/42/highlight")
      .send({ highlightColor: "neon" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the item does not exist", async () => {
    sessionState.role = "admin";
    detailItems = [];
    const res = await request(testApp)
      .patch("/api/customer-po/items/999/highlight")
      .send({ highlightColor: "yellow" });
    expect(res.status).toBe(404);
  });

  it("403 for a role that is not admin/accountant/manager", async () => {
    sessionState.role = "purchasing";
    detailItems = [{ id: 42, customerPoId: 7 }];
    const res = await request(testApp)
      .patch("/api/customer-po/items/42/highlight")
      .send({ highlightColor: "yellow" });
    expect(res.status).toBe(403);
    expect(updateCalls).toHaveLength(0);
  });

  it("403 without a session role", async () => {
    sessionState.role = undefined;
    const res = await request(testApp)
      .patch("/api/customer-po/items/42/highlight")
      .send({ highlightColor: "yellow" });
    expect(res.status).toBe(403);
  });
});


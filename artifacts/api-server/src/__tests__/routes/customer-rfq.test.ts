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
const customerRfqsTbl = {
  _: "customerRfqs",
  customerRfqNo: "customerRfqNo",
  customerRfqNumber: "customerRfqNo",
  createdAt: "createdAt",
  id: "id",
};
const rfqTable = { _: "supplierRfqs", customerRfqNo: "customerRfqNo", id: "id" };
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
  customerRfqsTable: customerRfqsTbl,
  rfqTable, // supplier rfqs (used by the legacy fallback scope join)
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
// Row returned by generateInternalNo's MAX lookup: { maxNo: string | null }.
let maxNoRow: { maxNo: string | null };
// Rows returned by the customer-RFQ-number uniqueness probe (assertRfqNoIsUnique):
// each is { id: number } and a non-empty result marks the number as taken.
let existingIdRows: any[];
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
// RFQ headers for the sheet view's "requests with no items" rows. Left null by
// default so the mock derives them from the current `sheetRows` (tests assign
// sheetRows after beforeEach); set it to an array to assert explicitly.
let sheetRfqHeaders: any[] | null = null;
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
// Ids updated in place on customer_rfq_items (the save preserves ids so the
// customer-PO / supplier-offer links survive) and ids deleted outright.
const updatedItemIds: number[] = [];
const deletedItemIds: number[] = [];
// Audit-log rows written during a test (e.g. the margin-deviation entry).
const auditInserts: any[] = [];

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
      // generateInternalNo: select({maxNo: sql`max(...)`}).from(rfqTable).where() — awaited directly.
      if (table === customerRfqsTbl && arg && typeof arg === "object" && "maxNo" in arg) {
        return chainable([maxNoRow], {
          where: vi.fn(() => chainable([maxNoRow])),
        });
      }
      // uniqueness probe: select({id}).from(rfqTable)..where(and(...)).limit(1) — awaited directly.
      if (
        table === customerRfqsTbl &&
        arg &&
        typeof arg === "object" &&
        "id" in arg &&
        !("rfq" in arg)
      ) {
        return chainable(existingIdRows, {
          where: vi.fn(() =>
            chainable(existingIdRows, { limit: vi.fn(() => chainable(existingIdRows)) }),
          ),
          limit: vi.fn(() => chainable(existingIdRows)),
        });
      }
      // generateInternalNo: select({cnt: count()}).from(rfqTable).) — awaited directly.

      if (table === customerRfqsTbl && arg && typeof arg === "object" && "cnt" in arg) {
        return chainable([countRow]);
      }
      // sheet-view: select({customerRfqId,...}).from(customerRfqs) with no join —
      // every RFQ header, used to surface requests that have no item rows.
      // Derived from the current sheetRows unless a test set it explicitly.
      if (
        table === customerRfqsTbl &&
        arg &&
        typeof arg === "object" &&
        "customerRfqId" in arg &&
        !("rfq" in arg)
      ) {
        const headers =
          sheetRfqHeaders ??
          Array.from(
            new Map(
              sheetRows
                .filter((r: any) => r.customerRfqId != null && r.rfqItemId != null)
                .map((r: any) => [
                  r.customerRfqId,
                  {
                    customerRfqId: r.customerRfqId,
                    customerRfqNo: r.customerRfqNo ?? null,
                    customerName: r.customerName ?? null,
                    entryDate: r.entryDate ?? null,
                    expiryDate: r.expiryDate ?? null,
                    buyerName: r.buyerName ?? null,
                  },
                ]),
            ).values(),
          );
        return chainable(headers);
      }
      // rfq list/detail (select {rfq: ...} or bare select)
      if (table === customerRfqsTbl) {
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
        // sheet-view: select({...}).from(items).innerJoin(rfqs) — returns the
        // RFQ side of the per-test sheetRows (the PO side is served by the
        // customerPoItems branch below, so the route pairs them itself).
        if (arg && typeof arg === "object" && "rfqItemId" in arg) {
          const rfqViews = sheetRows
            .filter((r: any) => r.rfqItemId != null)
            .map((r: any) => ({
              rfqItemId: r.rfqItemId,
              lineItem: r.lineItem ?? null,
              partNo: r.partNo ?? null,
              description: r.description ?? null,
              uom: r.uom ?? null,
              rfqQty: r.rfqQty ?? null,
              rfqUnitPrice: r.rfqUnitPrice ?? null,
              customerRfqId: r.customerRfqId ?? null,
              customerRfqNo: r.customerRfqNo ?? null,
              customerName: r.customerName ?? null,
              entryDate: r.entryDate ?? null,
              expiryDate: r.expiryDate ?? null,
              buyerName: r.buyerName ?? null,
              rfqCreatedAt: new Date(0),
            }));
          return chainable(rfqViews, {
            innerJoin: vi.fn(() => chainable(rfqViews)),
          });
        }
        return chainable(detailItems, {
          where: vi.fn(() => chainable(detailItems)),
        });
      }
      // Sheet-view PO side: select({...}).from(customerPoItems).innerJoin(
      // customerPos) — the per-test sheetRows' PO columns, keyed to their RFQ
      // item by customerRfqItemId (null ⇒ an RFQ-less line).
      if (table === customerPoItemsTbl && arg && typeof arg === "object" && "poNo" in arg) {
        const toPoView = (r: any) => ({
          poItemId: r.poItemId,
          customerRfqId: r.customerRfqId ?? null,
          // A row may explicitly declare a severed item link (null) while
          // still carrying the RFQ item + partNo it belongs to.
          customerRfqItemId: "poLinkRfqItemId" in r ? r.poLinkRfqItemId : (r.rfqItemId ?? null),
          lineItem: r.lineItem ?? null,
          partNo: r.partNo ?? null,
          description: r.description ?? null,
          uom: r.uom ?? null,
          poQty: r.poQty ?? null,
          poUnitPrice: r.poUnitPrice ?? null,
          deliveryStatus: r.deliveryStatus ?? null,
          highlightColor: r.highlightColor ?? null,
          highlightNote: r.highlightNote ?? null,
          poNo: r.poNo ?? null,
          poDate: r.poDate ?? null,
        });
        const allPoViews = sheetRows.filter((r: any) => r.poItemId != null).map(toPoView);
        // Model the SQL join faithfully. A row detached from its PO
        // (`poDetached: true` ⇒ customer_po_id IS NULL) is DROPPED by an
        // innerJoin but survives a leftJoin — which is precisely the
        // regression that hid removed items from the sheet.
        const joinedPoViews = sheetRows
          .filter((r: any) => r.poItemId != null && !r.poDetached)
          .map(toPoView);
        return chainable(allPoViews, {
          innerJoin: vi.fn(() => chainable(joinedPoViews)),
          leftJoin: vi.fn(() => chainable(allPoViews)),
        });
      }
      // Sheet-view supplier cost: select({...}).from(purchaseOrderItems).where()
      if (
        table === (tables as any).purchaseOrderItemsTable &&
        arg &&
        typeof arg === "object" &&
        "finalActualCost" in arg
      ) {
        const costRows = sheetRows
          .filter((r: any) => r.poItemId != null)
          .map((r: any) => ({
            poItemId: r.poItemId,
            finalActualCost: r.poFinalActualCost ?? null,
            referencePrice: r.poReferencePrice ?? null,
          }));
        return chainable(costRows, { where: vi.fn(() => chainable(costRows)) });
      }
      // resolveApprovedCosts: select({...}).from(offerItems).innerJoin(rfqItems).where(...)
      // returns the per-test approvedRows.
      if (table === offerItemsTbl) {
        // The legacy fallback now ALSO innerJoins the supplier rfqs table (for the
        // scoping condition) — chain a second .innerJoin before .where里.

        // Single-join (FK path) and double-join (fallback path) must both
        // resolve — so the first .innerJoin result exposes BOTH .innerJoin
        // AND .where.
        return chainable(approvedRows, {
          innerJoin: vi.fn(() =>
            chainable(approvedRows, {
              innerJoin: vi.fn(() =>
                chainable(approvedRows, {
                  where: vi.fn(() => chainable(approvedRows)),
                }),
              ),
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
      if (table === auditTable) {
        if (Array.isArray(vals)) auditInserts.push(...vals);
        else auditInserts.push(vals);
      }
      // rfq insert: reflect the values the route passed (e.g. numberAutoGenerated)
      // merged over the default row so tests can assert server-computed fields.
      return {
        returning: vi.fn(() => chainable([{ ...insertedRfq, ...vals }])),
      };
    }),
  })),
  update: vi.fn((table: any) => ({
    // Reflect updates onto detailRow so the post-update re-select sees the new
    // values (e.g. status → "sent", numberAutoGenerated → false). Item price
    // writes land on the matching detailItems row (matched by id) so the
    // response carries the new price.
    set: vi.fn((vals: any) => ({
      where: vi.fn((cond: any) => {
        if (vals && typeof vals === "object") {
          if (table === itemsTable) {
            const id = cond?.val;
            // inArray() builds { col, val: [ids] } — a bulk delete of removed items.
            const ids: number[] = Array.isArray(id) ? id : [id];
            updatedItemIds.push(...ids.filter((v: any) => typeof v === "number"));
            detailItems = detailItems.map((it) => (ids.includes(it.id) ? { ...it, ...vals } : it));
          } else if (detailRow) {
            detailRow = { ...detailRow, ...vals };
          }
        }
        return chainable(undefined);
      }),
    })),
  })),
  delete: vi.fn((table: any) => ({
    where: vi.fn((cond: any) => {
      if (table === customerRfqsTbl)
        return { returning: vi.fn(() => chainable(detailRow ? [detailRow] : [])) };
      if (table === itemsTable) {
        const val = cond?.val;
        deletedItemIds.push(
          ...(Array.isArray(val) ? val : [val]).filter((v: any) => typeof v === "number"),
        );
      }
      return chainable(undefined);
    }),
  })),
};

vi.mock("@workspace/db", () => ({
  ...tables,
  db: dbMock,
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: any, val: any) => ({ col, val })),
  ilike: vi.fn((col: any, val: any) => ({ col, val })),
  count: vi.fn(() => "count"),
  inArray: vi.fn((col: any, val: any) => ({ col, val })),
  desc: vi.fn((c: any) => c),
  asc: vi.fn((c: any) => c),
  and: vi.fn((...a: any[]) => a),
  isNull: vi.fn((c: any) => c),
  or: vi.fn((...a: any[]) => a),
  isNotNull: vi.fn((c: any) => c),
  ne: vi.fn((...a: any[]) => a),
  sql: Object.assign(
    vi.fn(() => "sql"),
    { raw: vi.fn() },
  ),
}));

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
  maxNoRow = { maxNo: null };
  existingIdRows = [];
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
  sheetRfqHeaders = null;
  sheetRejectedDeliveries = [];
  employeeRow = { name: "Tester" };
  sessionState.role = "admin";
  insertedItems.length = 0;
  updatedItemIds.length = 0;
  deletedItemIds.length = 0;
  auditInserts.length = 0;
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

  it("keeps an item identified only by its description", async () => {
    // The form has a «توصيف البند» column, so an operator can identify an item
    // by description alone. Requiring a partNo/lineItem silently discarded such
    // rows, making the item disappear from the request on save.
    await request(testApp)
      .post("/api/customer-rfq")
      .send({
        customerName: "Acme",
        customerRfqNo: "RFQ-DESC",
        items: [{ description: "مسمار صلب 8مم", uom: "قطعة", qty: 100 }],
      });
    expect(insertedItems).toHaveLength(1);
    expect(insertedItems[0].description).toBe("مسمار صلب 8مم");
    expect(insertedItems[0].qty).toBe("100");
  });

  it("still drops a row with no identifying text at all", async () => {
    await request(testApp)
      .post("/api/customer-rfq")
      .send({
        customerName: "Acme",
        customerRfqNo: "RFQ-EMPTYROW",
        items: [{ uom: "قطعة", qty: 3 }],
      });
    expect(insertedItems).toHaveLength(0);
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

  it("rejects a customer RFQ number already used by another RFQ (case-insensitive)", async () => {
    existingIdRows = [{ id: 7 }];
    const res = await request(testApp)
      .post("/api/customer-rfq")
      .send({
        customerName: "Acme",
        customerRfqNo: "RFQ-99",
        items: [{ partNo: "P1", qty: 1 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/مستخدم بالفعل/);
    // No row was inserted.
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("generates a MAX-based internal number (survives deletions)", async () => {
    const YEAR = new Date().getFullYear();
    maxNoRow = { maxNo: `CRFQ-${YEAR}-000042` };
    const res = await request(testApp)
      .post("/api/customer-rfq")
      .send({ customerName: "Acme", customerRfqNo: "" });
    expect(res.body.internalNo).toBe(`CRFQ-${YEAR}-000043`);
    expect(res.body.customerRfqNo).toBe(`CRFQ-${YEAR}-000043`);
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

  it("blocks changing the customer RFQ number to one already used elsewhere", async () => {
    detailRow = { ...insertedRfq }; // draft
    existingIdRows = [{ id: 99 }];
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ customerRfqNo: "CUST-001" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/مستخدم بالفعل/);
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

  it("finalizes below the 1.06x floor and audit-logs the deviation (never the cost)", async () => {
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
    // Approved cost = 10 → 1.06 × 10 = 10.6 > 10 → the manager may still finalize.
    approvedRows = [{ customerRfqItemId: 1, price: "10", taxIncluded: false }];
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({
        status: "sent",
        items: [{ partNo: "P1", lineItem: "ABCD", uom: "pc", qty: 3, unitPrice: 10 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    const violation = auditInserts.find((a) => a.action === "customer_rfq.margin_deviation");
    expect(violation).toBeDefined();
    // The approved supplier cost must never be echoed back to the caller.
    expect(JSON.stringify(res.body)).not.toContain("سعر المورد المعتمد");
    expect(violation.description).not.toContain("سعر المورد المعتمد");
  });

  it("finalizes an item that has no approved supplier price (audit-logged)", async () => {
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
    // No approved supplier price at all — still finalizable by the manager.
    approvedRows = [];
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({
        status: "sent",
        items: [{ partNo: "P1", lineItem: "ABCD", uom: "pc", qty: 3, unitPrice: 10 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(auditInserts.some((a) => a.action === "customer_rfq.margin_deviation")).toBe(true);
  });

  it("rejects an unprivileged employee who tries to set a price", async () => {
    sessionState.role = "data_entry";
    detailRow = { ...insertedRfq };
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ items: [{ id: 1, unitPrice: 12 }] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/تسعير/);
  });

  it("rejects an unprivileged employee who tries to finalize", async () => {
    sessionState.role = "purchasing";
    detailRow = { ...insertedRfq };
    const res = await request(testApp).patch("/api/customer-rfq/42").send({ status: "sent" });
    expect(res.status).toBe(403);
  });

  it("lets an unprivileged employee edit data-entry fields on a draft", async () => {
    sessionState.role = "data_entry";
    detailRow = { ...insertedRfq };
    detailItems = [];
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ buyerName: "New Buyer" });
    expect(res.status).toBe(200);
    expect(res.body.buyerName).toBe("New Buyer");
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

  it("blocks editing once the RFQ is sent (no session role)", async () => {
    sessionState.role = undefined;
    detailRow = { ...insertedRfq, status: "sent" };
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ notes: "edited after send" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("بعد إرساله");
  });

  it("allows an admin to fully edit a sent RFQ", async () => {
    sessionState.role = "admin";
    detailRow = { ...insertedRfq, status: "sent" };
    detailItems = [];
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ notes: "edited after send", buyerName: "New Buyer" });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe("edited after send");
    expect(res.body.buyerName).toBe("New Buyer");
  });

  it("allows a manager to fully edit a sent RFQ", async () => {
    sessionState.role = "manager";
    detailRow = { ...insertedRfq, status: "sent" };
    detailItems = [];
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ notes: "manager edit" });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe("manager edit");
  });

  it("blocks a data_entry role from editing a sent RFQ", async () => {
    sessionState.role = "data_entry";
    detailRow = { ...insertedRfq, status: "sent" };
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ notes: "edited after send" });
    expect(res.status).toBe(400);
  });

  it("lets an admin re-price a sent RFQ at any time (prices-only)", async () => {
    detailRow = { ...insertedRfq, status: "sent", expiryDate: "2099-12-31" };
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
    approvedRows = [];
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ items: [{ id: 1, unitPrice: 12 }] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(res.body.items[0].unitPrice).toBe("12");
  });

  it("lets a manager re-price a sent RFQ after its expiry date", async () => {
    sessionState.role = "manager";
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

  it("lets a manager re-price a sent RFQ with no expiry date at all", async () => {
    sessionState.role = "manager";
    detailRow = { ...insertedRfq, status: "sent", expiryDate: null };
    detailItems = [
      {
        id: 1,
        customerRfqId: 42,
        partNo: "P1",
        lineItem: "ABCD",
        description: null,
        uom: "pc",
        qty: "3.0000",
        unitPrice: "15.0000",
        createdAt: new Date("2025-01-03"),
      },
    ];
    approvedRows = [];
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ items: [{ id: 1, unitPrice: 15 }] });
    expect(res.status).toBe(200);
    expect(res.body.items[0].unitPrice).toBe("15");
  });

  it("lets a manager re-price a sent RFQ and edit header fields together", async () => {
    sessionState.role = "manager";
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
      .send({ notes: "x", items: [{ id: 1, unitPrice: 12 }] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(res.body.notes).toBe("x");
  });

  it("keeps a sent RFQ read-only for an unprivileged employee", async () => {
    sessionState.role = "data_entry";
    detailRow = { ...insertedRfq, status: "sent", expiryDate: "2020-01-01" };
    const res = await request(testApp).patch("/api/customer-rfq/42").send({ notes: "x" });
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

  it("merges the manual highlight note into «السبب» and returns the highlight color", async () => {
    sheetRows = [
      {
        rfqItemId: 1,
        lineItem: "H1",
        partNo: "P-H",
        description: "Hilighted",
        uom: null,
        rfqQty: null,
        rfqUnitPrice: null,
        customerRfqId: 1,
        customerRfqNo: "CUST-H",
        customerName: "Acme",
        entryDate: null,
        expiryDate: null,
        buyerName: null,
        poItemId: 44,
        poNo: "PO-H",
        poDate: null,
        poQty: "1",
        poUnitPrice: null,
        highlightColor: "yellow",
        highlightNote: "متابعة خاصة",
      },
    ];
    const res = await request(testApp).get("/api/customer-rfq/sheet-view");
    expect(res.status).toBe(200);
    expect(res.body.rows[0].highlightColor).toBe("yellow");
    expect(res.body.rows[0].flagReason).toBe("متابعة خاصة");
    expect(res.body.rows[0].flagged).toBe(true);
  });

  it("merges highlight note with computed flags (rejection/cost overrun) using —", async () => {
    sheetRows = [
      {
        rfqItemId: 1,
        lineItem: "H2",
        partNo: null,
        description: null,
        uom: null,
        rfqQty: null,
        rfqUnitPrice: null,
        customerRfqId: 1,
        customerRfqNo: "CUST-H",
        customerName: "Acme",
        entryDate: null,
        expiryDate: null,
        buyerName: null,
        poItemId: 45,
        poNo: "PO-H",
        poDate: null,
        poQty: "1",
        poUnitPrice: null,
        highlightColor: "red",
        highlightNote: "ملاحظة إدارية",
        deliveryStatus: "rejected",
      },
    ];
    sheetRejectedDeliveries = [{ customerPoItemId: 45, reason: "تالف", createdAt: new Date() }];
    const res = await request(testApp).get("/api/customer-rfq/sheet-view");
    expect(res.status).toBe(200);
    const row = res.body.rows[0];
    expect(row.flagReason).toBe("رفض التسليم: تالف — ملاحظة إدارية");
    expect(row.highlightColor).toBe("red");
  });

  it("flags a removed-from-PO item as cancelled, keeping the previous rejection reason + highlight note", async () => {
    // PATCH customer-po removed this item: its row survives detached
    // (customerPoId → null) with deliveryStatus="cancelled" and the recorded
    // customer-rejection + admin highlight note intact.
    sheetRows = [
      {
        rfqItemId: 1,
        lineItem: "C1",
        partNo: "P-C",
        description: "Removed item",
        uom: "pc",
        rfqQty: "5",
        rfqUnitPrice: "120",
        customerRfqId: 1,
        customerRfqNo: "CUST-001",
        customerName: "Acme",
        entryDate: "2025-01-10",
        expiryDate: null,
        buyerName: "Sam",
        poItemId: 46,
        poNo: "PO-C", // PO header still joins (customerPoId on the ITEM was nulled; the join is via customerPoItems)
        poDate: "2025-01-15",
        poQty: null, // wiped
        poUnitPrice: null, // wiped
        highlightColor: null,
        highlightNote: "ملاحظة سابقة",
        deliveryStatus: "cancelled",
      },
    ];
    sheetRejectedDeliveries = [{ customerPoItemId: 46, reason: "تالف", createdAt: new Date() }];
    const res = await request(testApp).get("/api/customer-rfq/sheet-view");
    expect(res.status).toBe(200);
    const row = res.body.rows[0];
    expect(row.flagged).toBe(true);
    // «إلغي» headline; the previous rejection reason + note remain recorded
    // (the rejection text is superseded by the cancel but the highlight note
    // still merges into the «السبب» column).
    expect(row.flagReason).toBe("إلغي — ملاحظة سابقة");
  });

  it("keeps a detached (customerPoId NULL) cancelled row visible — left join, not inner", async () => {
    // Removing an item from a PO detaches its row (customer_po_id → NULL) and
    // marks it cancelled. The row must STILL render, with null PO columns and
    // the «إلغي» flag. An INNER join on the PO header dropped it entirely,
    // which is how removed items vanished from the sheet.
    sheetRows = [
      {
        rfqItemId: 7,
        lineItem: "D1",
        partNo: "P-D",
        description: "Detached item",
        uom: "pc",
        rfqQty: "3",
        rfqUnitPrice: "90",
        customerRfqId: 1,
        customerRfqNo: "CUST-001",
        customerName: "Acme",
        entryDate: "2025-02-01",
        expiryDate: null,
        buyerName: "Sam",
        poItemId: 77,
        poDetached: true, // customer_po_id IS NULL
        poNo: null,
        poDate: null,
        poQty: null,
        poUnitPrice: null,
        deliveryStatus: "cancelled",
        highlightColor: null,
        highlightNote: null,
      },
    ];
    const res = await request(testApp).get("/api/customer-rfq/sheet-view");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const row = res.body.rows[0];
    expect(row.poItemId).toBe(77);
    // The endpoint surfaces the raw status only indirectly: a cancelled row is
    // reported through the «السبب» column, which is what the UI renders.
    expect(row.flagged).toBe(true);
    expect(row.flagReason).toBe("إلغي");
  });

  it("shows a request saved with no item rows (item-anchored view must not hide it)", async () => {
    // The entry form only requires a customer name, so a request can be saved
    // with every item row blank. The sheet is anchored on RFQ items, so such a
    // request used to appear NOWHERE. It must render as a header-only row.
    sheetRows = [];
    sheetRfqHeaders = [
      {
        customerRfqId: 99,
        customerRfqNo: "CUST-EMPTY",
        customerName: "Empty Co",
        entryDate: "2025-03-01",
        expiryDate: null,
        buyerName: "Sam",
      },
    ];
    const res = await request(testApp).get("/api/customer-rfq/sheet-view");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const row = res.body.rows[0];
    expect(row.customerRfqId).toBe(99);
    expect(row.customerRfqNo).toBe("CUST-EMPTY");
    expect(row.rfqItemId).toBeNull();
    expect(row.poItemId).toBeNull();
    expect(row.flagged).toBe(false);
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

  it("Include with a value containing a comma (JSON array) matches the full value", async () => {
    // The frontend sends the selected values as a JSON array so a value that
    // itself contains a comma (e.g. "Widget, Blue") is not split into fragments.
    sheetRows = [
      {
        rfqItemId: 1,
        lineItem: "A1",
        partNo: "P-100",
        description: "Widget, Blue",
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
        description: "Widget",
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
    // Include description="Widget, Blue" as a JSON array (one element with a comma).
    const inc = encodeURIComponent(JSON.stringify(["Widget, Blue"]));
    const res = await request(testApp).get(
      `/api/customer-rfq/sheet-view?descriptionInclude=${inc}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].rfqItemId).toBe(1);
    expect(res.body.rows[0].description).toBe("Widget, Blue");
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

// ── PO visibility in the items sheet view ───────────────────────────────────
// Reported bug: a customer PO existed at /customer-po/:id but its lines were
// absent from /items → «سجل البنود والطلبات». The sheet view is anchored on
// customer-RFQ items and joined the PO line only on
// `customer_po_items.customer_rfq_item_id`, so a line whose item FK was severed
// (the old save deleted + re-created the RFQ's items, and that FK is
// ON DELETE SET NULL) — or a PO entered with free/manual lines — produced no
// row at all.
describe("GET /api/customer-rfq/sheet-view — customer PO always visible", () => {
  const baseRfqRow = {
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
    expiryDate: null,
    buyerName: "Sam",
  };

  it("shows a PO line whose RFQ-item link was severed, matched by partNo", async () => {
    // The stored PO line points at RFQ item 10 by partNo, but its
    // customer_rfq_item_id is NULL (nulled by ON DELETE SET NULL).
    sheetRows = [
      {
        ...baseRfqRow,
        rfqItemId: 10,
        poItemId: 90,
        poNo: "877",
        poDate: "2025-01-20",
        poQty: "3",
        poUnitPrice: "130",
        poLinkRfqItemId: null,
      },
    ];
    const res = await request(testApp).get("/api/customer-rfq/sheet-view");
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].poNo).toBe("877");
    expect(res.body.rows[0].rfqItemId).toBe(10);
    expect(res.body.rows[0].poQty).toBe("3");
  });

  it("shows a PO entered with free/manual lines that link to no RFQ at all", async () => {
    // A manual PO line: no RFQ header, no RFQ item — it must still appear.
    sheetRows = [
      {
        rfqItemId: null,
        lineItem: "FREE-1",
        partNo: "P-FREE",
        description: "Manual line",
        uom: "pc",
        rfqQty: null,
        rfqUnitPrice: null,
        customerRfqId: null,
        customerRfqNo: null,
        customerName: null,
        entryDate: null,
        expiryDate: null,
        buyerName: null,
        poItemId: 91,
        poNo: "877",
        poDate: "2025-01-21",
        poQty: "2",
        poUnitPrice: "50",
      },
    ];
    const res = await request(testApp).get("/api/customer-rfq/sheet-view");
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].poNo).toBe("877");
    expect(res.body.rows[0].rfqItemId).toBeNull();
    expect(res.body.rows[0].customerRfqNo).toBeNull();
  });

  it("still lists an RFQ item with no PO yet as a row with null PO columns", async () => {
    sheetRows = [{ ...baseRfqRow, rfqItemId: 11, poItemId: null }];
    const res = await request(testApp).get("/api/customer-rfq/sheet-view");
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].rfqItemId).toBe(11);
    expect(res.body.rows[0].poNo).toBeNull();
    expect(res.body.rows[0].poItemId).toBeNull();
  });

  it("finds a severed-link PO line when searching by its PO number", async () => {
    sheetRows = [
      {
        ...baseRfqRow,
        rfqItemId: 10,
        poItemId: 90,
        poNo: "877",
        poDate: "2025-01-20",
        poQty: "3",
        poUnitPrice: "130",
        poLinkRfqItemId: null,
      },
    ];
    const res = await request(testApp).get("/api/customer-rfq/sheet-view?search=877");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].poNo).toBe("877");
  });
});

describe("PATCH /api/customer-rfq/:id — saving preserves item ids", () => {
  // The save must UPDATE existing rows in place (never delete + re-insert), or
  // every customer-PO / supplier-offer link pointing at those ids is severed.
  const storedItem = {
    id: 1,
    customerRfqId: 42,
    partNo: "P1",
    lineItem: "ABCD",
    description: null,
    uom: "pc",
    qty: "3.0000",
    unitPrice: "10.0000",
    createdAt: new Date("2025-01-03"),
  };

  it("updates an edited item in place instead of recreating it", async () => {
    sessionState.role = "admin";
    detailRow = { ...insertedRfq };
    detailItems = [storedItem];
    approvedRows = [];
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({
        items: [{ partNo: "P1", lineItem: "ABCD", uom: "pc", qty: 4, unitPrice: 12 }],
      });
    expect(res.status).toBe(200);
    // Row 1 updated in place; nothing deleted, nothing re-inserted.
    expect(updatedItemIds).toContain(1);
    expect(deletedItemIds).toHaveLength(0);
    expect(insertedItems).toHaveLength(0);
  });

  it("deletes only the items the operator removed", async () => {
    sessionState.role = "admin";
    detailRow = { ...insertedRfq };
    detailItems = [storedItem, { ...storedItem, id: 2, partNo: "P2", lineItem: "EFGH" }];
    approvedRows = [];
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({ items: [{ partNo: "P1", lineItem: "ABCD", uom: "pc", qty: 4, unitPrice: 12 }] });
    expect(res.status).toBe(200);
    expect(updatedItemIds).toContain(1);
    expect(deletedItemIds).toEqual([2]);
    expect(insertedItems).toHaveLength(0);
  });

  it("inserts a genuinely new item without touching the existing one", async () => {
    sessionState.role = "admin";
    detailRow = { ...insertedRfq };
    detailItems = [storedItem];
    approvedRows = [];
    const res = await request(testApp)
      .patch("/api/customer-rfq/42")
      .send({
        items: [
          { partNo: "P1", lineItem: "ABCD", uom: "pc", qty: 4, unitPrice: 12 },
          { partNo: "P9", lineItem: "ZZZZ", uom: "pc", qty: 1, unitPrice: 99 },
        ],
      });
    expect(res.status).toBe(200);
    expect(updatedItemIds).toContain(1);
    expect(deletedItemIds).toHaveLength(0);
    expect(insertedItems).toHaveLength(1);
    expect(insertedItems[0].partNo).toBe("P9");
  });
});

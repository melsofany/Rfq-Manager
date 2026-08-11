import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth ───────────────────────────────────────────────────────────────
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
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
const poItemsTable = { _: "customerPoItems", customerPoId: "customerPoId" };
const rfqsTable = { _: "customerRfqs", customerName: "customerName", createdAt: "createdAt" };
const employeesTbl = { _: "employees", id: "id", name: "name" };
const auditTable = { _: "audit" };
const tables = {
  customerPosTable: poTable,
  customerPoItemsTable: poItemsTable,
  customerRfqsTable: rfqsTable,
  employeesTable: employeesTbl,
  auditLogTable: auditTable,
};

// Per-test state.
let listRows: any[]; // GET /customer-po list rows: { po: {...} }
let countRows: any[]; // item-count aggregate: { customerPoId, cnt }
let countRow: { maxNo: string | null }; // generateInternalPoNo: { maxNo }
let insertedPo: any; // base row returned by insert().returning()
let detailRow: any | null; // the customer PO itself (bare select)
let detailItems: any[]; // customer_po_items for a PO
let customerNameRow: { name: string } | null; // resolveCustomerName first-row
let employeeRow: { name: string } | null; // POST employee name lookup
// Tracks exact values written to customer_po_items so tests can assert links.
const insertedItems: any[] = [];

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
      // customer_po_items (bare select) — two callers:
      //   - detail items: select().from(poItems).where()  → detailItems
      //   - resolveCustomerName: select({name}).from(poItems).innerJoin(rfqs).where().limit()
      if (table === poItemsTable) {
        // resolveCustomerName passes arg with "name"; detail items pass no arg.
        const isCustomerNameResolve = arg && typeof arg === "object" && "name" in arg;
        const rows = isCustomerNameResolve ? (customerNameRow ? [customerNameRow] : []) : detailItems;
        return chainable(rows, {
          where: vi.fn(() => chainable(rows, { limit: vi.fn(() => chainable(rows)) })),
          limit: vi.fn(() => chainable(rows)),
          innerJoin: vi.fn(() =>
            chainable(rows, {
              where: vi.fn(() => chainable(rows, { limit: vi.fn(() => chainable(rows)) })),
              limit: vi.fn(() => chainable(rows)),
            }),
          ),
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
      if (table === rfqsTable) {
        return chainable([], { orderBy: vi.fn(() => chainable([])) });
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
  update: vi.fn(() => ({
    // Reflect updates onto detailRow so the post-update re-select sees new values.
    set: vi.fn((vals: any) => {
      if (vals && typeof vals === "object" && detailRow) detailRow = { ...detailRow, ...vals };
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
  customerNameRow = null;
  employeeRow = { name: "Tester" };
  sessionState.role = undefined;
  insertedItems.length = 0;
});

describe("POST /api/customer-po (create)", () => {
  it("creates a PO, auto-generates the internal number, and links items to RFQ items", async () => {
    customerNameRow = { name: "Acme" };
    const res = await request(testApp).post("/api/customer-po").send({
      customerPoNo: "PO-100",
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
    expect(res.body.customerName).toBe("Acme");
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
      items: [{ partNo: "P1", qty: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when no valid items are provided", async () => {
    const res = await request(testApp).post("/api/customer-po").send({
      customerPoNo: "PO-X",
      items: [{ partNo: "P1" }], // no qty → filtered out
    });
    expect(res.status).toBe(400);
  });

  it("accepts manual items with no customer RFQ link (customerName stays null)", async () => {
    customerNameRow = null; // resolveCustomerName returns nothing
    const res = await request(testApp).post("/api/customer-po").send({
      customerPoNo: "PO-101",
      items: [{ description: "Manual item", uom: "pc", qty: 2, unitPrice: 5 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.customerName).toBeNull();
    expect(insertedItems[0].customerRfqId).toBeNull();
    expect(insertedItems[0].customerRfqItemId).toBeNull();
    expect(insertedItems[0].description).toBe("Manual item");
  });

  it("allows the same customer RFQ item on a second PO (partial shipment — no uniqueness error)", async () => {
    customerNameRow = { name: "Acme" };
    const res = await request(testApp).post("/api/customer-po").send({
      customerPoNo: "PO-102",
      items: [{ customerRfqId: 3, customerRfqItemId: 11, partNo: "P1", qty: 2, unitPrice: 10 }],
    });
    expect(res.status).toBe(201);
    // The same item id (11) was persisted — the schema does not enforce uniqueness.
    expect(insertedItems[0].customerRfqItemId).toBe(11);
  });
});

describe("GET /api/customer-po (list)", () => {
  it("returns the list with item counts and resolved customer names", async () => {
    listRows = [{ po: { ...insertedPo, id: 7, customerPoNo: "PO-100", buyerName: "B" } }];
    countRows = [{ customerPoId: 7, cnt: 4 }];
    customerNameRow = { name: "Acme" };
    const res = await request(testApp).get("/api/customer-po");
    expect(res.status).toBe(200);
    expect(res.body[0].internalPoNo).toBe("CPO-2025-000001");
    expect(res.body[0].itemCount).toBe(4);
    expect(res.body[0].customerName).toBe("Acme");
  });

  it("filters by search term (client-side) without erroring", async () => {
    listRows = [{ po: { ...insertedPo, customerPoNo: "PO-100", buyerName: "B" } }];
    countRows = [];
    const res = await request(testApp).get("/api/customer-po?search=PO-100");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe("GET /api/customer-po/:id", () => {
  it("returns 404 when not found", async () => {
    detailRow = null;
    const res = await request(testApp).get("/api/customer-po/999");
    expect(res.status).toBe(404);
  });

  it("returns the PO with formatted items when found", async () => {
    detailRow = insertedPo;
    customerNameRow = { name: "Acme" };
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
    const res = await request(testApp).get("/api/customer-po/7");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    expect(res.body.customerName).toBe("Acme");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].qty).toBe("3");
    expect(res.body.items[0].unitPrice).toBe("10");
    expect(res.body.items[0].total).toBe("30");
    expect(res.body.items[0].deliveryDate).toBe("2025-03-01");
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
        buyerName: "New Buyer",
        items: [{ customerRfqId: 3, customerRfqItemId: 11, partNo: "P1", qty: 1, unitPrice: 9 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.customerPoNo).toBe("PO-200");
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

  it("rejects editing a PO that is already sent", async () => {
    detailRow = { ...insertedPo, status: "sent" };
    const res = await request(testApp).patch("/api/customer-po/7").send({ buyerName: "X" });
    expect(res.status).toBe(400);
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

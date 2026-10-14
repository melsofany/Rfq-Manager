import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth ───────────────────────────────────────────────────────────────
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  and: (...args: any[]) => ({ __op: "and", args }),
  or: (...args: any[]) => ({ __op: "or", args }),
  inArray: (left: any, right: any) => ({ __op: "inArray", left, right }),
  isNull: (col: any) => ({ __op: "isNull", col }),
  isNotNull: (col: any) => ({ __op: "isNotNull", col }),
  desc: (col: any) => ({ __op: "desc", col }),
  sql: Object.assign((strings: any, ...values: any[]) => ({ __op: "sql", strings, values }), {
    raw: (s: string) => ({ __op: "sql.raw", s }),
  }),
}));

const customerItemsTable = {
  _: "customerRfqItems",
  id: "id",
  categoryId: "categoryId",
  attributionEmployeeId: "attributionEmployeeId",
  attributionEmployeeName: "attributionEmployeeName",
  attributionEvent: "attributionEvent",
  attributionFirstPoAt: "attributionFirstPoAt",
};
const itemCategoriesTable = { _: "itemCategories", id: "id", name: "name" };
const employeesTable = { _: "employees", id: "id", name: "name", role: "role" };
// The route reads the live customer-PO lines to compute the achievement ratio.
const customerPoItemsTable = { _: "customerPoItems", customerRfqItemId: "customerRfqItemId" };

// Frozen-item rows served for the attribution select.
let frozenRows: any[];

const dbMock: any = {
  select: vi.fn(() => ({
    from: vi.fn((table: any) => {
      if (table === customerItemsTable) {
        return chainable(frozenRows, { where: vi.fn(() => chainable(frozenRows)) });
      }
      if (table === itemCategoriesTable) {
        return chainable(
          [
            { id: 1, name: "أجهزة" },
            { id: 2, name: "قواطع" },
          ],
          {
            where: vi.fn(() =>
              chainable([
                { id: 1, name: "أجهزة" },
                { id: 2, name: "قواطع" },
              ]),
            ),
          },
        );
      }
      if (table === employeesTable) {
        return chainable(
          [
            { id: 42, name: "Ahmed", role: "purchasing" },
            { id: 7, name: "Sara", role: "purchasing" },
          ],
          {
            where: vi.fn(() =>
              chainable([
                { id: 42, name: "Ahmed", role: "purchasing" },
                { id: 7, name: "Sara", role: "purchasing" },
              ]),
            ),
          },
        );
      }
      if (table === customerPoItemsTable) {
        // Every frozen item counts as converted by default; tests can override.
        const converted = frozenRows
          .filter((r) => r.employeeId != null)
          .map((r) => ({ customerRfqItemId: r.customerRfqItemId }));
        return chainable(converted, { where: vi.fn(() => chainable(converted)) });
      }
      return chainable([], { where: vi.fn(() => chainable([])) });
    }),
  })),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  customerRfqItemsTable: customerItemsTable,
  itemCategoriesTable,
  employeesTable,
  customerPoItemsTable,
  // Other tables imported by the module are unused by this route.
  customerRfqItemAssignmentsTable: { _: "customerAssignments" },
  customerRfqsTable: { _: "customerRfqs" },
  rfqItemAssignmentsTable: { _: "rfqAssignments" },
  rfqItemsTable: { _: "rfqItems" },
  rfqTable: { _: "rfq" },
  offersTable: { _: "offers" },
  offerItemsTable: { _: "offerItems" },
  purchaseOrdersTable: { _: "purchaseOrders" },
  purchaseOrderItemsTable: { _: "purchaseOrderItems" },
  employeeCategoriesTable: { _: "employeeCategories" },
}));

let testApp: express.Express;

beforeAll(async () => {
  const { default: router } = await import("../../modules/reports/item-kpis");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { employeeId: 1, role: "admin" };
    next();
  });
  testApp.use("/api", router);
});

beforeEach(() => {
  vi.clearAllMocks();
  frozenRows = [];
});

describe("GET /api/analytics/procurement/attributed — KPI «من أحضر السعر»", () => {
  it("credits each item to ONE employee (the frozen winner), not the category owner", async () => {
    frozenRows = [
      {
        customerRfqItemId: 1,
        employeeId: 42,
        employeeName: "Ahmed",
        event: "first_customer_po",
        frozenAt: "2026-02-01T00:00:00.000Z",
        categoryId: 1,
      },
      {
        customerRfqItemId: 2,
        employeeId: 42,
        employeeName: "Ahmed",
        event: "first_customer_po",
        frozenAt: "2026-02-02T00:00:00.000Z",
        categoryId: 2,
      },
      {
        customerRfqItemId: 3,
        employeeId: 7,
        employeeName: "Sara",
        event: "first_customer_po",
        frozenAt: "2026-02-03T00:00:00.000Z",
        categoryId: 2,
      },
    ];
    const res = await request(testApp).get("/api/analytics/procurement/attributed");
    expect(res.status).toBe(200);
    const ahmed = res.body.employees.find((e: any) => e.employeeId === 42);
    const sara = res.body.employees.find((e: any) => e.employeeId === 7);
    expect(ahmed.attributedItems).toBe(2);
    expect(sara.attributedItems).toBe(1);
    expect(res.body.totals.attributedItems).toBe(3);
    expect(res.body.totals.unattributedItems).toBe(0);
  });

  it("reports frozen-but-unattributed items separately (no winner to credit)", async () => {
    frozenRows = [
      {
        customerRfqItemId: 1,
        employeeId: 42,
        employeeName: "Ahmed",
        event: "first_customer_po",
        frozenAt: "2026-02-01T00:00:00.000Z",
        categoryId: 1,
      },
      {
        customerRfqItemId: 2,
        employeeId: null,
        employeeName: null,
        event: "first_customer_po_no_approved_price",
        frozenAt: "2026-02-02T00:00:00.000Z",
        categoryId: null,
      },
    ];
    const res = await request(testApp).get("/api/analytics/procurement/attributed");
    expect(res.status).toBe(200);
    expect(res.body.totals.frozenItems).toBe(2);
    expect(res.body.totals.attributedItems).toBe(1);
    expect(res.body.totals.unattributedItems).toBe(1);
    expect(res.body.employees.length).toBe(1);
  });

  it("applies the date window on the FREEZE timestamp", async () => {
    frozenRows = [
      {
        customerRfqItemId: 1,
        employeeId: 42,
        employeeName: "Ahmed",
        event: "first_customer_po",
        frozenAt: "2026-01-15T00:00:00.000Z",
        categoryId: 1,
      },
      {
        customerRfqItemId: 2,
        employeeId: 42,
        employeeName: "Ahmed",
        event: "first_customer_po",
        frozenAt: "2026-03-15T00:00:00.000Z",
        categoryId: 1,
      },
    ];
    const res = await request(testApp).get(
      "/api/analytics/procurement/attributed?from=2026-03-01&to=2026-03-31",
    );
    expect(res.status).toBe(200);
    expect(res.body.totals.frozenItems).toBe(1);
    expect(res.body.employees[0].attributedItems).toBe(1);
  });

  it("breaks the count down by category", async () => {
    frozenRows = [
      {
        customerRfqItemId: 1,
        employeeId: 42,
        employeeName: "Ahmed",
        event: "first_customer_po",
        frozenAt: "2026-02-01T00:00:00.000Z",
        categoryId: 1,
      },
      {
        customerRfqItemId: 2,
        employeeId: 42,
        employeeName: "Ahmed",
        event: "first_customer_po",
        frozenAt: "2026-02-02T00:00:00.000Z",
        categoryId: 1,
      },
      {
        customerRfqItemId: 3,
        employeeId: 42,
        employeeName: "Ahmed",
        event: "first_customer_po",
        frozenAt: "2026-02-03T00:00:00.000Z",
        categoryId: 2,
      },
    ];
    const res = await request(testApp).get("/api/analytics/procurement/attributed");
    const ahmed = res.body.employees[0];
    expect(ahmed.categories.find((c: any) => c.categoryId === 1).items).toBe(2);
    expect(ahmed.categories.find((c: any) => c.categoryId === 2).items).toBe(1);
  });
});

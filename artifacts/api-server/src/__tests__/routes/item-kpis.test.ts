import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth ───────────────────────────────────────────────────────────────
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  and: (...args: any[]) => ({ __op: "and", args }),
  inArray: (left: any, right: any) => ({ __op: "inArray", left, right }),
  isNull: (col: any) => ({ __op: "isNull", col }),
  sql: Object.assign((strings: any, ...values: any[]) => ({ __op: "sql", strings, values }), {
    raw: (s: string) => ({ __op: "sql.raw", s }),
  }),
}));

// Customer-item tables (the new source of truth).
const customerAssignmentsTable = {
  _: "customerAssignments",
  customerRfqItemId: "customerRfqItemId",
  categoryId: "categoryId",
  employeeId: "employeeId",
  source: "source",
  confidence: "confidence",
  validFrom: "validFrom",
  validTo: "validTo",
};
const customerItemsTable = {
  _: "customerItems",
  id: "id",
  customerRfqId: "customerRfqId",
  categoryId: "categoryId",
};
const customerRfqsTable = { _: "customerRfqs", id: "id", status: "status", createdAt: "createdAt" };
// Legacy supplier-RFQ tables.
const supplierAssignmentsTable = {
  _: "supplierAssignments",
  rfqItemId: "rfqItemId",
  employeeId: "employeeId",
};
const supplierItemsTable = {
  _: "supplierItems",
  id: "id",
  rfqId: "rfqId",
  customerRfqItemId: "customerRfqItemId",
  lineItem: "lineItem",
  partNo: "partNo",
  description: "description",
  categoryId: "categoryId",
};
const supplierRfqTable = { _: "supplierRfq", id: "id", status: "status", createdAt: "createdAt" };
const offersTable = { _: "offers", id: "id", rfqId: "rfqId" };
const offerItemsTable = { _: "offerItems", rfqItemId: "rfqItemId" };
const purchaseOrdersTable = { _: "purchaseOrders", id: "id", rfqId: "rfqId" };
const purchaseOrderItemsTable = {
  _: "poItems",
  poId: "poId",
  lineItem: "lineItem",
  partNo: "partNo",
  description: "description",
};
const employeesTable = {
  _: "employees",
  id: "id",
  name: "name",
  role: "role",
  isActive: "isActive",
};
const itemCategoriesTable = { _: "itemCategories", id: "id", name: "name", isActive: "isActive" };
const employeeCategoriesTable = { _: "employeeCategories", categoryId: "categoryId" };

function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

let customerAssignmentRows: any[];
let customerItemRows: any[];
let customerRfqRows: any[];
let supplierItemRows: any[];
let supplierRfqRows: any[];
let offerRows: any[];
let offerItemRows: any[];
let poRows: any[];
let poItemRows: any[];
let catRows: any[];
let empRows: any[];
let ownerRows: any[];
let unclassifiedRows: any[];
let independentRows: any[];
let migrationRows: any;

const dbMock: any = {
  select: vi.fn((arg?: any) => ({
    from: vi.fn((table: any) => {
      let rows: any[] = [];
      let grouped = false;
      let having = false;
      if (table === customerAssignmentsTable) rows = customerAssignmentRows;
      else if (table === customerItemsTable)
        rows = arg && typeof arg === "object" && "n" in arg ? unclassifiedRows : customerItemRows;
      else if (table === customerRfqsTable) rows = customerRfqRows;
      else if (table === supplierItemsTable) rows = supplierItemRows;
      else if (table === supplierRfqTable) rows = supplierRfqRows;
      else if (table === supplierAssignmentsTable) rows = independentRows;
      else if (table === offersTable) rows = offerRows;
      else if (table === offerItemsTable) rows = offerItemRows;
      else if (table === purchaseOrdersTable) rows = poRows;
      else if (table === purchaseOrderItemsTable) rows = poItemRows;
      else if (table === itemCategoriesTable) rows = catRows;
      else if (table === employeesTable) rows = empRows;
      else if (table === employeeCategoriesTable) rows = ownerRows;
      const self = () =>
        chainable(rows, {
          where: vi.fn(self),
          innerJoin: vi.fn(self),
          leftJoin: vi.fn(self),
          orderBy: vi.fn(self),
          groupBy: vi.fn(() => {
            grouped = true;
            return chainable(rows, {
              having: vi.fn(() => {
                having = true;
                return chainable(migrationRows?.conflicts ?? []);
              }),
            });
          }),
        });
      void grouped;
      void having;
      return self();
    }),
  })),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  customerRfqItemAssignmentsTable: customerAssignmentsTable,
  customerRfqItemsTable: customerItemsTable,
  customerRfqsTable,
  rfqItemAssignmentsTable: supplierAssignmentsTable,
  rfqItemsTable: supplierItemsTable,
  rfqTable: supplierRfqTable,
  offersTable,
  offerItemsTable,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  employeesTable,
  itemCategoriesTable,
  employeeCategoriesTable,
}));

let testApp: express.Express;
let matchPoLineForRfqItem: typeof import("../../modules/reports/item-kpis").matchPoLineForRfqItem;

beforeAll(async () => {
  const mod = await import("../../modules/reports/item-kpis");
  matchPoLineForRfqItem = mod.matchPoLineForRfqItem;
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { employeeId: 1, role: "admin" };
    next();
  });
  testApp.use("/api", mod.default);
});

beforeEach(() => {
  vi.clearAllMocks();
  customerAssignmentRows = [];
  customerItemRows = [];
  customerRfqRows = [];
  supplierItemRows = [];
  supplierRfqRows = [];
  offerRows = [];
  offerItemRows = [];
  poRows = [];
  poItemRows = [];
  catRows = [];
  empRows = [];
  ownerRows = [];
  unclassifiedRows = [{ n: 0 }];
  independentRows = [];
  migrationRows = { conflicts: [] };
});

async function fetchKpi() {
  const res = await request(testApp).get("/api/analytics/procurement/by-item");
  expect(res.status).toBe(200);
  return res.body;
}

describe("matchPoLineForRfqItem (pure)", () => {
  const item = { lineItem: "10", partNo: "PN-1", description: "Cable 3x2.5" };

  it("matches by lineItem", () => {
    expect(matchPoLineForRfqItem(item, [{ lineItem: "10", partNo: null, description: null }])).toBe(
      true,
    );
  });
  it("matches by partNo when lineItem is absent", () => {
    expect(
      matchPoLineForRfqItem(item, [{ lineItem: null, partNo: "pn-1", description: null }]),
    ).toBe(true);
  });
  it("matches by description as the last rung", () => {
    expect(
      matchPoLineForRfqItem(item, [{ lineItem: null, partNo: null, description: "CABLE 3X2.5" }]),
    ).toBe(true);
  });
  it("does not match an unrelated line", () => {
    expect(
      matchPoLineForRfqItem(item, [{ lineItem: "20", partNo: "PN-9", description: "Fan" }]),
    ).toBe(false);
  });
  it("does not match an empty identity against an empty line", () => {
    expect(
      matchPoLineForRfqItem({ lineItem: null, partNo: null, description: null }, [
        { lineItem: null, partNo: null, description: null },
      ]),
    ).toBe(false);
  });
});

describe("customer-item responsibility (design decision 1)", () => {
  it("one customer item sent to 3 suppliers has ONE owner and counts as ONE item", async () => {
    // THE acceptance test: customer item 500 → 3 supplier lines (RFQ 1,2,3),
    // all linked to the same customer item. KPI must count ONE item, ONE owner.
    customerAssignmentRows = [
      { customerRfqItemId: 500, categoryId: 1, employeeId: 5, source: "auto", confidence: "80" },
    ];
    customerItemRows = [{ id: 500, customerRfqId: 10 }];
    customerRfqRows = [{ id: 10, status: "draft", createdAt: new Date("2026-01-01") }];
    supplierItemRows = [
      {
        id: 900,
        rfqId: 1,
        customerRfqItemId: 500,
        lineItem: "1",
        partNo: "A",
        description: "Breaker",
      },
      {
        id: 901,
        rfqId: 2,
        customerRfqItemId: 500,
        lineItem: "1",
        partNo: "A",
        description: "Breaker",
      },
      {
        id: 902,
        rfqId: 3,
        customerRfqItemId: 500,
        lineItem: "1",
        partNo: "A",
        description: "Breaker",
      },
    ];
    supplierRfqRows = [
      { id: 1, status: "QUOTED" },
      { id: 2, status: "QUOTED" },
      { id: 3, status: "QUOTED" },
    ];
    offerRows = [
      { id: 1, rfqId: 1 },
      { id: 2, rfqId: 2 },
    ];
    offerItemRows = [{ rfqItemId: 900 }, { rfqItemId: 901 }];
    empRows = [{ id: 5, name: "أحمد", role: "purchasing", isActive: true }];
    catRows = [{ id: 1, name: "قواطع" }];

    const body = await fetchKpi();
    expect(body.employees).toHaveLength(1);
    expect(body.employees[0].employeeId).toBe(5);
    expect(body.employees[0].items).toBe(1); // ONE customer item, not 3 supplier lines
    expect(body.totals.items).toBe(1);
  });

  it("five customer items across 3 suppliers count as FIVE items", async () => {
    customerAssignmentRows = [1, 2, 3, 4, 5].map((id) => ({
      customerRfqItemId: id,
      categoryId: 1,
      employeeId: 5,
      source: "auto",
      confidence: "80",
    }));
    customerItemRows = [1, 2, 3, 4, 5].map((id) => ({ id, customerRfqId: 10 }));
    customerRfqRows = [{ id: 10, status: "draft", createdAt: new Date("2026-01-01") }];
    // 5 items spread over 3 supplier RFQs.
    supplierItemRows = [
      { id: 900, rfqId: 1, customerRfqItemId: 1, lineItem: "1", partNo: "A", description: "A" },
      { id: 901, rfqId: 1, customerRfqItemId: 2, lineItem: "2", partNo: "B", description: "B" },
      { id: 902, rfqId: 2, customerRfqItemId: 3, lineItem: "3", partNo: "C", description: "C" },
      { id: 903, rfqId: 2, customerRfqItemId: 4, lineItem: "4", partNo: "D", description: "D" },
      { id: 904, rfqId: 3, customerRfqItemId: 5, lineItem: "5", partNo: "E", description: "E" },
    ];
    supplierRfqRows = [
      { id: 1, status: "QUOTED" },
      { id: 2, status: "QUOTED" },
      { id: 3, status: "QUOTED" },
    ];
    empRows = [{ id: 5, name: "أحمد", role: "purchasing", isActive: true }];
    catRows = [{ id: 1, name: "قواطع" }];

    const body = await fetchKpi();
    expect(body.totals.items).toBe(5);
    expect(body.totals.totalItems).toBe(5);
  });

  it("excludes independent (no customer origin) supplier responsibility from the customer KPI", async () => {
    // No customer assignments at all → employee rows empty, but the independent
    // supplier responsibility is reported as an informational total.
    customerAssignmentRows = [];
    independentRows = [{ rfqItemId: 1 }, { rfqItemId: 2 }];
    unclassifiedRows = [{ n: 0 }];

    const body = await fetchKpi();
    expect(body.employees).toHaveLength(0);
    expect(body.totals.independentSupplierItems).toBe(2);
    expect(body.totals.totalItems).toBe(0);
  });
});

describe("per-item conversion on the customer item", () => {
  it("converts the customer item when any linked supplier line has a matching PO line", async () => {
    customerAssignmentRows = [
      { customerRfqItemId: 500, categoryId: 1, employeeId: 5, source: "auto", confidence: "80" },
    ];
    customerItemRows = [{ id: 500, customerRfqId: 10 }];
    customerRfqRows = [{ id: 10, status: "draft", createdAt: new Date("2026-01-01") }];
    supplierItemRows = [
      {
        id: 900,
        rfqId: 1,
        customerRfqItemId: 500,
        lineItem: "1",
        partNo: "A",
        description: "Breaker",
      },
    ];
    supplierRfqRows = [{ id: 1, status: "QUOTED" }];
    poRows = [{ id: 50, rfqId: 1 }];
    poItemRows = [{ poId: 50, lineItem: "1", partNo: "A", description: "Breaker" }];
    empRows = [{ id: 5, name: "أحمد", role: "purchasing", isActive: true }];
    catRows = [{ id: 1, name: "قواطع" }];

    const body = await fetchKpi();
    expect(body.employees[0].convertedItems).toBe(1);
  });

  it("does not convert when no linked PO line matches and the RFQ is not SUCCESS", async () => {
    customerAssignmentRows = [
      { customerRfqItemId: 500, categoryId: 1, employeeId: 5, source: "auto", confidence: "80" },
    ];
    customerItemRows = [{ id: 500, customerRfqId: 10 }];
    customerRfqRows = [{ id: 10, status: "draft", createdAt: new Date("2026-01-01") }];
    supplierItemRows = [
      {
        id: 900,
        rfqId: 1,
        customerRfqItemId: 500,
        lineItem: "1",
        partNo: "A",
        description: "Breaker",
      },
    ];
    supplierRfqRows = [{ id: 1, status: "QUOTED" }];
    poRows = [{ id: 50, rfqId: 1 }];
    poItemRows = [{ poId: 50, lineItem: "zzz", partNo: "other", description: "unrelated" }];
    empRows = [{ id: 5, name: "أحمد", role: "purchasing", isActive: true }];
    catRows = [{ id: 1, name: "قواطع" }];

    const body = await fetchKpi();
    expect(body.employees[0].convertedItems).toBe(0);
  });

  it("keeps the SUCCESS fallback so legacy header-only conversions still count", async () => {
    customerAssignmentRows = [
      { customerRfqItemId: 500, categoryId: 1, employeeId: 5, source: "auto", confidence: "80" },
    ];
    customerItemRows = [{ id: 500, customerRfqId: 10 }];
    customerRfqRows = [{ id: 10, status: "draft", createdAt: new Date("2026-01-01") }];
    supplierItemRows = [
      {
        id: 900,
        rfqId: 1,
        customerRfqItemId: 500,
        lineItem: "1",
        partNo: "A",
        description: "Breaker",
      },
    ];
    supplierRfqRows = [{ id: 1, status: "SUCCESS" }];
    poRows = [{ id: 50, rfqId: 1 }];
    poItemRows = [{ poId: 50, lineItem: "zzz", partNo: "other", description: "unrelated" }];
    empRows = [{ id: 5, name: "أحمد", role: "purchasing", isActive: true }];
    catRows = [{ id: 1, name: "قواطع" }];

    const body = await fetchKpi();
    expect(body.employees[0].convertedItems).toBe(1);
  });
});

describe("KPI clarity — unassigned / unclassified buckets", () => {
  it("reports unassigned (classified, no owner) separately and reconciles totals", async () => {
    customerAssignmentRows = [
      { customerRfqItemId: 500, categoryId: 1, employeeId: 5, source: "auto", confidence: "80" },
      { customerRfqItemId: 501, categoryId: 2, employeeId: null, source: "auto", confidence: "80" },
    ];
    customerItemRows = [
      { id: 500, customerRfqId: 10 },
      { id: 501, customerRfqId: 10 },
    ];
    customerRfqRows = [{ id: 10, status: "draft", createdAt: new Date("2026-01-01") }];
    empRows = [{ id: 5, name: "أحمد", role: "purchasing", isActive: true }];
    catRows = [
      { id: 1, name: "قواطع" },
      { id: 2, name: "أجهزة" },
    ];
    unclassifiedRows = [{ n: 3 }];

    const body = await fetchKpi();
    expect(body.employees).toHaveLength(1);
    expect(body.employees[0].items).toBe(1);
    expect(body.unassigned).toHaveLength(1);
    expect(body.unassigned[0].categoryName).toBe("أجهزة");
    expect(body.totals.assignedItems).toBe(1);
    expect(body.totals.unassignedItems).toBe(1);
    expect(body.totals.unclassifiedItems).toBe(3);
    expect(body.totals.totalItems).toBe(5);
  });

  it("counts unclassified items (no assignment row) from the customer source table", async () => {
    customerAssignmentRows = [];
    customerItemRows = [];
    unclassifiedRows = [{ n: 4 }];

    const body = await fetchKpi();
    expect(body.totals.unclassifiedItems).toBe(4);
    expect(body.totals.totalItems).toBe(4);
    expect(body.employees).toHaveLength(0);
  });
});

describe("assignment migration report", () => {
  it("reports migrated / conflicts / orphans / needsReview", async () => {
    migrationRows = { conflicts: [{ customerRfqItemId: 1 }, { customerRfqItemId: 2 }] };
    independentRows = [{ rfqItemId: 1 }];
    customerAssignmentRows = [{ customerRfqItemId: 500 }];
    const res = await request(testApp).get("/api/analytics/assignment-migration");
    expect(res.status).toBe(200);
    expect(res.body.conflicts).toBe(2);
    expect(res.body.orphans).toBe(1);
  });
});

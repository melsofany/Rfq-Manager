import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// ── drizzle-orm sentinels ───────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  ne: (left: any, right: any) => ({ __op: "ne", left, right }),
  and: (...args: any[]) => ({ __op: "and", args }),
  inArray: (left: any, right: any) => ({ __op: "inArray", left, right }),
  sql: Object.assign((strings: any, ...values: any[]) => ({ __op: "sql", strings, values }), {
    raw: (s: string) => ({ __op: "sql.raw", s }),
  }),
}));

function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

// ── Table sentinels ─────────────────────────────────────────────────────────
const itemCategoriesTable = { _: "itemCategories", isActive: "isActive" };
const employeeCategoriesTable = {
  _: "employeeCategories",
  categoryId: "categoryId",
  employeeId: "employeeId",
};
const employeesTable = { _: "employees", id: "id", isActive: "isActive" };
const rfqItemsTable = {
  _: "rfqItems",
  id: "id",
  rfqId: "rfqId",
  categoryId: "categoryId",
  createdAt: "createdAt",
};
const rfqItemAssignmentsTable = {
  _: "assignments",
  rfqItemId: "rfqItemId",
  employeeId: "employeeId",
};
const rfqTable = { _: "rfq", id: "id", status: "status", createdAt: "createdAt" };
const itemCategoryKeywordsTable = {
  _: "itemCategoryKeywords",
  categoryId: "categoryId",
  keyword: "keyword",
  weight: "weight",
  enabled: "enabled",
};

// ── Per-test state ──────────────────────────────────────────────────────────
let categoryRows: any[];
let ownerRows: any[];
let workloadRows: any[];
let itemRows: any[];
let existingAssignmentRows: any[];

const insertedAssignments: any[] = [];
const updatedItemCalls: Array<{ id: number; vals: any }> = [];

const dbMock: any = {
  select: vi.fn((_arg?: any) => ({
    from: vi.fn((table: any) => {
      if (table === itemCategoriesTable) {
        return chainable(categoryRows, { where: vi.fn(() => chainable(categoryRows)) });
      }
      if (table === itemCategoryKeywordsTable) {
        // Vocabulary lookup: innerJoin(categories).where(...). Returning an
        // empty list exercises the seed fallback (the classifier's own terms).
        return chainable([], {
          innerJoin: vi.fn(() => chainable([], { where: vi.fn(() => chainable([])) })),
        });
      }
      if (table === employeeCategoriesTable) {
        return chainable(ownerRows, {
          innerJoin: vi.fn(() =>
            chainable(ownerRows, { where: vi.fn(() => chainable(ownerRows)) }),
          ),
        });
      }
      if (table === rfqItemAssignmentsTable) {
        // Two call sites: the workload aggregate (has innerJoin) and the
        // "existing assignments" lookup (has where).
        return chainable(existingAssignmentRows, {
          innerJoin: vi.fn(() =>
            chainable(workloadRows, {
              innerJoin: vi.fn(() =>
                chainable(workloadRows, {
                  where: vi.fn(() =>
                    chainable(workloadRows, { groupBy: vi.fn(() => chainable(workloadRows)) }),
                  ),
                }),
              ),
              where: vi.fn(() =>
                chainable(workloadRows, { groupBy: vi.fn(() => chainable(workloadRows)) }),
              ),
            }),
          ),
          where: vi.fn(() => chainable(existingAssignmentRows)),
        });
      }
      if (table === rfqItemsTable) {
        return chainable(itemRows, { where: vi.fn(() => chainable(itemRows)) });
      }
      return chainable([], { where: vi.fn(() => chainable([])) });
    }),
  })),
  insert: vi.fn((table: any) => ({
    values: vi.fn((vals: any) => {
      if (table === rfqItemAssignmentsTable) {
        insertedAssignments.push(vals);
        return { onConflictDoUpdate: vi.fn(() => chainable(undefined)) };
      }
      return chainable(undefined);
    }),
  })),
  update: vi.fn((table: any) => ({
    set: vi.fn((vals: any) => ({
      where: vi.fn((cond: any) => {
        if (table === rfqItemsTable) updatedItemCalls.push({ id: cond?.right, vals });
        return chainable(undefined);
      }),
    })),
  })),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  itemCategoriesTable,
  employeeCategoriesTable,
  employeesTable,
  rfqItemsTable,
  rfqItemAssignmentsTable,
  rfqTable,
  itemCategoryKeywordsTable,
}));

vi.mock("../../shared/logger", () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

// Import AFTER the mock factories' state (dbMock) is initialised — a top-level
// import is hoisted above the const declarations and would throw.
let ensureAssignmentsForRfq: typeof import("../../modules/rfq/assignment").ensureAssignmentsForRfq;

beforeAll(async () => {
  ({ ensureAssignmentsForRfq } = await import("../../modules/rfq/assignment"));
});

beforeEach(() => {
  vi.clearAllMocks();
  insertedAssignments.length = 0;
  updatedItemCalls.length = 0;
  categoryRows = [
    { id: 1, code: "equipment", name: "أجهزة" },
    { id: 2, code: "spare_parts", name: "قطع غيار" },
    { id: 3, code: "electrical", name: "كهرباء" },
    { id: 4, code: "breakers", name: "قواطع" },
    { id: 5, code: "fire_resistance", name: "مقاومة حريق" },
  ];
  ownerRows = [];
  workloadRows = [];
  itemRows = [];
  existingAssignmentRows = [];
});

describe("assignment engine", () => {
  it("assigns a classified item to the category's primary owner", async () => {
    ownerRows = [
      { categoryId: 3, employeeId: 10, isPrimary: true, active: true },
      { categoryId: 3, employeeId: 11, isPrimary: false, active: true },
    ];
    itemRows = [
      {
        id: 100,
        rfqId: 5,
        description: "CABLE 3X2.5",
        partNo: null,
        lineItem: null,
        categoryId: null,
        customerRfqItemId: null,
      },
    ];

    const outcomes = await ensureAssignmentsForRfq(5);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      rfqItemId: 100,
      categoryId: 3,
      employeeId: 10,
      reason: "assigned",
    });
    // Category persisted onto the item + assignment inserted.
    expect(updatedItemCalls).toContainEqual({ id: 100, vals: { categoryId: 3 } });
    expect(insertedAssignments).toHaveLength(1);
    expect(insertedAssignments[0]).toMatchObject({
      rfqItemId: 100,
      categoryId: 3,
      employeeId: 10,
      source: "auto",
    });
  });

  it("load-balances between two eligible owners when neither is primary", async () => {
    ownerRows = [
      { categoryId: 3, employeeId: 10, isPrimary: false, active: true },
      { categoryId: 3, employeeId: 11, isPrimary: false, active: true },
    ];
    workloadRows = []; // both start at zero load
    itemRows = [
      {
        id: 200,
        rfqId: 6,
        description: "CABLE RED",
        partNo: null,
        lineItem: null,
        categoryId: null,
        customerRfqItemId: null,
      },
      {
        id: 201,
        rfqId: 6,
        description: "CABLE BLUE",
        partNo: null,
        lineItem: null,
        categoryId: null,
        customerRfqItemId: null,
      },
      {
        id: 202,
        rfqId: 6,
        description: "CABLE GREEN",
        partNo: null,
        lineItem: null,
        categoryId: null,
        customerRfqItemId: null,
      },
    ];

    const outcomes = await ensureAssignmentsForRfq(6);

    // Zero load on both: the first item goes to the lower id, then the in-loop
    // load update alternates so three items split 2 / 1.
    const byItem = new Map(outcomes.map((o) => [o.rfqItemId, o.employeeId]));
    expect(byItem.get(200)).toBe(10);
    expect(outcomes.filter((o) => o.employeeId === 10)).toHaveLength(2);
    expect(outcomes.filter((o) => o.employeeId === 11)).toHaveLength(1);
  });

  it("prefers the least-loaded owner when one already has a backlog", async () => {
    ownerRows = [
      { categoryId: 3, employeeId: 10, isPrimary: false, active: true },
      { categoryId: 3, employeeId: 11, isPrimary: false, active: true },
    ];
    workloadRows = [
      { employeeId: 10, cnt: 5 },
      { employeeId: 11, cnt: 1 },
    ];
    itemRows = [
      {
        id: 210,
        rfqId: 6,
        description: "CABLE RED",
        partNo: null,
        lineItem: null,
        categoryId: null,
        customerRfqItemId: null,
      },
      {
        id: 211,
        rfqId: 6,
        description: "CABLE BLUE",
        partNo: null,
        lineItem: null,
        categoryId: null,
        customerRfqItemId: null,
      },
    ];

    const outcomes = await ensureAssignmentsForRfq(6);

    // Employee 11 has the smaller backlog (1 vs 5) so it takes both items.
    expect(outcomes.every((o) => o.employeeId === 11)).toBe(true);
  });

  it("leaves an unclassifiable item unassigned (never fabricated)", async () => {
    ownerRows = [{ categoryId: 3, employeeId: 10, isPrimary: true, active: true }];
    itemRows = [
      {
        id: 300,
        rfqId: 7,
        description: "ZQX UNKNOWN 999",
        partNo: null,
        lineItem: null,
        categoryId: null,
        customerRfqItemId: null,
      },
    ];

    const outcomes = await ensureAssignmentsForRfq(7);

    expect(outcomes[0]).toMatchObject({
      categoryId: null,
      employeeId: null,
      reason: "unclassified",
    });
    expect(insertedAssignments).toHaveLength(0);
    expect(updatedItemCalls).toHaveLength(0);
  });

  it("does not assign on a part-number family hint alone (below threshold)", async () => {
    // 5720.* is an electrical family, but the family weight (30) is below
    // MIN_CONFIDENCE (40) so it must NOT classify/assign on its own.
    ownerRows = [{ categoryId: 3, employeeId: 10, isPrimary: true, active: true }];
    itemRows = [
      {
        id: 310,
        rfqId: 7,
        description: "ITEM",
        partNo: null,
        lineItem: "5720.001.X.0001",
        categoryId: null,
        customerRfqItemId: null,
      },
    ];

    const outcomes = await ensureAssignmentsForRfq(7);

    expect(outcomes[0]).toMatchObject({
      categoryId: null,
      employeeId: null,
      reason: "unclassified",
    });
    expect(insertedAssignments).toHaveLength(0);
  });

  it("reports no_owner when the category has no responsible employee", async () => {
    // Some employees own categories, but nobody owns fire resistance (5).
    ownerRows = [{ categoryId: 3, employeeId: 10, isPrimary: true, active: true }];
    itemRows = [
      {
        id: 400,
        rfqId: 8,
        description: "بند مقاومة حريق",
        partNo: null,
        lineItem: null,
        categoryId: null,
        customerRfqItemId: null,
      },
    ];

    const outcomes = await ensureAssignmentsForRfq(8);

    expect(outcomes[0]).toMatchObject({ categoryId: 5, employeeId: null, reason: "no_owner" });
    expect(insertedAssignments).toHaveLength(0);
  });

  it("does not overwrite an item that already has an assignment", async () => {
    ownerRows = [{ categoryId: 3, employeeId: 10, isPrimary: true, active: true }];
    itemRows = [
      {
        id: 500,
        rfqId: 9,
        description: "CABLE",
        partNo: null,
        lineItem: null,
        categoryId: 3,
        customerRfqItemId: null,
      },
    ];
    existingAssignmentRows = [{ rfqItemId: 500 }];

    const outcomes = await ensureAssignmentsForRfq(9);

    expect(outcomes).toHaveLength(0);
    expect(insertedAssignments).toHaveLength(0);
  });
});

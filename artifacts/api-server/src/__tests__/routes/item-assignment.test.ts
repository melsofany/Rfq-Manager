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
  description: "description",
  partNo: "partNo",
  lineItem: "lineItem",
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
const itemCategoryAliasesTable = {
  _: "itemCategoryAliases",
  categoryId: "categoryId",
  alias: "alias",
};
const itemClassificationIdentityTable = {
  _: "itemClassificationIdentity",
  identityKey: "identityKey",
  categoryId: "categoryId",
  source: "source",
  subcategoryIds: "subcategoryIds",
  brandId: "brandId",
  confidence: "confidence",
  timesSeen: "timesSeen",
};

// ── Per-test state ──────────────────────────────────────────────────────────
let categoryRows: any[];
let ownerRows: any[];
let workloadRows: any[];
let itemRows: any[];
let existingAssignmentRows: any[];
/** Rows the classification-memory table returns for an identity lookup. */
let memoryRows: any[];

const insertedAssignments: any[] = [];
const insertedMemory: any[] = [];
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
      if (table === itemCategoryAliasesTable) {
        return chainable([], { where: vi.fn(() => chainable([])) });
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
      if (table === itemClassificationIdentityTable) {
        const withLimit = chainable(memoryRows, { limit: vi.fn(() => chainable(memoryRows)) });
        return chainable(memoryRows, {
          where: vi.fn(() => withLimit),
          limit: vi.fn(() => chainable(memoryRows)),
        });
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
      if (table === itemClassificationIdentityTable) {
        insertedMemory.push(vals);
        return {
          onConflictDoUpdate: vi.fn(() => chainable(undefined)),
          onConflictDoNothing: vi.fn(() => chainable(undefined)),
        };
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
  itemCategoryAliasesTable,
  employeeCategoriesTable,
  employeesTable,
  rfqItemsTable,
  rfqItemAssignmentsTable,
  rfqTable,
  itemCategoryKeywordsTable,
  itemClassificationIdentityTable,
}));

vi.mock("../../shared/logger", () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

// Import AFTER the mock factories' state (dbMock) is initialised — a top-level
// import is hoisted above the const declarations and would throw.
let ensureAssignmentsForRfq: typeof import("../../modules/rfq/assignment").ensureAssignmentsForRfq;
let assignItemManually: typeof import("../../modules/rfq/assignment").assignItemManually;
let classificationIdentityKey: typeof import("../../modules/rfq/item-identity").classificationIdentityKey;

beforeAll(async () => {
  ({ ensureAssignmentsForRfq, assignItemManually } = await import("../../modules/rfq/assignment"));
  ({ classificationIdentityKey } = await import("../../modules/rfq/item-identity"));
});

beforeEach(() => {
  vi.clearAllMocks();
  insertedAssignments.length = 0;
  insertedMemory.length = 0;
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
  memoryRows = [];
});

describe("assignment engine", () => {
  it("attributes a SUBCATEGORY item to the DOMAIN's owner, never to the subcategory", async () => {
    // قواطع is a subcategory of كهرباء: responsibility belongs to the domain's
    // owner. An owner attached to the subcategory itself must NOT receive it.
    categoryRows = [
      { id: 3, code: "electrical", name: "كهرباء", kind: "functional", parentId: null },
      { id: 4, code: "breakers", name: "قواطع", kind: "subcategory", parentId: 3 },
    ];
    ownerRows = [
      { categoryId: 3, employeeId: 10, isPrimary: true, active: true },
      { categoryId: 4, employeeId: 99, isPrimary: true, active: true },
    ];
    itemRows = [
      {
        id: 150,
        rfqId: 7,
        description: "CIRCUIT BREAKER 3P 30A",
        partNo: null,
        lineItem: null,
        categoryId: null,
        customerRfqItemId: null,
      },
    ];

    const outcomes = await ensureAssignmentsForRfq(7);

    expect(outcomes[0]).toMatchObject({ rfqItemId: 150, categoryId: 3, employeeId: 10 });
    expect(insertedAssignments[0]).toMatchObject({ categoryId: 3, employeeId: 10 });
  });

  it("leaves a BRAND item unassigned — a brand never owns responsibility", async () => {
    categoryRows = [{ id: 6, code: "siemens", name: "Siemens", kind: "brand", parentId: null }];
    ownerRows = [{ categoryId: 6, employeeId: 10, isPrimary: true, active: true }];
    itemRows = [
      {
        id: 160,
        rfqId: 8,
        description: "SIEMENS CONTACTOR",
        partNo: null,
        lineItem: null,
        categoryId: 6,
        customerRfqItemId: null,
      },
    ];

    const outcomes = await ensureAssignmentsForRfq(8);

    expect(outcomes[0]).toMatchObject({ rfqItemId: 160, employeeId: null });
    expect(insertedAssignments).toHaveLength(0);
  });

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

  it("manual override refuses an OWNER for a BRAND category (a brand never owns)", async () => {
    categoryRows = [
      { id: 3, code: "electrical", name: "كهرباء", kind: "functional", parentId: null },
      { id: 9, code: "siemens", name: "Siemens", kind: "brand", parentId: null },
    ];
    itemRows = [{ id: 500, rfqId: 9, customerRfqItemId: null, categoryId: 3 }];

    await assignItemManually({ rfqItemId: 500, categoryId: 9, employeeId: 7, assignedBy: 1 });

    expect(insertedAssignments).toHaveLength(1);
    expect(insertedAssignments[0]).toMatchObject({ categoryId: 9, employeeId: null });
  });

  it("manual override refuses an OWNER for a SUBCATEGORY category (owner resolves to the domain)", async () => {
    categoryRows = [
      { id: 3, code: "electrical", name: "كهرباء", kind: "functional", parentId: null },
      { id: 4, code: "breakers", name: "قواطع", kind: "subcategory", parentId: 3 },
    ];
    itemRows = [{ id: 500, rfqId: 9, customerRfqItemId: null, categoryId: 3 }];

    await assignItemManually({ rfqItemId: 500, categoryId: 4, employeeId: 7, assignedBy: 1 });

    expect(insertedAssignments[0]).toMatchObject({ categoryId: 4, employeeId: null });
  });

  it("manual override still records an OWNER for a FUNCTIONAL category", async () => {
    categoryRows = [
      { id: 3, code: "electrical", name: "كهرباء", kind: "functional", parentId: null },
    ];
    itemRows = [{ id: 500, rfqId: 9, customerRfqItemId: null, categoryId: 3 }];

    await assignItemManually({ rfqItemId: 500, categoryId: 3, employeeId: 7, assignedBy: 1 });

    expect(insertedAssignments[0]).toMatchObject({ categoryId: 3, employeeId: 7 });
  });

  it("CONSULTS the identity memory before the keyword classifier (cross-path consistency)", async () => {
    // The defect this guards: a supplier line whose description does NOT contain
    // the keyword for the category it was assigned on the customer side was
    // classified FRESH and could land in a DIFFERENT domain. The memory must win.
    categoryRows = [
      { id: 3, code: "electrical", name: "كهرباء", kind: "functional", parentId: null },
      { id: 5, code: "fire_resistance", name: "مقاومة حريق", kind: "functional", parentId: null },
    ];
    ownerRows = [
      { categoryId: 3, employeeId: 10, isPrimary: true, active: true },
      { categoryId: 5, employeeId: 20, isPrimary: true, active: true },
    ];
    // «FIRE RESISTANT» contains no electrical keyword, so the classifier alone
    // would never pick كهرباء — only the memory can.
    itemRows = [
      {
        id: 700,
        rfqId: 12,
        description: "SPECIAL CABLE FIRE RESISTANT 3X2.5",
        partNo: null,
        lineItem: null,
        categoryId: null,
        customerRfqItemId: null,
      },
    ];
    memoryRows = [
      {
        identityKey: classificationIdentityKey({
          partNo: null,
          description: "SPECIAL CABLE FIRE RESISTANT 3X2.5",
          lineItem: null,
        })!,
        categoryId: 3,
        subcategoryIds: null,
        brandId: null,
        source: "auto",
        confidence: "95",
      },
    ];

    const outcomes = await ensureAssignmentsForRfq(12);

    expect(outcomes[0]).toMatchObject({ rfqItemId: 700, categoryId: 3, employeeId: 10 });
    expect(insertedAssignments[0]).toMatchObject({ categoryId: 3, employeeId: 10 });
  });

  it("REMEMBERS a fresh classification by identity so the next RFQ agrees", async () => {
    categoryRows = [
      { id: 3, code: "electrical", name: "كهرباء", kind: "functional", parentId: null },
      { id: 4, code: "breakers", name: "قواطع", kind: "subcategory", parentId: 3 },
    ];
    ownerRows = [{ categoryId: 3, employeeId: 10, isPrimary: true, active: true }];
    itemRows = [
      {
        id: 701,
        rfqId: 13,
        description: "CIRCUIT BREAKER 3P 30A",
        partNo: "A9R41440",
        lineItem: null,
        categoryId: null,
        customerRfqItemId: null,
      },
    ];
    memoryRows = []; // nothing remembered yet

    await ensureAssignmentsForRfq(13);

    expect(insertedMemory).toHaveLength(1);
    expect(insertedMemory[0]).toMatchObject({ categoryId: 3 });
  });
});

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// ── drizzle-orm sentinels ───────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  ne: (left: any, right: any) => ({ __op: "ne", left, right }),
  and: (...args: any[]) => ({ __op: "and", args }),
  inArray: (left: any, right: any) => ({ __op: "inArray", left, right }),
  isNull: (col: any) => ({ __op: "isNull", col }),
  asc: (col: any) => ({ __op: "asc", col }),
  sql: Object.assign((strings: any, ...values: any[]) => ({ __op: "sql", strings, values }), {
    raw: (s: string) => ({ __op: "sql.raw", s }),
  }),
}));

function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

/** A chainable+thenable that resolves to `value` after any chain of methods. */
function chain(value: any, extra: Record<string, any> = {}): any {
  const self = () =>
    chainable(value, {
      where: vi.fn(self),
      innerJoin: vi.fn(self),
      leftJoin: vi.fn(self),
      orderBy: vi.fn(self),
      groupBy: vi.fn(self),
      limit: vi.fn(self),
      ...extra,
    });
  return self();
}

// Table sentinels.
const itemCategoriesTable = { _: "itemCategories", id: "id", code: "code", isActive: "isActive" };
const employeeCategoriesTable = {
  _: "employeeCategories",
  categoryId: "categoryId",
  employeeId: "employeeId",
  isPrimary: "isPrimary",
};
const employeesTable = { _: "employees", id: "id", isActive: "isActive", name: "name" };
const rfqItemsTable = {
  _: "rfqItems",
  id: "id",
  rfqId: "rfqId",
  customerRfqItemId: "customerRfqItemId",
  categoryId: "categoryId",
  createdAt: "createdAt",
};
const rfqItemAssignmentsTable = {
  _: "rfqItemAssignments",
  rfqItemId: "rfqItemId",
  employeeId: "employeeId",
};
const rfqTable = { _: "rfq", id: "id", status: "status" };
const customerRfqItemsTable = {
  _: "customerRfqItems",
  id: "id",
  customerRfqId: "customerRfqId",
  categoryId: "categoryId",
  description: "description",
  partNo: "partNo",
  lineItem: "lineItem",
};
const customerRfqItemAssignmentsTable = {
  _: "customerAssignments",
  customerRfqItemId: "customerRfqItemId",
  categoryId: "categoryId",
  employeeId: "employeeId",
  source: "source",
  confidence: "confidence",
  validFrom: "validFrom",
  validTo: "validTo",
  assignedBy: "assignedBy",
};
const itemAssignmentAuditTable = { _: "audit" };
const itemCategoryKeywordsTable = {
  _: "itemCategoryKeywords",
  categoryId: "categoryId",
  keyword: "keyword",
  weight: "weight",
  enabled: "enabled",
};

let categoryRows: any[];
let ownerRows: any[];
let workloadRows: any[];
let customerItemRows: any[];
let customerAssignmentRows: any[];
let supplierItemRows: any[];

const insertedCustomerAssignments: any[] = [];
const insertedAudits: any[] = [];
const updatedCustomerItemCalls: Array<{ id: number; vals: any }> = [];

const dbMock: any = {
  select: vi.fn((arg?: any) => ({
    from: vi.fn((table: any) => {
      if (table === itemCategoriesTable) return chain(categoryRows);
      if (table === itemCategoryKeywordsTable) return chain([]);
      if (table === employeeCategoriesTable) return chain(ownerRows);
      if (table === rfqItemAssignmentsTable) return chain(workloadRows);
      if (table === customerRfqItemAssignmentsTable) {
        // The workload aggregate selects {employeeId, cnt}; the manual-override
        // lookup selects {categoryId, employeeId}.
        const isWorkload = arg && typeof arg === "object" && "cnt" in arg;
        return chain(isWorkload ? workloadRows : customerAssignmentRows);
      }
      if (table === customerRfqItemsTable) return chain(customerItemRows);
      if (table === rfqItemsTable) return chain(supplierItemRows);
      if (table === employeesTable) return chain([]);
      return chain([]);
    }),
  })),
  insert: vi.fn((table: any) => ({
    values: vi.fn((vals: any) => {
      if (table === customerRfqItemAssignmentsTable) {
        insertedCustomerAssignments.push(vals);
        return {
          onConflictDoUpdate: vi.fn(() => chainable(undefined)),
          onConflictDoNothing: vi.fn(() => chainable(undefined)),
          returning: vi.fn(() => chainable([{ id: 1 }])),
        };
      }
      if (table === itemAssignmentAuditTable) {
        insertedAudits.push(vals);
        return chainable(undefined);
      }
      return chainable(undefined);
    }),
  })),
  update: vi.fn((table: any) => ({
    set: vi.fn((vals: any) => ({
      where: vi.fn((cond: any) => {
        if (table === customerRfqItemsTable)
          updatedCustomerItemCalls.push({ id: cond?.right, vals });
        return chainable(undefined);
      }),
    })),
  })),
  // Manual override now runs in a transaction; the tx is the same mock handle.
  transaction: vi.fn(async (fn: any) => fn(dbMock)),
  execute: vi.fn(async () => ({ rows: [{ ts: "2026-01-01T00:00:00.000Z" }] })),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  itemCategoriesTable,
  employeeCategoriesTable,
  employeesTable,
  rfqItemsTable,
  rfqItemAssignmentsTable,
  rfqTable,
  customerRfqItemsTable,
  customerRfqItemAssignmentsTable,
  itemAssignmentAuditTable,
  itemCategoryKeywordsTable,
}));

vi.mock("../../shared/logger", () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

// The AI classifier is the provider seam for the assignment engine. Default to
// `null` (unavailable) so the deterministic keyword path is exercised; a test
// that wants the AI path sets a resolved value.
const aiClassify = vi.fn();
vi.mock("../../modules/rfq/ai-classifier", () => ({
  classifyItemsWithAi: (...args: any[]) => aiClassify(...args),
}));

let ensureCustomerAssignments: typeof import("../../modules/rfq/customer-assignment").ensureCustomerAssignments;
let assignCustomerItemManually: typeof import("../../modules/rfq/customer-assignment").assignCustomerItemManually;

beforeAll(async () => {
  const mod = await import("../../modules/rfq/customer-assignment");
  ensureCustomerAssignments = mod.ensureCustomerAssignments;
  assignCustomerItemManually = mod.assignCustomerItemManually;
});

beforeEach(() => {
  vi.clearAllMocks();
  categoryRows = [
    { id: 1, code: "equipment", isActive: true },
    { id: 2, code: "spare_parts", isActive: true },
    { id: 3, code: "electrical", isActive: true },
  ];
  ownerRows = [
    { categoryId: 3, employeeId: 5, isPrimary: true, active: true },
    { categoryId: 3, employeeId: 6, isPrimary: false, active: true },
  ];
  workloadRows = [];
  customerItemRows = [];
  customerAssignmentRows = [];
  supplierItemRows = [];
  insertedCustomerAssignments.length = 0;
  insertedAudits.length = 0;
  updatedCustomerItemCalls.length = 0;
  aiClassify.mockReset();
  aiClassify.mockResolvedValue(null); // AI unavailable by default → keyword path
});

describe("customer-item assignment engine", () => {
  it("classifies and assigns a new customer item to its category owner", async () => {
    customerItemRows = [
      {
        id: 500,
        customerRfqId: 10,
        description: "CABLE 3X2.5 MM",
        partNo: null,
        lineItem: null,
        categoryId: null,
      },
    ];
    const outcomes = await ensureCustomerAssignments(10);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].reason).toBe("assigned");
    expect(outcomes[0].categoryId).toBe(3); // electrical
    expect(outcomes[0].employeeId).toBe(5); // primary owner
    expect(insertedCustomerAssignments).toHaveLength(1);
    expect(insertedCustomerAssignments[0].source).toBe("auto");
  });

  it("leaves an unclassifiable item unassigned (never guesses)", async () => {
    customerItemRows = [
      {
        id: 501,
        customerRfqId: 10,
        description: "ZQX UNKNOWN 999",
        partNo: null,
        lineItem: null,
        categoryId: null,
      },
    ];
    const outcomes = await ensureCustomerAssignments(10);
    expect(outcomes[0].reason).toBe("unclassified");
    expect(outcomes[0].employeeId).toBeNull();
    expect(insertedCustomerAssignments).toHaveLength(0);
  });

  it("AI-first: assigns an item the KEYWORD classifier cannot place", async () => {
    // "منظم جهد" carries no seeded keyword, so the deterministic classifier
    // leaves it unclassified. The AI pass places it in electrical (id 3) and
    // the item is assigned — this is the whole point of the AI module.
    customerItemRows = [
      {
        id: 600,
        customerRfqId: 10,
        description: "منظم جهد اتوماتيكي",
        partNo: null,
        lineItem: null,
        categoryId: null,
      },
    ];
    aiClassify.mockResolvedValue([{ categoryId: 3, confidence: 91, matchedTerm: "electrical" }]);
    const outcomes = await ensureCustomerAssignments(10);
    expect(outcomes[0].reason).toBe("assigned");
    expect(outcomes[0].categoryId).toBe(3);
    expect(outcomes[0].employeeId).toBe(5);
    expect(insertedCustomerAssignments).toHaveLength(1);
    // The chosen category is persisted on the item row.
    expect(updatedCustomerItemCalls.some((c) => c.id === 600 && c.vals.categoryId === 3)).toBe(
      true,
    );
  });

  it("AI-first: keeps «غير معروف» unassigned (AI declines → keyword also fails)", async () => {
    customerItemRows = [
      {
        id: 601,
        customerRfqId: 10,
        description: "ZQX UNKNOWN 999",
        partNo: null,
        lineItem: null,
        categoryId: null,
      },
    ];
    aiClassify.mockResolvedValue([null]); // model declined
    const outcomes = await ensureCustomerAssignments(10);
    expect(outcomes[0].reason).toBe("unclassified");
    expect(outcomes[0].employeeId).toBeNull();
    expect(insertedCustomerAssignments).toHaveLength(0);
  });

  it("falls back to the keyword classifier when the AI pass returns null", async () => {
    customerItemRows = [
      {
        id: 602,
        customerRfqId: 10,
        description: "CABLE 3X2.5 MM",
        partNo: null,
        lineItem: null,
        categoryId: null,
      },
    ];
    aiClassify.mockResolvedValue(null); // provider unavailable
    const outcomes = await ensureCustomerAssignments(10);
    expect(outcomes[0].categoryId).toBe(3); // electrical, via keywords
    expect(outcomes[0].employeeId).toBe(5);
  });

  it("does NOT call the AI pass for an item that is already categorised", async () => {
    customerItemRows = [
      {
        id: 603,
        customerRfqId: 10,
        description: "anything",
        partNo: null,
        lineItem: null,
        categoryId: 2, // already categorised
      },
    ];
    await ensureCustomerAssignments(10);
    expect(aiClassify).not.toHaveBeenCalled();
  });

  it("assigns a category with no owner as classified-but-unassigned (no_owner)", async () => {
    customerItemRows = [
      {
        id: 502,
        customerRfqId: 10,
        description: "BEARING 6205",
        partNo: null,
        lineItem: null,
        categoryId: null,
      },
    ];
    const outcomes = await ensureCustomerAssignments(10);
    expect(outcomes[0].categoryId).toBe(2); // spare_parts
    expect(outcomes[0].employeeId).toBeNull();
    expect(outcomes[0].reason).toBe("no_owner");
  });

  it("KEEPS an existing assignment — an edit never moves responsibility", async () => {
    // Item 500 already has an assignment (employee 9). Re-running ensure must
    // not create a second row nor move it to the category's primary owner.
    customerItemRows = [
      {
        id: 500,
        customerRfqId: 10,
        description: "CABLE 3X2.5",
        partNo: null,
        lineItem: null,
        categoryId: 3,
      },
    ];
    customerAssignmentRows = [
      { customerRfqItemId: 500, categoryId: 3, employeeId: 9, source: "manual" },
    ];
    const outcomes = await ensureCustomerAssignments(10);
    expect(outcomes[0].reason).toBe("kept");
    expect(insertedCustomerAssignments).toHaveLength(0);
  });

  it("with newItemIds, assigns ONLY the new items and leaves the rest untouched", async () => {
    customerItemRows = [
      {
        id: 500,
        customerRfqId: 10,
        description: "CABLE",
        partNo: null,
        lineItem: null,
        categoryId: 3,
      },
      {
        id: 601,
        customerRfqId: 10,
        description: "BEARING 6205",
        partNo: null,
        lineItem: null,
        categoryId: null,
      },
    ];
    customerAssignmentRows = [
      { customerRfqItemId: 500, categoryId: 3, employeeId: 9, source: "manual" },
    ];
    ownerRows = [{ categoryId: 2, employeeId: 7, isPrimary: true, active: true }];
    const outcomes = await ensureCustomerAssignments(10, { newItemIds: [601] });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].customerRfqItemId).toBe(601);
    expect(outcomes[0].categoryId).toBe(2);
    expect(outcomes[0].employeeId).toBe(7);
    // Item 500 was NOT touched.
    expect(insertedCustomerAssignments).toHaveLength(1);
    expect(insertedCustomerAssignments[0].customerRfqItemId).toBe(601);
  });

  it("manual override records an audit row with old/new values and the actor", async () => {
    customerItemRows = [{ id: 500, customerRfqId: 10, categoryId: 3 }];
    customerAssignmentRows = [{ customerRfqItemId: 500, categoryId: 3, employeeId: 9 }];
    await assignCustomerItemManually({
      customerRfqItemId: 500,
      categoryId: 3,
      employeeId: 6,
      assignedBy: 1,
      reason: "تحويل حسب التخصص",
    });
    expect(insertedAudits).toHaveLength(1);
    expect(insertedAudits[0]).toMatchObject({
      scope: "customer",
      customerRfqItemId: 500,
      employeeIdOld: 9,
      employeeIdNew: 6,
      changedBy: 1,
      reason: "تحويل حسب التخصص",
    });
  });

  it("a no-op manual re-save does NOT write an audit row", async () => {
    customerItemRows = [{ id: 500, customerRfqId: 10, categoryId: 3 }];
    customerAssignmentRows = [{ customerRfqItemId: 500, categoryId: 3, employeeId: 6 }];
    await assignCustomerItemManually({
      customerRfqItemId: 500,
      categoryId: 3,
      employeeId: 6,
      assignedBy: 1,
    });
    expect(insertedAudits).toHaveLength(0);
  });
});

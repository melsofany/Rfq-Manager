import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// ── drizzle-orm sentinels ───────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  ne: (left: any, right: any) => ({ __op: "ne", left, right }),
  and: (...args: any[]) => ({ __op: "and", args }),
  inArray: (left: any, right: any) => ({ __op: "inArray", left, right }),
  isNull: (col: any) => ({ __op: "isNull", col }),
  isNotNull: (col: any) => ({ __op: "isNotNull", col }),
  asc: (col: any) => ({ __op: "asc", col }),
  desc: (col: any) => ({ __op: "desc", col }),
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
  subcategoryIds: "subcategoryIds",
  isCancelled: "isCancelled",
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

let categoryRows: any[];
let ownerRows: any[];
let workloadRows: any[];
let customerItemRows: any[];
let customerAssignmentRows: any[];
let supplierItemRows: any[];
/** Rows the classification-memory table returns for a lookup. */
let memoryRows: any[];

const insertedCustomerAssignments: any[] = [];
const insertedAudits: any[] = [];
const insertedMemory: any[] = [];
const updatedCustomerItemCalls: Array<{ id: number; vals: any }> = [];

const dbMock: any = {
  select: vi.fn((arg?: any) => ({
    from: vi.fn((table: any) => {
      if (table === itemCategoriesTable) return chain(categoryRows);
      if (table === itemCategoryKeywordsTable) return chain([]);
      if (table === itemCategoryAliasesTable) return chain([]);
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
      if (table === itemClassificationIdentityTable) return chain(memoryRows);
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
        if (table === customerRfqItemsTable) {
          updatedCustomerItemCalls.push({ id: cond?.right, vals });
          // Reflect onto the in-memory rows so a follow-on pass (e.g. the
          // assign step after a bulk classify) sees the item as classified.
          const row = customerItemRows.find((r) => r.id === cond?.right);
          if (row) Object.assign(row, vals);
        }
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
  itemCategoryAliasesTable,
  employeeCategoriesTable,
  employeesTable,
  rfqItemsTable,
  rfqItemAssignmentsTable,
  rfqTable,
  customerRfqItemsTable,
  customerRfqItemAssignmentsTable,
  itemAssignmentAuditTable,
  itemCategoryKeywordsTable,
  itemClassificationIdentityTable,
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
let classifyUnclassifiedItems: typeof import("../../modules/rfq/customer-assignment").classifyUnclassifiedItems;
let repairClassificationConsistency: typeof import("../../modules/rfq/customer-assignment").repairClassificationConsistency;
let listClassificationConflicts: typeof import("../../modules/rfq/customer-assignment").listClassificationConflicts;

beforeAll(async () => {
  const mod = await import("../../modules/rfq/customer-assignment");
  ensureCustomerAssignments = mod.ensureCustomerAssignments;
  assignCustomerItemManually = mod.assignCustomerItemManually;
  classifyUnclassifiedItems = mod.classifyUnclassifiedItems;
  repairClassificationConsistency = mod.repairClassificationConsistency;
  listClassificationConflicts = mod.listClassificationConflicts;
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
  memoryRows = [];
  insertedCustomerAssignments.length = 0;
  insertedAudits.length = 0;
  insertedMemory.length = 0;
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

  it("refuses to record an OWNER for a BRAND category (a brand never owns)", async () => {
    categoryRows = [
      { id: 3, code: "electrical", name: "كهرباء", kind: "functional", isActive: true },
      { id: 9, code: "siemens", name: "Siemens", kind: "brand", isActive: true },
    ];
    customerItemRows = [{ id: 500, customerRfqId: 10, categoryId: 3 }];
    customerAssignmentRows = [{ customerRfqItemId: 500, categoryId: 3, employeeId: null }];
    await assignCustomerItemManually({
      customerRfqItemId: 500,
      categoryId: 9, // a brand
      employeeId: 6,
      assignedBy: 1,
    });
    // The brand category may be recorded for review, but never with an owner.
    expect(insertedCustomerAssignments).toHaveLength(1);
    expect(insertedCustomerAssignments[0]).toMatchObject({
      customerRfqItemId: 500,
      categoryId: 9,
      employeeId: null,
    });
  });

  it("refuses to record an OWNER for a SUBCATEGORY category (owner resolves to the domain)", async () => {
    categoryRows = [
      { id: 3, code: "electrical", name: "كهرباء", kind: "functional", isActive: true },
      { id: 8, code: "breakers", name: "قواطع", kind: "subcategory", parentId: 3, isActive: true },
    ];
    customerItemRows = [{ id: 500, customerRfqId: 10, categoryId: 3 }];
    customerAssignmentRows = [{ customerRfqItemId: 500, categoryId: 3, employeeId: null }];
    await assignCustomerItemManually({
      customerRfqItemId: 500,
      categoryId: 8, // a subcategory
      employeeId: 6,
      assignedBy: 1,
    });
    expect(insertedCustomerAssignments[0]).toMatchObject({
      categoryId: 8,
      employeeId: null,
    });
  });

  it("bulk classify: categorises unclassified items and assigns their owners", async () => {
    categoryRows = [
      { id: 3, code: "electrical", name: "كهرباء", isActive: true },
      { id: 2, code: "spare_parts", name: "قطع غيار", isActive: true },
    ];
    ownerRows = [{ categoryId: 3, employeeId: 5, isPrimary: true, active: true }];
    customerItemRows = [
      {
        id: 700,
        customerRfqId: 42,
        description: "منظم جهد",
        partNo: null,
        lineItem: null,
        categoryId: null,
      },
    ];
    aiClassify.mockResolvedValue([{ categoryId: 3, confidence: 90, matchedTerm: "كهرباء" }]);
    const result = await classifyUnclassifiedItems({ limit: 50 });
    expect(result.scanned).toBe(1);
    expect(result.classified).toBe(1);
    expect(updatedCustomerItemCalls[0]).toEqual({
      id: 700,
      vals: {
        categoryId: 3,
        brandId: null,
        subcategoryIds: null,
        technicalAttributes: null,
        classifyConfidence: "90",
        classifyReason: null,
      },
    });
    expect(insertedCustomerAssignments).toHaveLength(1);
    expect(insertedCustomerAssignments[0].employeeId).toBe(5);
  });

  it("bulk classify: does nothing when there are no unclassified items", async () => {
    customerItemRows = [];
    const result = await classifyUnclassifiedItems({});
    expect(result).toEqual({ scanned: 0, classified: 0, batches: 0 });
    expect(aiClassify).not.toHaveBeenCalled();
  });

  it("bulk classify: leaves items the model declines unclassified (never invents)", async () => {
    categoryRows = [{ id: 3, code: "electrical", name: "كهرباء", isActive: true }];
    customerItemRows = [
      {
        id: 701,
        customerRfqId: 42,
        description: "ZZZ ???",
        partNo: null,
        lineItem: null,
        categoryId: null,
      },
    ];
    aiClassify.mockResolvedValue([null]);
    const result = await classifyUnclassifiedItems({});
    expect(result.classified).toBe(0);
    expect(updatedCustomerItemCalls).toHaveLength(0);
  });
});

describe("identity memory — the same item keeps ONE category", () => {
  it("reuses a remembered category and never calls the model", async () => {
    // The SAME part number was classified as كهرباء (3) on an earlier RFQ. This
    // RFQ must resolve it from memory — no AI call, no keyword guess.
    memoryRows = [{ identityKey: "pn:680632", categoryId: 3, source: "auto", confidence: 90 }];
    customerItemRows = [
      {
        id: 800,
        customerRfqId: 20,
        description: "CIRCUIT BREAKER 3P",
        partNo: "680632",
        lineItem: null,
        categoryId: null,
      },
    ];
    const outcomes = await ensureCustomerAssignments(20);
    expect(outcomes[0].categoryId).toBe(3);
    expect(outcomes[0].reason).toBe("assigned");
    expect(outcomes[0].employeeId).toBe(5);
    expect(aiClassify).not.toHaveBeenCalled(); // memory short-circuits the model
    expect(updatedCustomerItemCalls.some((c) => c.id === 800 && c.vals.categoryId === 3)).toBe(
      true,
    );
  });

  it("classifies an item the keyword classifier cannot, from memory alone", async () => {
    // «منظم جهد اتوماتيكي» carries no seeded keyword — without memory it is
    // unclassified. Memory places it, proving memory (not keywords) is what
    // keeps the same item consistent.
    memoryRows = [{ identityKey: "ds:اتوماتيكي جهد منظم", categoryId: 3, source: "auto" }];
    customerItemRows = [
      {
        id: 801,
        customerRfqId: 20,
        description: "منظم جهد اتوماتيكي",
        partNo: null,
        lineItem: null,
        categoryId: null,
      },
    ];
    const outcomes = await ensureCustomerAssignments(20);
    expect(outcomes[0].reason).toBe("assigned");
    expect(outcomes[0].categoryId).toBe(3);
    expect(aiClassify).not.toHaveBeenCalled();
  });

  it("remembers an automatic decision by identity so the next RFQ reuses it", async () => {
    customerItemRows = [
      {
        id: 802,
        customerRfqId: 20,
        description: "CABLE 3X2.5 MM COPPER",
        partNo: null,
        lineItem: null,
        categoryId: null,
      },
    ];
    await ensureCustomerAssignments(20);
    expect(insertedMemory).toHaveLength(1);
    expect(insertedMemory[0].source).toBe("auto");
    expect(insertedMemory[0].categoryId).toBe(3);
    expect(insertedMemory[0].identityKey.startsWith("ds:")).toBe(true);
  });

  it("a manager's manual decision is remembered authoritatively", async () => {
    customerAssignmentRows = [{ categoryId: null, employeeId: null }];
    customerItemRows = [
      {
        id: 803,
        customerRfqId: 20,
        description: "CABLE 3X2.5 MM COPPER",
        partNo: null,
        lineItem: null,
        categoryId: null,
      },
    ];
    await assignCustomerItemManually({
      customerRfqItemId: 803,
      categoryId: 2, // manager overrides to قطع غيار
      employeeId: 6,
      assignedBy: 9,
    });
    const manual = insertedMemory.find((m) => m.source === "manual");
    expect(manual).toBeTruthy();
    expect(manual.categoryId).toBe(2);
  });
});

describe("startup backfill — the legacy backlog is repaired, model-free", () => {
  it("classifies unclassified items without calling the model", async () => {
    const mod = await import("../../modules/rfq/customer-assignment");
    customerItemRows = [
      {
        id: 900,
        customerRfqId: 30,
        description: "CABLE 3X2.5 MM COPPER",
        partNo: null,
        lineItem: null,
        categoryId: null,
      },
    ];
    const result = await mod.backfillItemClassification({ limit: 10 });
    expect(result.classified).toBe(1);
    expect(aiClassify).not.toHaveBeenCalled();
    // The decision is remembered by identity (the follow-on assign step may
    // re-remember the same identity — an idempotent upsert, never a duplicate).
    expect(insertedMemory.length).toBeGreaterThanOrEqual(1);
    expect(insertedMemory[0].source).toBe("auto");
    expect(insertedMemory[0].categoryId).toBe(3);
  });

  it("seeds memory from items that already carry a category", async () => {
    const mod = await import("../../modules/rfq/customer-assignment");
    // A historical item ALREADY has category 3. The seed must remember it by
    // identity so a later RFQ with the same item resolves without re-classifying.
    customerItemRows = [
      {
        id: 901,
        customerRfqId: 31,
        description: "CABLE 3X2.5 MM COPPER",
        partNo: null,
        lineItem: null,
        categoryId: 3,
      },
    ];
    const seeded = await mod.seedClassificationMemoryFromClassified(10);
    expect(seeded).toBe(1);
    expect(insertedMemory.some((m) => m.categoryId === 3 && m.source === "auto")).toBe(true);
  });
});

describe("repair — the SAME item is unified onto ONE domain", () => {
  beforeEach(() => {
    // كهرباء (3) owns the domain; إضاءة (8) is its subcategory — NOT a domain.
    categoryRows = [
      { id: 3, code: "electrical", name: "كهرباء", kind: "functional", isActive: true },
      { id: 8, code: "lighting", name: "إضاءة", kind: "subcategory", parentId: 3, isActive: true },
      { id: 2, code: "spare_parts", name: "قطع غيار", kind: "functional", isActive: true },
    ];
  });

  it("unifies an item that is كهرباء in one RFQ and إضاءة in another", async () => {
    // The operator's LED-lamp case: same Part No, two categories, plus
    // unclassified copies.
    const desc = "LED TUBE LAMP 120CM 18W 1750LM EL SEWEEDY";
    customerItemRows = [
      { id: 1, customerRfqId: 10, partNo: "5720.010", description: desc, categoryId: 8 }, // إضاءة
      { id: 2, customerRfqId: 11, partNo: "5720.010", description: desc, categoryId: 3 }, // كهرباء
      { id: 3, customerRfqId: 12, partNo: "5720.010", description: desc, categoryId: null },
      { id: 4, customerRfqId: 13, partNo: "5720.010", description: desc, categoryId: null },
    ];
    const result = await repairClassificationConsistency({ limit: 100 });
    expect(result.identities).toBe(1);
    // ids 1,3,4 rewritten to 3 (id 2 already 3).
    expect(result.itemsFixed).toBe(3);
    const finalCats = customerItemRows.map((r) => r.categoryId);
    expect(new Set(finalCats)).toEqual(new Set([3]));
  });

  it("unifies the operator's LED lamp (same Line Item, drifting description)", async () => {
    // The exact production shape: NO part number, the SAME line item, and a
    // description that differs by a letter across rows. Only the line-item
    // identity can unify these — a description key would split them.
    customerItemRows = [
      {
        id: 1,
        customerRfqId: 10,
        partNo: null,
        lineItem: "5720.010.GENRAL.7054",
        description: "LED TUBE LAMP 120CM, 18W, 1750LM ( EL SEWEEDY )",
        categoryId: 8,
      },
      {
        id: 2,
        customerRfqId: 11,
        partNo: null,
        lineItem: "5720.010.GENRAL.7054",
        description: "LED TUBE LAMP 120CM, 18W, 1750LM ( ELSEWEEDY )",
        categoryId: 3,
      },
      {
        id: 3,
        customerRfqId: 12,
        partNo: null,
        lineItem: "5720.010.GENRAL.7054",
        description: "LED TUBE LAMP 120CM, 18W, 1750LM ( EL SEWEEDY )",
        categoryId: null,
      },
    ];
    const result = await repairClassificationConsistency({ limit: 100 });
    expect(result.identities).toBe(1);
    expect(new Set(customerItemRows.map((r) => r.categoryId))).toEqual(new Set([3]));
  });

  it("unifies two CLASSIFIED rows that share a line item but drift in wording", async () => {
    // Two DIFFERENT functional domains (قطع غيار 2 vs كهرباء 3), no unclassified
    // copy — only the shared line-item identity can see them as one item. A
    // description key would leave both as separate, consistent-looking
    // identities and never fix the operator's complaint.
    customerItemRows = [
      {
        id: 1,
        customerRfqId: 10,
        partNo: null,
        lineItem: "5720.010.GENRAL.7054",
        description: "LED TUBE LAMP 120CM, 18W, 1750LM ( EL SEWEEDY )",
        categoryId: 2,
      },
      {
        id: 2,
        customerRfqId: 11,
        partNo: null,
        lineItem: "5720.010.GENRAL.7054",
        description: "LED TUBE LAMP 120CM, 18W, 1750LM ( ELSEWEEDY )",
        categoryId: 3,
      },
    ];
    const result = await repairClassificationConsistency({ limit: 100 });
    expect(result.identities).toBe(1);
    // Majority tie → the first-seen domain (2) wins; both rows end on ONE value.
    const cats = new Set(customerItemRows.map((r) => r.categoryId));
    expect(cats.size).toBe(1);
  });

  it("does NOT touch an identity whose items already agree", async () => {
    const desc = "SAME ITEM SAME CATEGORY";
    customerItemRows = [
      { id: 1, customerRfqId: 10, partNo: "X1", description: desc, categoryId: 3 },
      { id: 2, customerRfqId: 11, partNo: "X1", description: desc, categoryId: 3 },
    ];
    const result = await repairClassificationConsistency({ limit: 100 });
    expect(result.identities).toBe(0);
    expect(result.itemsFixed).toBe(0);
  });

  it("respects a manager's manual decision when unifying", async () => {
    const desc = "CABLE 3X2.5 MM COPPER";
    memoryRows = [{ identityKey: "pn:680632", categoryId: 2, source: "manual", confidence: 100 }];
    customerItemRows = [
      { id: 1, customerRfqId: 10, partNo: "680632", description: desc, categoryId: 3 },
      { id: 2, customerRfqId: 11, partNo: "680632", description: desc, categoryId: 3 },
      { id: 3, customerRfqId: 12, partNo: "680632", description: desc, categoryId: null },
    ];
    const result = await repairClassificationConsistency({ limit: 100 });
    // The manual memory (2 = قطع غيار) wins over the majority (3).
    expect(result.itemsFixed).toBe(3);
    expect(new Set(customerItemRows.map((r) => r.categoryId))).toEqual(new Set([2]));
  });

  it("reports the conflicts read-only, with category counts", async () => {
    const desc = "LED TUBE LAMP 120CM 18W 1750LM EL SEWEEDY";
    customerItemRows = [
      { id: 1, customerRfqId: 10, partNo: "5720.010", description: desc, categoryId: 8 },
      { id: 2, customerRfqId: 11, partNo: "5720.010", description: desc, categoryId: 3 },
      { id: 3, customerRfqId: 12, partNo: "5720.010", description: desc, categoryId: null },
    ];
    const conflicts = await listClassificationConflicts(100);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].itemCount).toBe(3);
    expect(conflicts[0].sampleDescription).toContain("LED TUBE LAMP");
  });
});

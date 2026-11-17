import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

// The history module is mocked so the ROUTE contract is asserted directly: the
// list/detail must carry the derived categories WITH their evidence flags. The
// derivation rule itself is unit-tested in supplier-item-category-history.test.ts.
const evidence = vi.hoisted(() => ({
  map: new Map<number, any[]>(),
  historyFilter: new Map<number, number[]>(),
}));

vi.mock("../../shared/supplier-item-category-history", () => ({
  loadSupplierItemCategoryEvidenceMap: vi.fn(async () => evidence.map),
  suppliersWithHistoryForCategories: vi.fn(async () => evidence.historyFilter),
  supplierItemCategoryEvidence: vi.fn(async (id: number) => evidence.map.get(id) ?? []),
  mergeItemCategoryEvidence: vi.fn(),
  evidenceRank: vi.fn(),
  hasAnyEvidence: vi.fn(),
}));

const supplierRow = {
  id: 42,
  supplierId: "SUP-42",
  name: "هاي فولت",
  contactPerson: null,
  email: null,
  phone: null,
  address: null,
  category: "كهرباء",
  isActive: true,
  invoiceHasVat: true,
  commercialRegister: null,
  taxRegistration: null,
  bankName: null,
  bankAccountHolder: null,
  bankAccountNumber: null,
  iban: null,
  swiftCode: null,
  bankBranch: null,
  reactivatedAt: null,
  registrationVerifiedAt: null,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
};

function chainable(rows: any): any {
  const api: any = {
    then: (r: any) => Promise.resolve(rows).then(r),
    from: () => api,
    where: () => api,
    leftJoin: () => api,
    innerJoin: () => api,
    orderBy: () => api,
    limit: () => api,
    returning: () => Promise.resolve(rows),
  };
  return api;
}

vi.mock("@workspace/db", () => {
  const tables: any = {
    suppliersTable: { _: "suppliers", id: "id", name: "name", isActive: "is_active" },
    supplierCategoriesTable: { _: "supplierCategories", id: "id", name: "name" },
    supplierCategoryLinksTable: { _: "supplierCategoryLinks" },
    sentLogTable: { _: "sentLog" },
    offersTable: { _: "offers" },
    offerItemsTable: { _: "offerItems" },
    purchaseOrderItemsTable: { _: "poItems" },
    poItemReceiptsTable: { _: "receipts" },
    purchaseOrdersTable: { _: "pos" },
    customerPoItemsTable: { _: "customerPoItems" },
    customerPosTable: { _: "customerPos" },
    rfqTable: { _: "rfq" },
    rfqItemsTable: { _: "rfqItems" },
    itemCategoriesTable: { _: "itemCategories", id: "id", name: "name" },
    supplierItemCategoryLinksTable: { _: "supplierItemCategoryLinks" },
  };
  return {
    db: {
      select: vi.fn(() => {
        const api: any = chainable([supplierRow]);
        api.from = (table: any) => {
          if (table?._ === "supplierCategoryLinks") return chainable([]);
          if (table?._ === "supplierCategories") return chainable([]);
          if (table?._ === "suppliers") return chainable([supplierRow]);
          return chainable([]);
        };
        return api;
      }),
      execute: vi.fn(async () => ({ rows: [] })),
      insert: vi.fn(() => chainable([])),
      update: vi.fn(() => chainable([supplierRow])),
      delete: vi.fn(() => chainable([])),
      transaction: vi.fn(async (fn: any) => fn({})),
    },
    ...tables,
  };
});

const testApp = express();
testApp.use(express.json());

beforeAll(async () => {
  const { default: router } = await import("../../modules/users/suppliers");
  testApp.use(router);
});

beforeEach(() => {
  evidence.map = new Map();
  evidence.historyFilter = new Map();
});

describe("suppliers list — derived item categories with evidence", () => {
  it("returns itemCategories carrying the quoted/ordered/manual flags", async () => {
    evidence.map = new Map([
      [
        42,
        [
          { categoryId: 405, name: "كابلات", quoted: true, ordered: true, manual: false },
          { categoryId: 27, name: "معدات فندقيه", quoted: false, ordered: false, manual: true },
        ],
      ],
    ]);
    const res = await request(testApp).get("/suppliers");
    expect(res.status).toBe(200);
    const row = res.body[0];
    expect(row.itemCategories).toEqual([
      { id: 405, name: "كابلات", quoted: true, ordered: true, manual: false },
      { id: 27, name: "معدات فندقيه", quoted: false, ordered: false, manual: true },
    ]);
  });

  it("returns an empty itemCategories list when the supplier has no evidence", async () => {
    const res = await request(testApp).get("/suppliers");
    expect(res.status).toBe(200);
    expect(res.body[0].itemCategories).toEqual([]);
  });

  it("filters by item category through the HISTORY union, not only manual links", async () => {
    // No manual link, but history covers category 3 → the supplier must appear.
    evidence.historyFilter = new Map([[3, [42]]]);
    const res = await request(testApp).get("/suppliers?itemCategoryId=3");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(42);
  });
});

describe("suppliers list — trade categories stay distinct from item categories", () => {
  it("carries the TRADE categories in `category` and the ITEM categories in `itemCategories`", async () => {
    // The operator asked for these to be visibly different things: a supplier's
    // TRADE categories say what it deals in; its ITEM categories say what it can
    // supply at item level. Conflating them (one list) is the defect this guards.
    evidence.map = new Map([
      [42, [{ categoryId: 405, name: "كابلات", quoted: true, ordered: false, manual: false }]],
    ]);
    const res = await request(testApp).get("/suppliers");
    expect(res.status).toBe(200);
    const row = res.body[0];

    // Trade categories come from the stored supplier row (`category`).
    expect(row.category).toBe("كهرباء");
    // Item categories come from the derived evidence, with their own names.
    expect(row.itemCategories.map((c: any) => c.name)).toEqual(["كابلات"]);
    // They are two fields, and the trade name is NOT silently injected into the
    // item list.
    expect(row.itemCategories.map((c: any) => c.name)).not.toContain("كهرباء");
  });
});

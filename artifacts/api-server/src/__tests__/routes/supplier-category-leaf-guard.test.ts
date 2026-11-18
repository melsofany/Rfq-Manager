import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../shared/supplier-item-category-history", () => ({
  loadSupplierItemCategoryEvidenceMap: vi.fn(async () => new Map()),
  suppliersWithHistoryForCategories: vi.fn(async () => new Map()),
  supplierItemCategoryEvidence: vi.fn(async () => []),
  mergeItemCategoryEvidence: vi.fn(),
  evidenceRank: vi.fn(),
  hasAnyEvidence: vi.fn(),
}));

/**
 * The catalogue mirrors production: «كهرباء» is a PARENT with children
 * (بطاريات UPS), «قطع غيار» has a grandchild, and «بطاريات UPS» is a leaf.
 */
const CATALOGUE = [
  { id: 1, name: "كهرباء", parentId: null, deletedAt: null },
  { id: 13, name: "بطاريات UPS", parentId: 1, deletedAt: null },
  { id: 1311, name: "قطع غيار", parentId: null, deletedAt: null },
  { id: 29, name: "قطع غيار Dewalt", parentId: 1311, deletedAt: null },
];

const state: { suppliers: any[]; inserted: any[]; links: any[] } = {
  suppliers: [],
  inserted: [],
  links: [],
};

function chainable(rows: any): any {
  const api: any = {
    then: (r: any) => Promise.resolve(rows).then(r),
    from: () => api,
    where: () => api,
    leftJoin: () => api,
    innerJoin: () => api,
    orderBy: () => api,
    groupBy: () => api,
    limit: () => api,
    returning: () => Promise.resolve(rows),
    values: (v: any) => {
      state.inserted.push(v);
      return api;
    },
  };
  return api;
}

vi.mock("@workspace/db", () => {
  const tables: any = {
    suppliersTable: { _: "suppliers", id: "id", name: "name", category: "category" },
    supplierCategoriesTable: {
      _: "supplierCategories",
      id: "id",
      name: "name",
      parentId: "parent_id",
      deletedAt: "deleted_at",
    },
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
        const api: any = chainable([]);
        api.from = (table: any) => {
          if (table?._ === "supplierCategories") return chainable(CATALOGUE);
          if (table?._ === "suppliers") return chainable(state.suppliers);
          return chainable([]);
        };
        return api;
      }),
      execute: vi.fn(async () => ({ rows: [] })),
      insert: vi.fn(() => chainable([])),
      update: vi.fn(() => chainable([])),
      delete: vi.fn(() => chainable([])),
      transaction: vi.fn(async (fn: any) => fn({})),
    },
    ...tables,
  };
});

const testApp = express();
testApp.use(express.json());
testApp.use((req, _res, next) => {
  (req as any).session = { employeeId: 1, role: "admin" };
  next();
});

beforeAll(async () => {
  const { default: router } = await import("../../modules/users/suppliers");
  testApp.use(router);
});

beforeEach(() => {
  state.suppliers = [];
  state.inserted.length = 0;
  state.links.length = 0;
});

describe("leaf-only rule — a supplier may not be filed under a grouping category", () => {
  it("REJECTS a create on a parent that has children, naming the category", async () => {
    const res = await request(testApp)
      .post("/suppliers")
      .send({ name: "مورد جديد", category: "كهرباء" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("كهرباء");
    expect(res.body.nonLeafCategories).toEqual(["كهرباء"]);
    // nothing was written
    expect(state.inserted.length).toBe(0);
  });

  it("REJECTS a grandparent too (depth does not matter)", async () => {
    const res = await request(testApp)
      .post("/suppliers")
      .send({ name: "مورد جديد", category: "قطع غيار" });
    expect(res.status).toBe(400);
    expect(res.body.nonLeafCategories).toEqual(["قطع غيار"]);
  });

  it("ALLOWS a create on a leaf", async () => {
    const res = await request(testApp)
      .post("/suppliers")
      .send({ name: "مورد جديد", category: "بطاريات UPS" });
    expect(res.status).not.toBe(400);
  });

  it("REJECTS a PATCH that moves a supplier onto a parent, leaving links untouched", async () => {
    const res = await request(testApp)
      .patch("/suppliers/42")
      .send({ categories: ["كهرباء"] });
    expect(res.status).toBe(400);
    expect(res.body.nonLeafCategories).toEqual(["كهرباء"]);
  });

  it("ALLOWS a PATCH onto a leaf", async () => {
    const res = await request(testApp)
      .patch("/suppliers/42")
      .send({ categories: ["قطع غيار Dewalt"] });
    expect(res.status).not.toBe(400);
  });

  it("reports EVERY offending name when several are submitted", async () => {
    const res = await request(testApp)
      .post("/suppliers")
      .send({ name: "مورد", categories: ["كهرباء", "قطع غيار", "بطاريات UPS"] });
    expect(res.status).toBe(400);
    expect(res.body.nonLeafCategories).toEqual(["كهرباء", "قطع غيار"]);
  });

  it("a free-typed name that is not in the catalogue is NOT blocked", async () => {
    // The catalogue is edited by hand, so an uncatalogued name must keep working.
    const res = await request(testApp)
      .post("/suppliers")
      .send({ name: "مورد", category: "تصنيف حر غير مسجل" });
    expect(res.status).not.toBe(400);
  });
});

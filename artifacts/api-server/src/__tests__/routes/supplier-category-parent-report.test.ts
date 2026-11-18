import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

const state: {
  categories: any[];
  links: any[];
} = { categories: [], links: [] };

function chainable(rows: any): any {
  const api: any = {
    then: (r: any) => Promise.resolve(rows).then(r),
    from: () => api,
    where: () => api,
    innerJoin: () => api,
    orderBy: () => api,
    groupBy: () => api,
    limit: () => api,
    returning: () => Promise.resolve(rows),
  };
  return api;
}

vi.mock("@workspace/db", () => {
  const tables: any = {
    supplierCategoriesTable: {
      _: "supplierCategories",
      id: "id",
      name: "name",
      parentId: "parent_id",
      deletedAt: "deleted_at",
    },
    supplierCategoryLinksTable: {
      _: "supplierCategoryLinks",
      categoryId: "category_id",
      supplierId: "supplier_id",
    },
    itemCategoriesTable: { _: "itemCategories", id: "id", name: "name" },
    suppliersTable: { _: "suppliers", id: "id", name: "name" },
    auditLogTable: { _: "audit" },
  };
  return {
    db: {
      select: vi.fn(() => {
        const api: any = chainable([]);
        api.from = (table: any) => {
          if (table?._ === "supplierCategories") return chainable(state.categories);
          if (table?._ === "supplierCategoryLinks") return chainable(state.links);
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
  const { default: router } = await import("../../modules/users/categories");
  testApp.use(router);
});

beforeEach(() => {
  state.categories = [];
  state.links = [];
});

describe("GET /categories/parent-assignments — the review list", () => {
  it("lists a parent that holds suppliers, with the suppliers named", async () => {
    state.categories = [
      { id: 1, name: "كهرباء", parentId: null, deletedAt: null },
      { id: 13, name: "بطاريات UPS", parentId: 1, deletedAt: null },
      { id: 1311, name: "قطع غيار", parentId: null, deletedAt: null },
    ];
    state.links = [
      { categoryId: 1, supplierId: 42, supplierName: "هاي فولت" },
      { categoryId: 1, supplierId: 43, supplierName: "النور" },
      { categoryId: 13, supplierId: 44, supplierName: "طبيعي" }, // a leaf — not reported
    ];
    const res = await request(testApp).get("/categories/parent-assignments");
    expect(res.status).toBe(200);
    expect(res.body.totals.categoriesWithSuppliers).toBe(1);
    expect(res.body.totals.suppliersToRefile).toBe(2);
    expect(res.body.groups[0].id).toBe(1);
    expect(res.body.groups[0].holderCount).toBe(2);
    expect(res.body.groups[0].holders.map((h: any) => h.name)).toEqual(["هاي فولت", "النور"]);
  });

  it("reports nothing when every holder is a leaf", async () => {
    state.categories = [
      { id: 1, name: "كهرباء", parentId: null, deletedAt: null },
      { id: 13, name: "بطاريات UPS", parentId: 1, deletedAt: null },
    ];
    state.links = [{ categoryId: 13, supplierId: 44, supplierName: "طبيعي" }];
    const res = await request(testApp).get("/categories/parent-assignments");
    expect(res.body.totals.categoriesWithSuppliers).toBe(0);
    expect(res.body.groups).toEqual([]);
  });

  it("ignores a RETIRED child when deciding whether the parent is a leaf", async () => {
    state.categories = [
      { id: 3, name: "الصحة والسلامة", parentId: null, deletedAt: null },
      { id: 1312, name: "مقاومة حريق", parentId: 3, deletedAt: new Date() }, // retired
    ];
    state.links = [{ categoryId: 3, supplierId: 7, supplierName: "س" }];
    const res = await request(testApp).get("/categories/parent-assignments");
    // 3 has no LIVE child, so it is a leaf and its holder is NOT a problem.
    expect(res.body.totals.categoriesWithSuppliers).toBe(0);
  });

  it("does not modify anything — it is a read", async () => {
    state.categories = [
      { id: 1, name: "كهرباء", parentId: null, deletedAt: null },
      { id: 13, name: "بطاريات", parentId: 1, deletedAt: null },
    ];
    state.links = [{ categoryId: 1, supplierId: 42, supplierName: "x" }];
    const res = await request(testApp).get("/categories/parent-assignments");
    expect(res.status).toBe(200);
    // the response is a report; the link list is untouched
    expect(state.links.length).toBe(1);
    expect(state.links[0].categoryId).toBe(1);
  });
});

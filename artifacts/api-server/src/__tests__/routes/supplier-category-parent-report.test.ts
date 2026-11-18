import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  and: (...args: any[]) => ({ __op: "and", args }),
  count: () => ({ __op: "count" }),
  sql: Object.assign(() => ({ __op: "sql" }), { raw: () => ({}) }),
}));

const sessionState: { employeeId: number; role: string } = { employeeId: 1, role: "admin" };

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole:
    (...roles: string[]) =>
    (req: any, res: any, next: any) => {
      if (!roles.includes(req.session?.role ?? "")) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    },
}));

const state: {
  categories: any[];
  links: any[];
  deleted: Array<{ supplierId: number; categoryId: number }>;
  supplierUpdates: any[];
  audits: any[];
} = { categories: [], links: [], deleted: [], supplierUpdates: [], audits: [] };

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
      transaction: vi.fn(async (fn: any) => {
        const tx = {
          delete: (_t: any) => ({
            where: (cond: any) => {
              const c = cond?.__op === "and" ? cond.args : [cond];
              const sid = c.find((x: any) => x?.left === "supplier_id")?.right;
              const cid = c.find((x: any) => x?.left === "category_id")?.right;
              state.deleted.push({ supplierId: sid, categoryId: cid });
              return Promise.resolve();
            },
          }),
          update: (_t: any) => ({
            set: (vals: any) => {
              state.supplierUpdates.push(vals);
              return { where: () => Promise.resolve() };
            },
          }),
          insert: (_t: any) => ({
            values: (v: any) => {
              state.audits.push(v);
              return Promise.resolve();
            },
          }),
        };
        return fn(tx);
      }),
    },
    ...tables,
  };
});

const testApp = express();
testApp.use(express.json());
testApp.use((req, _res, next) => {
  (req as any).session = sessionState;
  next();
});

beforeAll(async () => {
  const { default: router } = await import("../../modules/users/categories");
  testApp.use(router);
});

beforeEach(() => {
  state.categories = [];
  state.links = [];
  state.deleted.length = 0;
  state.supplierUpdates.length = 0;
  state.audits.length = 0;
  sessionState.role = "admin";
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

describe("POST /categories/parent-assignments/cleanup — only the provable case", () => {
  it("removes a parent link when the supplier is ALSO on a child, and syncs the mirror", async () => {
    state.categories = [
      { id: 1, name: "كهرباء", parentId: null, deletedAt: null },
      { id: 13, name: "بطاريات UPS", parentId: 1, deletedAt: null },
    ];
    state.links = [
      { supplierId: 42, categoryId: 1 },
      { supplierId: 42, categoryId: 13 },
    ];
    const res = await request(testApp).post("/categories/parent-assignments/cleanup");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, removed: 1, remaining: 1 });
    expect(state.deleted).toEqual([{ supplierId: 42, categoryId: 1 }]);
    // the free-text mirror must drop the parent name too, or the list lies
    expect(state.supplierUpdates).toEqual([{ category: "بطاريات UPS" }]);
    expect(
      state.audits.some((a: any) => a.action === "supplier_category.parent_links_cleaned"),
    ).toBe(true);
  });

  it("does NOT touch a supplier who is on the parent ALONE", async () => {
    state.categories = [
      { id: 1, name: "كهرباء", parentId: null, deletedAt: null },
      { id: 13, name: "بطاريات UPS", parentId: 1, deletedAt: null },
    ];
    state.links = [{ supplierId: 43, categoryId: 1 }];
    const res = await request(testApp).post("/categories/parent-assignments/cleanup");
    expect(res.body.removed).toBe(0);
    expect(state.deleted).toEqual([]);
    expect(state.supplierUpdates).toEqual([]);
  });

  it("403s for a non-manager role", async () => {
    sessionState.role = "data_entry";
    const res = await request(testApp).post("/categories/parent-assignments/cleanup");
    expect(res.status).toBe(403);
  });
});

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  and: (...args: any[]) => ({ __op: "and", args }),
  count: () => ({ __op: "count" }),
  inArray: (left: any, right: any) => ({ __op: "inArray", left, right }),
  isNotNull: (col: any) => ({ __op: "isNotNull", col }),
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
  nextId: number;
} = { categories: [], links: [], deleted: [], supplierUpdates: [], audits: [], nextId: 1000 };

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
      isActive: "is_active",
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

  // The route does REAL work now (it moves suppliers between categories), so the
  // mock is a tiny in-memory store rather than a row-returner: a mock that
  // ignores `.where()` cannot tell a scoped query from an unscoped one.
  const matches = (row: any, cond: any): boolean => {
    if (!cond) return true;
    if (cond.__op === "and") return cond.args.every((c: any) => matches(row, c));
    if (cond.__op === "inArray") {
      const key =
        cond.left === "category_id" ? "categoryId" : cond.left === "id" ? "id" : cond.left;
      return cond.right.includes(row[key]);
    }
    if (cond.__op === "eq") {
      const col = cond.left?.__col ?? cond.left;
      const key = col === "parent_id" ? "parentId" : col === "is_active" ? "isActive" : col;
      // A row that does not carry the flag is ACTIVE (the column defaults true).
      const actual = key === "isActive" ? (row.isActive ?? true) : row[key];
      return actual === cond.right;
    }
    return true;
  };

  const selectFrom = (table: any) => {
    const store =
      table?._ === "supplierCategories"
        ? state.categories
        : table?._ === "supplierCategoryLinks"
          ? state.links
          : [];
    const api: any = {};
    const run = () => store.slice();
    api.where = (cond: any) => {
      api.__rows = store.filter((r: any) => matches(r, cond));
      return api;
    };
    api.innerJoin = () => api;
    api.orderBy = () => api;
    api.groupBy = () => api;
    api.limit = () => api;
    api.then = (r: any) => Promise.resolve(api.__rows ?? run()).then(r);
    return api;
  };

  return {
    db: {
      select: vi.fn(() => ({ from: (t: any) => selectFrom(t) })),
      execute: vi.fn(async () => ({ rows: [] })),
      insert: vi.fn((t: any) => ({
        values: (v: any) => ({
          returning: () => {
            const rows = Array.isArray(v) ? v : [v];
            const out = rows.map((row: any) => {
              const id = state.nextId++;
              state.categories.push({ id, deletedAt: null, ...row });
              return { id, ...row };
            });
            return Promise.resolve(out);
          },
          // A plain awaited insert (the audit write) records its row, the same
          // as the transaction mock does for non-link tables.
          then: (resolve: any) => {
            if (t?._ !== "supplierCategoryLinks") state.audits.push(v);
            return Promise.resolve().then(() => resolve(undefined));
          },
          onConflictDoNothing: () => {
            const rows = Array.isArray(v) ? v : [v];
            const inserted: any[] = [];
            for (const row of rows) {
              const clash = state.categories.some(
                (c: any) => c.name === row.name && (c.parentId ?? null) === (row.parentId ?? null),
              );
              if (!clash) {
                const id = state.nextId++;
                state.categories.push({ id, deletedAt: null, ...row });
                inserted.push({ id, ...row });
              }
            }
            return { returning: () => Promise.resolve(inserted) };
          },
        }),
      })),
      update: vi.fn((t: any) => ({
        set: (vals: any) => ({
          where: (cond: any) => {
            const inArr =
              cond?.__op === "inArray"
                ? cond
                : cond?.__op === "and"
                  ? cond.args.find((a: any) => a?.__op === "inArray")
                  : null;
            if (t?._ === "suppliers") {
              state.supplierUpdates.push(vals);
            } else if (cond?.left === "id") {
              for (const c of state.categories) if (c.id === cond.right) Object.assign(c, vals);
            } else if (inArr) {
              for (const c of state.categories)
                if (inArr.right.includes(c.id)) Object.assign(c, vals);
            }
            return Promise.resolve();
          },
        }),
      })),
      delete: vi.fn((t: any) => ({
        where: (cond: any) => {
          if (t?._ === "supplierCategoryLinks") {
            const c = cond?.__op === "and" ? cond.args : [cond];
            const sid = c.find((x: any) => x?.left === "supplier_id")?.right;
            const cid = c.find((x: any) => x?.left === "category_id")?.right;
            state.deleted.push({ supplierId: sid, categoryId: cid });
            state.links = state.links.filter(
              (l: any) => !(l.supplierId === sid && l.categoryId === cid),
            );
          }
          return Promise.resolve();
        },
      })),
      transaction: vi.fn(async (fn: any) =>
        fn({
          delete: (t: any) => ({
            where: (cond: any) => {
              const c = cond?.__op === "and" ? cond.args : [cond];
              const sid = c.find((x: any) => x?.left === "supplier_id")?.right;
              const cid = c.find((x: any) => x?.left === "category_id")?.right;
              state.deleted.push({ supplierId: sid, categoryId: cid });
              state.links = state.links.filter(
                (l: any) => !(l.supplierId === sid && l.categoryId === cid),
              );
              return Promise.resolve();
            },
          }),
          update: (t: any) => ({
            set: (vals: any) => ({
              where: () => {
                if (t?._ === "suppliers") state.supplierUpdates.push(vals);
                return Promise.resolve();
              },
            }),
          }),
          insert: (t: any) => ({
            values: (v: any) => {
              const apply = () => {
                if (t?._ === "supplierCategoryLinks") {
                  const rows = Array.isArray(v) ? v : [v];
                  for (const row of rows) {
                    const dup = state.links.some(
                      (l: any) =>
                        l.supplierId === row.supplierId && l.categoryId === row.categoryId,
                    );
                    if (!dup) state.links.push(row);
                  }
                  return;
                }
                state.audits.push(v);
              };
              const api: any = {
                onConflictDoNothing: () => {
                  apply();
                  return api;
                },
                then: (r: any) =>
                  Promise.resolve()
                    .then(() => {
                      apply();
                      return undefined;
                    })
                    .then(r),
              };
              return api;
            },
          }),
        }),
      ),
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
  state.nextId = 1000;
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

  it("MOVES a supplier who is on the parent ALONE into «يحتاج للمراجعة»", async () => {
    state.categories = [
      { id: 1, name: "كهرباء", parentId: null, deletedAt: null },
      { id: 13, name: "بطاريات UPS", parentId: 1, deletedAt: null },
    ];
    state.links = [{ supplierId: 43, categoryId: 1 }];
    const res = await request(testApp).post("/categories/parent-assignments/cleanup");
    expect(res.status).toBe(200);
    // nothing redundant, but the orphan IS moved
    expect(res.body.removed).toBe(0);
    expect(res.body.moved).toBe(1);
    // the placeholder leaf is created under the SAME parent
    const placeholder = state.categories.find((c: any) => c.name === "يحتاج للمراجعة");
    expect(placeholder).toBeTruthy();
    expect(placeholder.parentId).toBe(1);
    // the supplier now sits on the placeholder, not on the parent
    expect(state.links).toEqual([{ supplierId: 43, categoryId: placeholder.id }]);
    // and the free-text mirror names the placeholder
    expect(state.supplierUpdates).toEqual([{ category: "يحتاج للمراجعة" }]);
  });

  it("removes an EMPTY placeholder but keeps one that still holds suppliers", async () => {
    state.categories = [
      { id: 1, name: "كهرباء", parentId: null, deletedAt: null },
      { id: 13, name: "بطاريات UPS", parentId: 1, deletedAt: null },
      { id: 90, name: "يحتاج للمراجعة", parentId: 1, deletedAt: null },
    ];
    // 90 holds nobody ⇒ it is a leftover working state
    state.links = [{ supplierId: 44, categoryId: 13 }];
    const res = await request(testApp).post("/categories/parent-assignments/cleanup");
    expect(res.body.pruned).toBe(1);
    const gone = state.categories.find((c: any) => c.id === 90);
    expect(gone.deletedAt).toBeTruthy();
  });

  it("403s for a non-manager role", async () => {
    sessionState.role = "data_entry";
    const res = await request(testApp).post("/categories/parent-assignments/cleanup");
    expect(res.status).toBe(403);
  });
});

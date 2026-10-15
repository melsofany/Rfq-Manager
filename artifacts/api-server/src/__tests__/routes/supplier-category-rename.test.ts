import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth: allow everything, role comes from the session ────────────────
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

// drizzle-orm: `sql` must be callable (tagged template) AND expose the helpers
// the module imports; `eq`/`asc` record their operands so the mock can branch.
vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  asc: (col: any) => ({ __op: "asc", col }),
  count: () => ({ __op: "count" }),
  or: (...args: any[]) => ({ __op: "or", args }),
  ilike: (left: any, right: any) => ({ __op: "ilike", left, right }),
  sql: Object.assign((strings: any, ...values: any[]) => ({ __op: "sql", strings, values }), {
    raw: (s: string) => ({ __op: "sql.raw", s }),
  }),
}));

function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

const supplierCategoriesTable = { _: "supplierCategories", id: "id", name: "name" };
const suppliersTable = { _: "suppliers", category: "category" };
const itemCategoriesTable = { _: "itemCategories", id: "id", name: "name" };
// The link table the delete guard counts from.
const supplierCategoryLinksTable = {
  _: "links",
  supplierId: "supplier_id",
  categoryId: "category_id",
};

let categoryRows: any[];
let updatedCategoryRow: any;
const itemCategoryUpdates: any[] = [];
const itemCategoryWhere: any[] = [];
const executeCalls: any[] = [];

const dbMock: any = {
  select: vi.fn(() => ({
    from: vi.fn((table: any) => {
      if (table === supplierCategoriesTable) {
        return chainable(categoryRows, {
          where: vi.fn((cond: any) => chainable(categoryRows)),
          orderBy: vi.fn(() => chainable(categoryRows)),
        });
      }
      if (table === suppliersTable) {
        // The delete guard: count() of suppliers in the category.
        return chainable([{ supplierCount: 0 }], {
          where: vi.fn(() => chainable([{ supplierCount: 0 }])),
        });
      }
      if (table === supplierCategoryLinksTable) {
        // The delete guard now counts from the LINK table.
        return chainable([{ supplierCount: 0 }], {
          where: vi.fn(() => chainable([{ supplierCount: 0 }])),
        });
      }
      return chainable([], { where: vi.fn(() => chainable([])) });
    }),
  })),
  insert: vi.fn(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(() => chainable([{ id: 1, name: "x" }])),
      onConflictDoNothing: vi.fn(() => chainable(undefined)),
    })),
  })),
  update: vi.fn((table: any) => ({
    set: vi.fn((vals: any) => {
      if (table === itemCategoriesTable) itemCategoryUpdates.push(vals);
      return {
        where: vi.fn((cond: any) => {
          if (table === itemCategoriesTable) itemCategoryWhere.push(cond);
          return { returning: vi.fn(() => chainable([updatedCategoryRow])) };
        }),
      };
    }),
  })),
  delete: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })),
  execute: vi.fn(async (q: any) => {
    executeCalls.push(q);
    return { rows: [] };
  }),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  supplierCategoriesTable,
  suppliersTable,
  itemCategoriesTable,
  supplierCategoryLinksTable,
}));

let testApp: express.Express;
const sessionState: { employeeId: number; role?: string } = { employeeId: 1, role: "admin" };

beforeAll(async () => {
  const { default: router } = await import("../../modules/users/categories");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req, _res, next) => {
    (req as any).session = sessionState;
    next();
  });
  testApp.use(router);
});

beforeEach(() => {
  vi.clearAllMocks();
  itemCategoryUpdates.length = 0;
  itemCategoryWhere.length = 0;
  executeCalls.length = 0;
  categoryRows = [{ id: 1, name: "elec" }];
  updatedCategoryRow = { id: 1, name: "كهرباء" };
});

describe("supplier-category rename propagates to suppliers.category", () => {
  it("rewrites the free-text suppliers.category on a rename", async () => {
    // `suppliers.category` stores NAMES as free text, so a rename must rewrite
    // it — otherwise the supplier list (which filters on the NAME) finds no
    // supplier under the new name while every supplier still shows the old one.
    const res = await request(testApp).patch("/categories/1").send({ name: "كهرباء" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 1, name: "كهرباء" });

    // The rename helper must have run a raw UPDATE against `suppliers`.
    const supplierRewrite = executeCalls.find((q) =>
      JSON.stringify(q).includes("UPDATE suppliers"),
    );
    expect(supplierRewrite, "suppliers.category rewrite must run").toBeDefined();
  });

  it("also mirrors the rename into item_categories (same list)", async () => {
    await request(testApp).patch("/categories/1").send({ name: "كهرباء" });
    expect(itemCategoryUpdates).toContainEqual({ name: "كهرباء" });
  });
});

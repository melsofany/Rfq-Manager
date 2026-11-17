import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Auth: allow everything; role comes from the session ─────────────────────
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

vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  ne: (left: any, right: any) => ({ __op: "ne", left, right }),
  asc: (col: any) => ({ __op: "asc", col }),
  desc: (col: any) => ({ __op: "desc", col }),
  count: () => ({ __op: "count" }),
  or: (...args: any[]) => ({ __op: "or", args }),
  and: (...args: any[]) => ({ __op: "and", args }),
  inArray: (col: any, vals: any) => ({ __op: "inArray", col, vals }),
  ilike: (left: any, right: any) => ({ __op: "ilike", left, right }),
  isNull: (col: any) => ({ __op: "isNull", col }),
  sql: Object.assign((strings: any, ...values: any[]) => ({ __op: "sql", strings, values }), {
    raw: (s: string) => ({ __op: "sql.raw", s }),
  }),
}));

function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

const supplierCategoriesTable = {
  _: "supplierCategories",
  id: "id",
  name: "name",
  isActive: "is_active",
  parentId: "parent_id",
};
const supplierCategoryLinksTable = {
  _: "links",
  supplierId: "supplier_id",
  categoryId: "category_id",
};
const itemCategoriesTable = { _: "itemCategories", id: "id", name: "name", code: "code" };
const suppliersTable = { _: "suppliers", category: "category" };
const auditLogTable = { _: "audit" };

// Per-test state
let categoryRows: any[] = [];
const categoryUpdates: any[] = [];
const auditInserts: any[] = [];
const insertReturning: any[] = [];
const executeCalls: any[] = [];

const dbMock: any = {
  select: vi.fn(() => ({
    from: vi.fn((table: any) => {
      if (table === supplierCategoriesTable) {
        return chainable(categoryRows, {
          where: vi.fn((_cond: any) => chainable(categoryRows)),
          orderBy: vi.fn(() => chainable(categoryRows)),
        });
      }
      if (table === supplierCategoryLinksTable) {
        return chainable([{ categoryId: 1, n: 3 }], {
          groupBy: vi.fn(() => chainable([{ categoryId: 1, n: 3 }])),
        });
      }
      if (table === itemCategoriesTable) {
        return chainable([], { where: vi.fn(() => chainable([], { limit: vi.fn(() => []) })) });
      }
      return chainable([], { where: vi.fn(() => chainable([])) });
    }),
  })),
  insert: vi.fn((table: any) => ({
    values: vi.fn((vals: any) => {
      if (table === auditLogTable) auditInserts.push(vals);
      return {
        returning: vi.fn(() => chainable(insertReturning)),
        onConflictDoNothing: vi.fn(() => chainable(undefined)),
      };
    }),
  })),
  update: vi.fn((table: any) => ({
    set: vi.fn((vals: any) => {
      if (table === supplierCategoriesTable) categoryUpdates.push(vals);
      return { where: vi.fn(() => ({ returning: vi.fn(() => chainable(insertReturning)) })) };
    }),
  })),
  delete: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })),
  transaction: vi.fn(async (fn: any) => fn(dbMock)),
  execute: vi.fn(async (q: any) => {
    executeCalls.push(q);
    // The merge's row lookups read `.rows[0]`; the inserts/updates read counts.
    const s = JSON.stringify(q);
    if (s.includes("SELECT id, name FROM supplier_categories WHERE id")) {
      return { rows: [{ id: 1, name: "elec" }] };
    }
    if (s.includes("count(*)")) return { rows: [{ n: 2 }] };
    return { rows: [], rowCount: 1 };
  }),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  supplierCategoriesTable,
  supplierCategoryLinksTable,
  itemCategoriesTable,
  suppliersTable,
  auditLogTable,
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
  categoryUpdates.length = 0;
  auditInserts.length = 0;
  executeCalls.length = 0;
  categoryRows = [{ id: 1, name: "كهرباء", parentId: null, isActive: true, sortOrder: 0 }];
  insertReturning.length = 0;
  insertReturning.push({ id: 9, name: "جديد", parentId: null, isActive: true, sortOrder: 0 });
  sessionState.role = "admin";
});

describe("soft delete — hide, never remove", () => {
  it("marks the category inactive and stamps deleted_at instead of deleting the row", async () => {
    const res = await request(testApp).delete("/categories/1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: 1, restored: false });
    // The UPDATE set is_active=false + deleted_at — the row is never removed.
    expect(categoryUpdates).toContainEqual(
      expect.objectContaining({ isActive: false, deletedAt: expect.any(Date) }),
    );
    // A DELETE statement must NOT have been issued against supplier_categories.
    const deleteCalled = dbMock.delete.mock.calls.length;
    expect(deleteCalled).toBe(0);
    // Audited.
    expect(auditInserts.some((v) => v.action === "supplier_category.soft_deleted")).toBe(true);
  });

  it("restores a soft-deleted category (the relations were never touched)", async () => {
    categoryRows = [{ id: 1, name: "كهرباء", parentId: null, isActive: false, sortOrder: 0 }];
    const res = await request(testApp).post("/categories/1/restore");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: 1, restored: true });
    expect(categoryUpdates).toContainEqual({ isActive: true, deletedAt: null });
    expect(auditInserts.some((v) => v.action === "supplier_category.restored")).toBe(true);
  });

  it("404s a delete for a missing category", async () => {
    categoryRows = [];
    const res = await request(testApp).delete("/categories/1");
    expect(res.status).toBe(404);
  });
});

describe("create — normalised name + duplicate-key refusal", () => {
  it("creates with the collapsed name and audits it", async () => {
    categoryRows = [];
    insertReturning[0] = {
      id: 9,
      name: "معدات فندقيه",
      parentId: null,
      isActive: true,
      sortOrder: 0,
    };
    const res = await request(testApp).post("/categories").send({ name: "  معدات   فندقيه " });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("معدات فندقيه");
  });

  it("refuses a duplicate that differs only by whitespace", async () => {
    // «معدات  فندقيه» already exists; «معدات فندقيه» must be refused.
    categoryRows = [{ id: 5, name: "معدات  فندقيه", parentId: null, isActive: true }];
    const res = await request(testApp).post("/categories").send({ name: "معدات فندقيه" });
    expect(res.status).toBe(409);
    expect(res.body.existingId).toBe(5);
  });

  it("403s a create for a non-manager role", async () => {
    sessionState.role = "purchasing";
    const res = await request(testApp).post("/categories").send({ name: "x" });
    expect(res.status).toBe(403);
  });
});

describe("re-parent — cycle guard", () => {
  it("refuses making a category a child of its own descendant", async () => {
    categoryRows = [
      { id: 1, name: "كهرباء", parentId: null, isActive: true },
      { id: 2, name: "Automation", parentId: 1, isActive: true },
      { id: 3, name: "Encoders", parentId: 2, isActive: true },
    ];
    const res = await request(testApp).patch("/categories/1").send({ parentId: 3 });
    expect(res.status).toBe(400);
  });
});

describe("merge — explicit, audited, never automatic", () => {
  it("moves the links and soft-deletes the source, audited with before/after", async () => {
    categoryRows = [
      { id: 1, name: "elec", parentId: null, isActive: true },
      { id: 2, name: "كهرباء", parentId: null, isActive: true },
    ];
    const res = await request(testApp).post("/categories/merge").send({ sourceId: 1, targetId: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sourceId: 1, targetId: 2 });
    // The merge ran through a transaction that moved the links and soft-deleted.
    const merged = executeCalls.map((q) => JSON.stringify(q)).join("|");
    expect(merged).toContain("supplier_category_links");
    expect(merged).toContain("is_active = false");
    expect(auditInserts.some((v) => v.action === "supplier_category.merged")).toBe(true);
  });

  it("refuses merging a category with itself", async () => {
    const res = await request(testApp).post("/categories/merge").send({ sourceId: 1, targetId: 1 });
    expect(res.status).toBe(400);
  });

  it("403s a merge for a non-manager role", async () => {
    sessionState.role = "data_entry";
    const res = await request(testApp).post("/categories/merge").send({ sourceId: 1, targetId: 2 });
    expect(res.status).toBe(403);
  });
});

describe("report — read-only cleanup view", () => {
  it("lists unused categories and duplicate groups without changing anything", async () => {
    categoryRows = [
      { id: 1, name: "معدات  فندقيه", parentId: null, isActive: true },
      { id: 2, name: "معدات فندقيه", parentId: null, isActive: true },
      { id: 3, name: "أجهزة", parentId: null, isActive: true },
    ];
    const res = await request(testApp).get("/categories/report");
    expect(res.status).toBe(200);
    expect(res.body.totals.duplicateGroups).toBe(1);
    expect(res.body.duplicates[0].categories.map((c: any) => c.id).sort()).toEqual([1, 2]);
    // Nothing was written.
    expect(categoryUpdates.length).toBe(0);
    expect(dbMock.delete.mock.calls.length).toBe(0);
  });
});

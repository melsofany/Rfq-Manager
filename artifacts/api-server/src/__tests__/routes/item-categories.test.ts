import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth ───────────────────────────────────────────────────────────────
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
  and: (...args: any[]) => ({ __op: "and", args }),
  asc: (col: any) => ({ __op: "asc", col }),
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

const itemCategoriesTable = { _: "itemCategories", id: "id", name: "name", isActive: "isActive" };
const employeeCategoriesTable = {
  _: "employeeCategories",
  categoryId: "categoryId",
  employeeId: "employeeId",
  isPrimary: "isPrimary",
};
const employeesTable = { _: "employees", id: "id", name: "name" };
const auditTable = { _: "audit" };
const itemCategoryKeywordsTable = {
  _: "itemCategoryKeywords",
  id: "id",
  categoryId: "categoryId",
  keyword: "keyword",
  weight: "weight",
  language: "language",
  enabled: "enabled",
};

let existingCategoryRows: any[];
let listRows: any[];
let ownerRows: any[];
let createdRow: any;
let updatedRow: any | null;
let employeeCatRows: any[];
let keywordRows: any[];
let keywordCreatedRow: any;
let keywordUpdatedRow: any | null;

const auditInserts: any[] = [];
const ownerReplaces: any[] = [];
const employeeCatReplaces: any[] = [];
const keywordDeletes: any[] = [];

const dbMock: any = {
  select: vi.fn((_arg?: any) => ({
    from: vi.fn((table: any) => {
      if (table === itemCategoriesTable) {
        // duplicate-name probe (select({id}).where().limit(1)) OR list (orderBy)
        const isIdProbe = _arg && typeof _arg === "object" && "id" in _arg;
        const rows = isIdProbe ? existingCategoryRows : listRows;
        return chainable(rows, {
          where: vi.fn(() => chainable(rows, { limit: vi.fn(() => chainable(rows)) })),
          orderBy: vi.fn(() => chainable(rows)),
        });
      }
      if (table === employeeCategoriesTable) {
        return chainable(ownerRows, {
          innerJoin: vi.fn(() =>
            chainable(ownerRows, { where: vi.fn(() => chainable(ownerRows)) }),
          ),
          where: vi.fn(() => chainable(employeeCatRows)),
        });
      }
      if (table === itemCategoryKeywordsTable) {
        return chainable(keywordRows, {
          where: vi.fn(() =>
            chainable(keywordRows, { orderBy: vi.fn(() => chainable(keywordRows)) }),
          ),
        });
      }
      return chainable([], { where: vi.fn(() => chainable([])) });
    }),
  })),
  insert: vi.fn((table: any) => ({
    values: vi.fn((vals: any) => {
      if (table === itemCategoriesTable) {
        return { returning: vi.fn(() => chainable([{ ...createdRow, ...vals }])) };
      }
      if (table === itemCategoryKeywordsTable) {
        return { returning: vi.fn(() => chainable([{ ...keywordCreatedRow, ...vals }])) };
      }
      if (table === auditTable) {
        auditInserts.push(vals);
        return chainable(undefined);
      }
      if (table === employeeCategoriesTable) {
        return chainable(undefined);
      }
      return chainable(undefined);
    }),
  })),
  update: vi.fn((table: any) => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() =>
          chainable(
            table === itemCategoryKeywordsTable
              ? keywordUpdatedRow
                ? [keywordUpdatedRow]
                : []
              : updatedRow
                ? [updatedRow]
                : [],
          ),
        ),
      })),
    })),
  })),
  delete: vi.fn((table: any) => ({
    where: vi.fn((cond: any) => {
      if (table === employeeCategoriesTable) ownerReplaces.push(cond);
      if (table === itemCategoryKeywordsTable) keywordDeletes.push(cond);
      return chainable(undefined);
    }),
  })),
  transaction: vi.fn(async (fn: any) => fn(dbMock)),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  itemCategoriesTable,
  employeeCategoriesTable,
  employeesTable,
  auditLogTable: auditTable,
  itemCategoryKeywordsTable,
}));

let testApp: express.Express;
const sessionState: { employeeId: number; role?: string } = { employeeId: 1, role: "admin" };

beforeAll(async () => {
  const { default: router } = await import("../../modules/rfq/item-categories");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = sessionState;
    next();
  });
  testApp.use("/api", router);
});

beforeEach(() => {
  vi.clearAllMocks();
  auditInserts.length = 0;
  ownerReplaces.length = 0;
  employeeCatReplaces.length = 0;
  existingCategoryRows = [];
  listRows = [{ id: 1, name: "كهرباء", code: "electrical", isActive: true, sortOrder: 30 }];
  ownerRows = [];
  employeeCatRows = [];
  createdRow = { id: 9, name: "كهرباء", code: null, isActive: true, sortOrder: 0 };
  updatedRow = { id: 1, name: "كهرباء محدثة", code: "electrical", isActive: true, sortOrder: 30 };
  keywordRows = [];
  keywordCreatedRow = {
    id: 50,
    categoryId: 1,
    keyword: "cable",
    weight: 0,
    language: null,
    enabled: true,
  };
  keywordUpdatedRow = {
    id: 50,
    categoryId: 1,
    keyword: "cable",
    weight: 0,
    language: null,
    enabled: false,
  };
  keywordDeletes.length = 0;
  sessionState.role = "admin";
});

describe("item categories CRUD", () => {
  it("lists categories", async () => {
    const res = await request(testApp).get("/api/item-categories");
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe("كهرباء");
  });

  it("creates a category (admin)", async () => {
    const res = await request(testApp).post("/api/item-categories").send({ name: "كهرباء" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("كهرباء");
    expect(auditInserts).toHaveLength(1);
  });

  it("rejects a duplicate category name with 409", async () => {
    existingCategoryRows = [{ id: 3 }];
    const res = await request(testApp).post("/api/item-categories").send({ name: "كهرباء" });
    expect(res.status).toBe(409);
  });

  it("rejects an empty name with 400", async () => {
    const res = await request(testApp).post("/api/item-categories").send({ name: "  " });
    expect(res.status).toBe(400);
  });

  it("forbids a non-admin/manager from creating", async () => {
    sessionState.role = "purchasing";
    const res = await request(testApp).post("/api/item-categories").send({ name: "جديد" });
    expect(res.status).toBe(403);
  });

  it("rejects two primary owners for one category with 400", async () => {
    const res = await request(testApp)
      .put("/api/item-categories/1/owners")
      .send({
        owners: [
          { employeeId: 10, isPrimary: true },
          { employeeId: 11, isPrimary: true },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("أساسي");
  });

  it("replaces category owners and audits", async () => {
    const res = await request(testApp)
      .put("/api/item-categories/1/owners")
      .send({ owners: [{ employeeId: 10, isPrimary: true }, { employeeId: 11 }] });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(auditInserts.some((a) => a.action === "item_category.owners_updated")).toBe(true);
  });

  it("replaces an employee's categories", async () => {
    const res = await request(testApp)
      .put("/api/employees/7/categories")
      .send({ categories: [{ categoryId: 1 }, { categoryId: 3, isPrimary: true }] });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(auditInserts.some((a) => a.action === "employee.categories_updated")).toBe(true);
  });

  it("returns every employee's categories in ONE request (bulk, no N+1)", async () => {
    ownerRows = [
      { employeeId: 7, categoryId: 1, isPrimary: true, name: "كهرباء" },
      { employeeId: 7, categoryId: 3, isPrimary: false, name: "مقاومة حريق" },
      { employeeId: 8, categoryId: 2, isPrimary: true, name: "قطع غيار" },
    ];
    const res = await request(testApp).get("/api/employees/categories");
    expect(res.status).toBe(200);
    expect(res.body[7]).toHaveLength(2);
    expect(res.body[7][0]).toMatchObject({ categoryId: 1, name: "كهرباء", isPrimary: true });
    expect(res.body[8]).toHaveLength(1);
  });

  // ── one primary per category: both write paths + the DB index ──────────────
  it("rejects two primary owners via the EMPLOYEE path with 400", async () => {
    const res = await request(testApp)
      .put("/api/employees/7/categories")
      .send({
        categories: [
          { categoryId: 1, isPrimary: true },
          { categoryId: 3, isPrimary: true },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("أساسي");
  });

  it("maps a DB one-primary unique violation to 400 (employee path)", async () => {
    // Simulates the cross-employee case the payload check cannot see: another
    // employee already owns this category as primary, so the partial unique
    // index rejects the insert. The route must translate 23505 → 400, not 500.
    const err: any = new Error("duplicate key value violates unique constraint");
    err.code = "23505";
    err.constraint = "employee_categories_one_primary_uq";
    dbMock.transaction.mockImplementationOnce(async () => {
      throw err;
    });
    const res = await request(testApp)
      .put("/api/employees/7/categories")
      .send({ categories: [{ categoryId: 1, isPrimary: true }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("أساسي");
  });

  it("maps a DB one-primary unique violation to 400 (category owners path)", async () => {
    const err: any = new Error("duplicate key value violates unique constraint");
    err.code = "23505";
    err.constraint = "employee_categories_one_primary_uq";
    dbMock.transaction.mockImplementationOnce(async () => {
      throw err;
    });
    const res = await request(testApp)
      .put("/api/item-categories/1/owners")
      .send({ owners: [{ employeeId: 10, isPrimary: true }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("أساسي");
  });
});

describe("item category keywords (admin-managed vocabulary)", () => {
  it("lists keywords for a category", async () => {
    keywordRows = [
      { id: 1, categoryId: 3, keyword: "cable", weight: 0, language: "en", enabled: true },
    ];
    const res = await request(testApp).get("/api/item-categories/3/keywords");
    expect(res.status).toBe(200);
    expect(res.body[0].keyword).toBe("cable");
  });

  it("creates a keyword (admin)", async () => {
    const res = await request(testApp)
      .post("/api/item-categories/1/keywords")
      .send({ keyword: "cable", weight: 5, language: "en" });
    expect(res.status).toBe(201);
    expect(res.body.keyword).toBe("cable");
    expect(auditInserts).toHaveLength(1);
  });

  it("rejects an empty keyword with 400", async () => {
    const res = await request(testApp)
      .post("/api/item-categories/1/keywords")
      .send({ keyword: "   " });
    expect(res.status).toBe(400);
  });

  it("maps a duplicate keyword (unique violation) to 409", async () => {
    dbMock.insert.mockImplementationOnce(() => ({
      values: () => {
        const err: any = new Error("duplicate key value violates unique constraint");
        err.code = "23505";
        err.constraint = "item_category_keywords_category_keyword_uq";
        throw err;
      },
    }));
    const res = await request(testApp)
      .post("/api/item-categories/1/keywords")
      .send({ keyword: "cable" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("موجودة");
  });

  it("toggles a keyword off without deleting it (PATCH enabled=false)", async () => {
    const res = await request(testApp)
      .patch("/api/item-categories/1/keywords/50")
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it("deletes a keyword", async () => {
    const res = await request(testApp).delete("/api/item-categories/1/keywords/50");
    expect(res.status).toBe(200);
    expect(keywordDeletes).toHaveLength(1);
  });

  it("forbids a non-admin/manager from managing keywords", async () => {
    sessionState.role = "purchasing";
    const res = await request(testApp)
      .post("/api/item-categories/1/keywords")
      .send({ keyword: "x" });
    expect(res.status).toBe(403);
  });
});

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
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
  sql: Object.assign((strings: any, ...values: any[]) => ({ __op: "sql", strings, values }), {
    raw: (s: string) => ({ __op: "sql.raw", s }),
  }),
}));

function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

const suppliersTable = {
  _: "suppliers",
  id: "id",
  name: "name",
  phone: "phone",
  email: "email",
  isActive: "is_active",
  category: "category",
};
const itemCategoriesTable = { _: "itemCategories", id: "id", name: "name", parentId: "parent_id" };
const supplierItemCategoryLinksTable = {
  _: "silinks",
  supplierId: "supplier_id",
  categoryId: "category_id",
  id: "id",
};
const supplierCategoriesTable = {
  _: "supplierCategories",
  id: "id",
  name: "name",
  parentId: "parent_id",
};
const supplierCategoryLinksTable = {
  _: "links",
  supplierId: "supplier_id",
  categoryId: "category_id",
};

// Per-test state. The item-category rows the mock serves — they both resolve
// link ids AND provide the tree for the subtree lookup.
let itemCategoryTree: any[] = [
  { id: 10, name: "كابلات", parentId: null },
  { id: 11, name: "قواطع", parentId: null },
];
let linkRows: any[] = [];
const linkDeletes: any[] = [];
const linkInserts: any[] = [];
const capturedWheres: any[] = [];

const dbMock: any = {
  select: vi.fn(() => ({
    from: vi.fn((table: any) => {
      if (table === itemCategoriesTable) {
        return chainable(itemCategoryTree, {
          where: vi.fn(() => chainable(itemCategoryTree)),
        });
      }
      if (table === supplierItemCategoryLinksTable) {
        return chainable(linkRows, {
          innerJoin: vi.fn(() =>
            chainable(linkRows, {
              where: vi.fn((w: any) => {
                capturedWheres.push(w);
                return chainable(linkRows);
              }),
            }),
          ),
          where: vi.fn((w: any) => {
            capturedWheres.push(w);
            return chainable(linkRows);
          }),
        });
      }
      if (table === suppliersTable) {
        return chainable([{ id: 1, name: "مورد أ" }], {
          where: vi.fn(() => chainable([{ id: 1, name: "مورد أ" }])),
        });
      }
      return chainable([], { where: vi.fn(() => chainable([])) });
    }),
  })),
  insert: vi.fn((table: any) => ({
    values: vi.fn((vals: any) => {
      if (table === supplierItemCategoryLinksTable) linkInserts.push(vals);
      return {
        onConflictDoNothing: vi.fn(() => chainable(undefined)),
        returning: vi.fn(() => chainable([])),
      };
    }),
  })),
  delete: vi.fn((table: any) => ({
    where: vi.fn((w: any) => {
      if (table === supplierItemCategoryLinksTable) linkDeletes.push(w);
      return chainable(undefined);
    }),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() =>
          chainable([
            {
              id: 1,
              name: "مورد أ",
              isActive: true,
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
          ]),
        ),
      })),
    })),
  })),
  execute: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(async (fn: any) => fn(dbMock)),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  suppliersTable,
  itemCategoriesTable,
  supplierItemCategoryLinksTable,
  supplierCategoriesTable,
  supplierCategoryLinksTable,
  sentLogTable: { _: "sentLog" },
  offersTable: { _: "offers" },
  offerItemsTable: { _: "offerItems" },
  purchaseOrderItemsTable: { _: "poItems" },
  poItemReceiptsTable: { _: "receipts" },
  purchaseOrdersTable: { _: "pos" },
  customerPoItemsTable: { _: "customerPoItems" },
  customerPosTable: { _: "customerPos" },
  rfqTable: { _: "rfq" },
}));

let testApp: express.Express;

beforeAll(async () => {
  const { default: router } = await import("../../modules/users/suppliers");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req, _res, next) => {
    (req as any).session = { employeeId: 1, role: "admin" };
    next();
  });
  testApp.use(router);
});

beforeEach(() => {
  vi.clearAllMocks();
  itemCategoryTree = [
    { id: 10, name: "كابلات", parentId: null },
    { id: 11, name: "قواطع", parentId: null },
  ];
  linkRows = [];
  linkDeletes.length = 0;
  linkInserts.length = 0;
  capturedWheres.length = 0;
});

describe("supplier ↔ item-category links", () => {
  it("saves the item-category ids submitted with a supplier PATCH", async () => {
    // The PATCH must reconcile the link table with exactly the ids submitted.
    const res = await request(testApp)
      .patch("/suppliers/1")
      .send({ name: "مورد أ", itemCategoryIds: [10, 11] });
    expect(res.status).toBe(200);
    expect(linkInserts).toContainEqual([
      { supplierId: 1, categoryId: 10 },
      { supplierId: 1, categoryId: 11 },
    ]);
  });

  it("clears the links when an empty array is submitted", async () => {
    const res = await request(testApp).patch("/suppliers/1").send({ itemCategoryIds: [] });
    expect(res.status).toBe(200);
    expect(linkDeletes.length).toBeGreaterThan(0);
    expect(linkInserts.length).toBe(0);
  });

  it("does not touch the links when the field is omitted", async () => {
    const res = await request(testApp).patch("/suppliers/1").send({ name: "مورد أ" });
    expect(res.status).toBe(200);
    expect(linkDeletes.length).toBe(0);
    expect(linkInserts.length).toBe(0);
  });
});

describe("suppliers that can supply an item category (with the subtree)", () => {
  it("includes the category's whole subtree in the lookup", async () => {
    // كهرباء(1) ← Automation(2) ← Encoders(3); a supplier linked to Encoders must
    // be found when searching كهرباء.
    itemCategoryTree = [
      { id: 1, name: "كهرباء", parentId: null },
      { id: 2, name: "Automation", parentId: 1 },
      { id: 3, name: "Encoders", parentId: 2 },
    ];
    linkRows = [
      { supplierId: 7, categoryId: 3 },
      { supplierId: 8, categoryId: 1 },
    ];
    const res = await request(testApp).get("/suppliers/for-item-category/1");
    expect(res.status).toBe(200);
    // The subtree the query used must contain all three ids.
    expect(new Set(res.body.subtreeIds)).toEqual(new Set([1, 2, 3]));
  });

  it("400s a non-numeric category id", async () => {
    const res = await request(testApp).get("/suppliers/for-item-category/abc");
    expect(res.status).toBe(400);
  });
});

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

import suppliersRouter from "../../modules/users/suppliers";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

// Shared captures — the insert/update payloads the routes build.
const captures: { insert: any[]; set: any[]; linkInsert: any[]; catInsert: any[] } = {
  insert: [],
  set: [],
  linkInsert: [],
  catInsert: [],
};

vi.mock("@workspace/db", () => {
  const tables = {
    suppliersTable: { _: "suppliers" },
    supplierCategoriesTable: { _: "supplierCategories", id: "id", name: "name" },
    supplierCategoryLinksTable: {
      _: "supplierCategoryLinks",
      supplierId: "supplier_id",
      categoryId: "category_id",
    },
    sentLogTable: { _: "sentLog" },
    offersTable: { _: "offers" },
    offerItemsTable: { _: "offerItems" },
    purchaseOrderItemsTable: { _: "poItems" },
    poItemReceiptsTable: { _: "receipts" },
    purchaseOrdersTable: { _: "pos" },
    customerPoItemsTable: { _: "customerPoItems" },
    customerPosTable: { _: "customerPos" },
    rfqTable: { _: "rfq" },
  };

  // A row that carries every field the routes serialize.
  function fullRow(extra: Record<string, unknown> = {}) {
    return {
      id: 7,
      supplierId: "SUP-7",
      name: "Acme",
      contactPerson: null,
      email: null,
      phone: null,
      address: null,
      category: "general",
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
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-01-01"),
      ...extra,
    };
  }
  (globalThis as any).__fullRow = fullRow;

  function chainable(rows: any): any {
    const api: any = {
      then: (resolve: any) => Promise.resolve(rows).then(resolve),
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

  return {
    db: {
      select: vi.fn(() => {
        // A builder whose `.from(table)` decides what to return: the link
        // tables resolve to [] (so they never consume the staged queue), and
        // everything else pulls the next staged row set.
        const api: any = chainable([]);
        api.from = (table: any) => {
          if (table?._ === "supplierCategories") {
            // Resolve the categories created earlier in THIS request, so the
            // link-save can map a name to an id (as the real DB would).
            const names = captures.catInsert.flat().map((r: any) => r.name);
            return chainable(names.map((n: string, i: number) => ({ id: i + 1, name: n })));
          }
          if (table?._ === "supplierCategoryLinks") return chainable([]);
          const res = (globalThis as any).__selectQueue.shift();
          return chainable(res ?? []);
        };
        return api;
      }),
      execute: vi.fn(async () => ({ rows: [] })),
      insert: vi.fn((table: any) => {
        let stored: any;
        const api: any = {
          values: (v: any) => {
            stored = v;
            // Record the link/category inserts separately from the supplier row
            // so a test can assert the relationship was written.
            if (table?._ === "supplierCategoryLinks") captures.linkInsert.push(v);
            else if (table?._ === "supplierCategories") captures.catInsert.push(v);
            else captures.insert.push(v);
            return api;
          },
          onConflictDoNothing: () => api,
          returning: () => {
            const [supplier] = [fullRow({ ...stored, id: 7 })];
            return Promise.resolve([supplier]);
          },
        };
        return api;
      }),
      update: vi.fn(() => {
        let stored: any;
        const api: any = {
          set: (v: any) => {
            stored = v;
            captures.set.push(v);
            return api;
          },
          where: () => api,
          returning: () => Promise.resolve([fullRow({ ...stored, id: 7 })]),
        };
        return api;
      }),
      delete: vi.fn(() => chainable([])),
    },
    ...tables,
  };
});

(globalThis as any).__selectQueue = [];
const selectQueue: any[] = (globalThis as any).__selectQueue;

const testApp = express();
testApp.use(express.json());
beforeAll(() => {
  testApp.use(suppliersRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  captures.insert.length = 0;
  captures.set.length = 0;
  captures.linkInsert.length = 0;
  captures.catInsert.length = 0;
  selectQueue.length = 0;
});

const BANK = {
  commercialRegister: "123456",
  taxRegistration: "123-456-789",
  bankName: "البنك الأهلي المصري",
  bankAccountHolder: "شركة النماذج التجارية",
  bankAccountNumber: "1234567890",
  iban: "EG380019000500000000263180002",
  swiftCode: "NBEGEGCX",
  bankBranch: "الفرع الرئيسي",
};

describe("supplier registration + bank fields", () => {
  it("POST persists every new field and echoes it back", async () => {
    const res = await request(testApp)
      .post("/suppliers")
      .send({ name: "Acme", category: "general", ...BANK });

    expect(res.status).toBe(201);
    const inserted = captures.insert[0];
    expect(inserted).toMatchObject(BANK);
    // ...and the response carries them so the detail page can render immediately.
    expect(res.body).toMatchObject(BANK);
  });

  it("POST trims whitespace on the bank values", async () => {
    await request(testApp)
      .post("/suppliers")
      .send({ name: "Acme", category: "general", iban: "  EG3800  " });
    expect(captures.insert[0].iban).toBe("EG3800");
  });

  it("PATCH updates the bank fields (they are in the allow-list)", async () => {
    const res = await request(testApp)
      .patch("/suppliers/7")
      .send({ bankName: "بنك مصر", swiftCode: "BMISEGCX" });

    expect(res.status).toBe(200);
    const setArg = captures.set[0];
    expect(setArg).toMatchObject({ bankName: "بنك مصر", swiftCode: "BMISEGCX" });
    expect(res.body.bankName).toBe("بنك مصر");
  });

  it("GET /suppliers/:id returns the bank fields", async () => {
    selectQueue.push([{ ...(globalThis as any).__fullRow(BANK) }]);
    const res = await request(testApp).get("/suppliers/7");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(BANK);
  });

  it("GET /suppliers returns the bank fields for every row", async () => {
    selectQueue.push([{ ...(globalThis as any).__fullRow(BANK) }]);
    const res = await request(testApp).get("/suppliers");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject(BANK);
  });

  it("bulk import persists the new fields per row", async () => {
    const res = await request(testApp)
      .post("/suppliers/bulk")
      .send({ suppliers: [{ name: "Bulk Co", category: "general", ...BANK }] });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(captures.insert[0]).toMatchObject(BANK);
    expect(res.body.details[0].supplier).toMatchObject(BANK);
  });

  it("POST also writes the supplier↔category LINK (source of truth)", async () => {
    await request(testApp).post("/suppliers").send({ name: "Acme", category: "كهرباء,قواطع" });
    // The category rows are created, then the supplier is linked to them.
    const createdNames = captures.catInsert.flat().map((r: any) => r.name);
    expect(createdNames).toContain("كهرباء");
    expect(createdNames).toContain("قواطع");
    const links = captures.linkInsert.flat();
    expect(links.length).toBe(2);
    expect(links.every((l: any) => l.supplierId === 7)).toBe(true);
  });

  it("PATCH reconciles the LINK when categories change", async () => {
    const res = await request(testApp).patch("/suppliers/7").send({ category: "كهرباء" });
    expect(res.status).toBe(200);
    const links = captures.linkInsert.flat();
    expect(links.length).toBe(1);
    expect(links[0]).toMatchObject({ supplierId: 7 });
  });
});

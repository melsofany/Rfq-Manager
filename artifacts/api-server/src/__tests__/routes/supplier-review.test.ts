/**
 * Supplier portal review — route tests.
 *
 * The module reads the PORTAL's tables with raw SQL, so the assertions here are
 * about the DECISIONS it makes: which category the supplier is filed under, what
 * it refuses, and what it writes. Two of these guard recorded defect classes:
 *
 *   • the `__other__` sentinel must never become a category — filing under it
 *     would create a real catalogue row literally named `__other__`, and the
 *     supplier would be invisible under every real category;
 *   • a non-leaf trade must be refused — filing into a parent double-counts the
 *     supplier in every subtree query.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

import supplierReviewRouter from "../../modules/supplier-review/index";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

const state = vi.hoisted(() => ({
  // Row queues the raw SQL returns, keyed by a marker in the statement.
  application: null as Record<string, unknown> | null,
  applicationList: [] as Array<Record<string, unknown>>,
  counts: [] as Array<{ status: string; count: string }>,
  documents: [] as Array<Record<string, unknown>>,
  document: null as Record<string, unknown> | null,
  itemCategories: [] as Array<{ id: number; name: string }>,
  nonLeaf: [] as Array<{ name: string }>,
  existingSupplier: [] as Array<{ id: number; name: string }>,
  // Writes the module performs.
  insertedSupplier: null as Record<string, unknown> | null,
  txStatements: [] as string[],
  categoryLinks: [] as Array<{ supplierId: number; names: string[] }>,
  itemLinks: [] as Array<{ supplierId: number; ids: number[] }>,
  queries: [] as string[],
}));

vi.mock("@workspace/db", () => {
  const tx = {
    insert: () => ({
      values: (vals: Record<string, unknown>) => {
        state.insertedSupplier = vals;
        return { returning: async () => [{ id: 555 }] };
      },
    }),
    execute: async () => {
      state.txStatements.push("update");
      return { rows: [] };
    },
  };
  return {
    db: {
      transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => state.existingSupplier }),
        }),
      }),
    },
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        state.queries.push(sql);
        if (/FROM supplier_applications WHERE id/.test(sql)) {
          return {
            rows: state.application ? [state.application] : [],
            rowCount: state.application ? 1 : 0,
          };
        }
        if (/FROM supplier_applications\b/.test(sql)) {
          return { rows: state.applicationList, rowCount: state.applicationList.length };
        }
        if (/GROUP BY status/.test(sql))
          return { rows: state.counts, rowCount: state.counts.length };
        if (/FROM supplier_application_documents/.test(sql)) {
          return { rows: state.document ? [state.document] : state.documents, rowCount: 1 };
        }
        if (/FROM item_categories/.test(sql)) return { rows: state.itemCategories, rowCount: 0 };
        if (/SELECT permissions FROM employees/.test(sql)) {
          return { rows: [{ permissions: null }], rowCount: 1 };
        }
        if (/JOIN supplier_categories c/.test(sql)) return { rows: state.nonLeaf, rowCount: 0 };
        if (/UPDATE supplier_applications/.test(sql)) {
          return { rows: [], rowCount: state.application ? 1 : 0, params };
        }
        return { rows: [], rowCount: 0 };
      },
    },
    suppliersTable: { id: "id", name: "name", email: "email" },
  };
});

vi.mock("../../shared/supplier-category-links", () => ({
  saveSupplierCategoryLinks: async (supplierId: number, names: string[]) => {
    state.categoryLinks.push({ supplierId, names });
  },
}));

vi.mock("../../shared/supplier-item-category-links", () => ({
  saveSupplierItemCategoryLinks: async (supplierId: number, ids: number[]) => {
    state.itemLinks.push({ supplierId, ids });
  },
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

const app = express();
app.use(express.json());
// The approve gate reads the session (role + employeeId) to resolve the review
// role, so the test app supplies one — an unauthenticated-looking request would
// be refused by the permission check rather than exercised.
app.use((req: any, _res, next) => {
  // `x-test-role` lets a case act as a DIFFERENT job role without a second app —
  // the permission gate is the thing under test, so the role must be steerable.
  req.session = {
    employeeId: 7,
    employeeName: "مدير المشتريات",
    role: (req.headers["x-test-role"] as string) || "manager",
  };
  next();
});
app.use("/api", supplierReviewRouter);

const application = (over: Record<string, unknown> = {}) => ({
  id: 42,
  reference: "APP-2026-000042",
  // `verified`: the approval gate refuses an unreviewed application, and that
  // rule is the point of the two-role split — the fixture reflects a file that
  // HAS been reviewed rather than bypassing the gate.
  status: "verified",
  name: "شركة النور للتوريدات",
  contact_person: "أحمد محمد",
  email: "info@alnoor.com",
  phone: "01000000000",
  address: "القاهرة",
  commercial_register: "123456",
  tax_registration: "432972587",
  bank_name: "CIB",
  bank_account_holder: "شركة النور",
  bank_account_number: "1234567890",
  iban: null,
  swift_code: "CIBEEGCX",
  bank_branch: "مدينة نصر",
  trade_categories: ["كابلات"],
  item_category_ids: [3],
  other_trade_category: null,
  supplied_items: ["كابل 3*6"],
  brand_names: ["السويدي"],
  notes: null,
  verification: {},
  supplier_id: null,
  created_at: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

beforeEach(() => {
  state.application = application();
  state.applicationList = [];
  state.counts = [];
  state.documents = [];
  state.document = null;
  state.itemCategories = [];
  state.nonLeaf = [];
  state.existingSupplier = [];
  state.insertedSupplier = null;
  state.txStatements = [];
  state.categoryLinks = [];
  state.itemLinks = [];
  state.queries = [];
});

describe("GET /api/supplier-review/applications", () => {
  it("searches the applicant's own item and brand text, not just his name", async () => {
    await request(app).get("/api/supplier-review/applications?q=كابل");
    const listSql = state.queries.find(
      (s) => /FROM supplier_applications\b/.test(s) && /ILIKE/.test(s),
    );
    expect(listSql).toBeTruthy();
    // An operator who remembers «the cable supplier» must find him without
    // knowing the company name, so the free-text columns are searched too.
    expect(listSql).toContain("supplied_items::text ILIKE");
    expect(listSql).toContain("brand_names::text ILIKE");
    expect(listSql).toContain("other_trade_category ILIKE");
  });

  it("parameterises the search term — a quote in the query must not reach SQL", async () => {
    await request(app).get("/api/supplier-review/applications?q=' OR 1=1 --");
    const listSql = state.queries.find(
      (s) => /FROM supplier_applications\b/.test(s) && /ILIKE/.test(s),
    );
    expect(listSql).not.toContain("OR 1=1");
    expect(listSql).toContain("$1");
  });
});

describe("GET /api/supplier-review/applications/:id", () => {
  it("never returns the document BYTES with the application", async () => {
    state.documents = [
      {
        id: 9,
        slot: "commercial_register",
        original_name: "cr.pdf",
        mime_type: "application/pdf",
        size_bytes: 2048,
        uploaded_at: new Date("2026-01-02T00:00:00Z"),
      },
    ];
    const res = await request(app).get("/api/supplier-review/applications/42");
    expect(res.status).toBe(200);
    expect(res.body.documents[0].label).toBe("السجل التجاري");
    expect(res.body.documents[0].content).toBeUndefined();
    const docSql = state.queries.find((s) => /FROM supplier_application_documents/.test(s));
    expect(docSql).not.toContain("content");
  });

  it("resolves the item category NAMES — the reviewer must read what he files under", async () => {
    state.itemCategories = [{ id: 3, name: "كهرباء" }];
    const res = await request(app).get("/api/supplier-review/applications/42");
    expect(res.body.itemCategoryNames).toEqual([{ id: 3, name: "كهرباء" }]);
  });

  it("404s an unknown application", async () => {
    state.application = null;
    const res = await request(app).get("/api/supplier-review/applications/42");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/supplier-review/documents/:docId", () => {
  it("serves the decoded bytes with the stored mime type", async () => {
    state.document = {
      original_name: "cr.pdf",
      mime_type: "application/pdf",
      content: Buffer.from("%PDF-1.4 hello").toString("base64"),
    };
    const res = await request(app).get("/api/supplier-review/documents/9");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.body.toString()).toContain("%PDF-1.4 hello");
  });
});

describe("POST /api/supplier-review/applications/:id/approve", () => {
  it("creates the supplier and files him under the categories he applied with", async () => {
    const res = await request(app).post("/api/supplier-review/applications/42/approve");
    expect(res.status).toBe(200);
    expect(res.body.supplierId).toBe(555);
    expect(res.body.categories).toEqual(["كابلات"]);
    // The links go through the SHARED helpers, so a portal supplier and a
    // hand-typed one cannot be filed by two different rules.
    expect(state.categoryLinks).toEqual([{ supplierId: 555, names: ["كابلات"] }]);
    expect(state.itemLinks).toEqual([{ supplierId: 555, ids: [3] }]);
  });

  it("uses the category the applicant TYPED when he chose «أخرى», never the sentinel", async () => {
    state.application = application({
      trade_categories: ["كابلات", "__other__"],
      other_trade_category: "معدات  ثقيلة",
    });
    const res = await request(app).post("/api/supplier-review/applications/42/approve");
    expect(res.status).toBe(200);
    // The sentinel must never be a category: a real catalogue row literally
    // named `__other__` is invisible under every real category.
    expect(res.body.categories).toEqual(["كابلات", "معدات ثقيلة"]);
    expect(state.insertedSupplier?.category).toBe("كابلات,معدات ثقيلة");
    expect(JSON.stringify(state.insertedSupplier)).not.toContain("__other__");
  });

  it("normalises the whitespace of a typed category — one trade, one row", async () => {
    state.application = application({
      trade_categories: ["__other__"],
      other_trade_category: "  معدات   ثقيلة  ",
    });
    const res = await request(app).post("/api/supplier-review/applications/42/approve");
    expect(res.body.categories).toEqual(["معدات ثقيلة"]);
  });

  it("refuses a NON-LEAF trade — filing into a parent double-counts the supplier", async () => {
    state.nonLeaf = [{ name: "كهرباء" }];
    state.application = application({ trade_categories: ["كهرباء"] });
    const res = await request(app).post("/api/supplier-review/applications/42/approve");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("كهرباء");
    expect(state.insertedSupplier).toBeNull();
  });

  it("refuses an application with no trade at all", async () => {
    state.application = application({
      trade_categories: ["__other__"],
      other_trade_category: null,
    });
    const res = await request(app).post("/api/supplier-review/applications/42/approve");
    expect(res.status).toBe(400);
  });

  it("refuses when the email already belongs to a supplier", async () => {
    state.existingSupplier = [{ id: 12, name: "شركة قديمة" }];
    const res = await request(app).post("/api/supplier-review/applications/42/approve");
    expect(res.status).toBe(409);
    expect(res.body.existingSupplierId).toBe(12);
    expect(state.insertedSupplier).toBeNull();
  });

  it("refuses to approve an already-approved application", async () => {
    state.application = application({ status: "approved", supplier_id: 77 });
    const res = await request(app).post("/api/supplier-review/applications/42/approve");
    expect(res.status).toBe(409);
    expect(state.insertedSupplier).toBeNull();
  });

  it("refuses to approve a rejected application", async () => {
    state.application = application({ status: "rejected" });
    const res = await request(app).post("/api/supplier-review/applications/42/approve");
    expect(res.status).toBe(409);
  });

  it("carries the applicant's items and brands onto the supplier row", async () => {
    await request(app).post("/api/supplier-review/applications/42/approve");
    expect(state.insertedSupplier?.suppliedItems).toEqual(["كابل 3*6"]);
    expect(state.insertedSupplier?.brandNames).toEqual(["السويدي"]);
    // The trace from the supplier row back to the application it came from.
    expect(state.insertedSupplier?.portalApplicationId).toBe(42);
  });

  it("stamps the application inside the SAME transaction that creates the supplier", async () => {
    await request(app).post("/api/supplier-review/applications/42/approve");
    // A supplier created without the stamp would be approved twice on a retry.
    expect(state.txStatements).toEqual(["update"]);
  });

  it("refuses to approve an application that has NOT been reviewed", async () => {
    // The two-role split is only real if approval is unreachable from the queue.
    // Without this, a reviewer's verification step is optional and the audit
    // trail shows a supplier created with no document ever confirmed.
    state.application = application({ status: "submitted" });
    const res = await request(app).post("/api/supplier-review/applications/42/approve");

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("تم الفحص");
    expect(res.body.requiredStatus).toBe("verified");
    // Nothing was created — a refused approval must not leave a supplier behind.
    expect(state.insertedSupplier).toBeNull();
    expect(state.txStatements).toEqual([]);
  });

  it("refuses to approve when the user has no approve permission", async () => {
    // A purchasing employee is a reviewer, not an approver.
    state.application = application({ status: "verified" });
    const res = await request(app)
      .post("/api/supplier-review/applications/42/approve")
      .set("x-test-role", "purchasing");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("صلاحيتك");
    expect(state.insertedSupplier).toBeNull();
  });

  it("records the approval with the supplier it created", async () => {
    // The decision an auditor asks about must name WHAT it produced.
    state.application = application({ status: "verified" });
    await request(app).post("/api/supplier-review/applications/42/approve");
    const audit = state.queries.filter((q) => /INSERT INTO supplier_application_events/.test(q));
    expect(audit.length).toBeGreaterThan(0);
  });
});

describe("POST /api/supplier-review/applications/:id/verification", () => {
  it("stores only the three known verdicts", async () => {
    const res = await request(app)
      .post("/api/supplier-review/applications/42/verification")
      .send({ verification: { bankName: "matched", iban: "mismatch", junk: "whatever" } });
    expect(res.status).toBe(200);
    expect(res.body.verification).toEqual({ bankName: "matched", iban: "mismatch" });
    expect(res.body.mismatched).toEqual(["iban"]);
  });

  it("404s a verdict for an unknown application", async () => {
    state.application = null;
    const res = await request(app)
      .post("/api/supplier-review/applications/42/verification")
      .send({ verification: { bankName: "matched" } });
    expect(res.status).toBe(404);
  });
});

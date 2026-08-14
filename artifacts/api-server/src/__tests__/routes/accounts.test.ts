import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth ───────────────────────────────────────────────────────────────
let sessionState = { employeeId: 7, role: "employee" };
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.session = req.session ?? {};
    req.session.employeeId = sessionState.employeeId;
    next();
  },
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) => {
    if (!sessionState.employeeId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(sessionState.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  },
}));

// ── Chainable + thenable DB mock ─────────────────────────────────────────────
function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

const taxSettingsTbl = "taxSettings";
const customerPosTbl = "customerPos";
const customerPoItemsTbl = "customerPoItems";
const purchaseOrdersTbl = "purchaseOrders";
const purchaseOrderItemsTbl = "purchaseOrderItems";
const suppliersTbl = "suppliers";
const customersTbl = "customers";
const auditTbl = "audit";
const supplierInvoicesTbl = "supplierInvoices";
const salesInvoicesTbl = "salesInvoices";

// Per-test rows.
let taxSettingsRow: any | null;
let sellRows: any[];
let buyRows: any[];
let poRows: any[];
let salesInvoiceRows: any[];
let supplierInvoiceRows: any[];

function selectBuilder() {
  // The accounts routes call select().from(t).innerJoin().leftJoin().where().orderBy()
  // and select().from(t).leftJoin().leftJoin().where().orderBy(). We model each
  // by chaining through an object whose methods return the same builder; the
  // final await resolves the collected rows for the matching FROM table.
  const api: any = {
    from: vi.fn((table: any) => {
      let rows: any[] = [];
      if (table === customerPoItemsTbl) rows = sellRows;
      else if (table === purchaseOrderItemsTbl) rows = buyRows;
      else if (table === purchaseOrdersTbl) rows = poRows;
      else if (table === taxSettingsTbl) rows = taxSettingsRow ? [taxSettingsRow] : [];
      else if (table === salesInvoicesTbl) rows = salesInvoiceRows.filter((r) => r.status === "posted");
      else if (table === supplierInvoicesTbl) rows = supplierInvoiceRows.filter((r) => r.status === "posted");
      const cur: any = {
        innerJoin: vi.fn(() => cur),
        leftJoin: vi.fn(() => cur),
        where: vi.fn(() => cur),
        orderBy: vi.fn(() => cur),
        limit: vi.fn(() => chainable(rows)),
        then: (resolve: any) => Promise.resolve(rows).then(resolve),
      };
      return cur;
    }),
  };
  return api;
}

const dbMock: any = {
  select: vi.fn(() => selectBuilder()),
  insert: vi.fn(() => ({ values: vi.fn(() => chainable([{ id: 1 }], { returning: vi.fn(() => chainable([{ id: 1 }])) })) })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })) })),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  taxSettingsTable: taxSettingsTbl,
  customerPosTable: customerPosTbl,
  customerPoItemsTable: customerPoItemsTbl,
  purchaseOrdersTable: purchaseOrdersTbl,
  purchaseOrderItemsTable: purchaseOrderItemsTbl,
  suppliersTable: suppliersTbl,
  customersTable: customersTbl,
  auditLogTable: auditTbl,
  supplierInvoicesTable: supplierInvoicesTbl,
  salesInvoicesTable: salesInvoicesTbl,
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: any, _b: any) => a,
  sql: { template: { raw: (s: any) => s } },
  and: (...args: any[]) => args.find((a) => a !== undefined) ?? undefined,
  desc: (a: any) => a,
  gte: (_a: any, _b: any) => undefined,
  lte: (_a: any, _b: any) => undefined,
}));

let testApp: express.Express;

beforeAll(async () => {
  const { default: accountsRouter } = await import("../../modules/accounts/routes");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { ...sessionState };
    next();
  });
  testApp.use("/api", accountsRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionState = { employeeId: 7, role: "employee" };
  taxSettingsRow = { id: 1, vatRate: "14", withholdingRate: "3", withholdingRateServices: "5", withholdingRatePurchases: "1" };
  sellRows = [];
  buyRows = [];
  poRows = [];
  salesInvoiceRows = [];
  supplierInvoiceRows = [];
});

describe("GET /api/accounts/tax-settings", () => {
  it("returns the configured rates (defaults applied)", async () => {
    const res = await request(testApp).get("/api/accounts/tax-settings");
    expect(res.status).toBe(200);
    expect(res.body.vatRate).toBe(14);
    expect(res.body.withholdingRate).toBe(3);
    expect(res.body.withholdingRateServices).toBe(5);
    expect(res.body.withholdingRatePurchases).toBe(1);
  });

  it("uses statutory defaults when the row is absent", async () => {
    taxSettingsRow = null;
    const res = await request(testApp).get("/api/accounts/tax-settings");
    expect(res.status).toBe(200);
    expect(res.body.vatRate).toBe(14);
    expect(res.body.withholdingRate).toBe(3);
  });
});

describe("GET /api/accounts/vat", () => {
  it("computes output VAT (posted sales invoices) and input VAT (posted supplier invoices), returns net payable", async () => {
    salesInvoiceRows = [
      { id: 1, invoiceNo: "INV-2026-000001", customerName: "عميل أ", customerPoNo: "C-1", invoiceDate: "2026-08-01", netAmount: "1000", vatAmount: "140", grossAmount: "1140", status: "posted" },
    ];
    supplierInvoiceRows = [
      { id: 2, invoiceNo: "SI-2026-000001", supplierInvoiceNo: "S-1", supplierName: "مورد ب", poNo: "PO-1", invoiceDate: "2026-08-02", netAmount: "600", vatAmount: "84", grossAmount: "684", status: "posted" },
    ];

    const res = await request(testApp).get("/api/accounts/vat");
    expect(res.status).toBe(200);
    expect(res.body.vatRate).toBe(14);
    // Output: net 1000 → VAT 140
    expect(res.body.output.net).toBe(1000);
    expect(res.body.output.vat).toBe(140);
    // Input: net 600 → VAT 84
    expect(res.body.input.net).toBe(600);
    expect(res.body.input.vat).toBe(84);
    // Net VAT = 140 − 84 = 56 payable
    expect(res.body.netVat).toBe(56);
    expect(res.body.payable).toBe(56);
    expect(res.body.credit).toBe(0);
  });

  it("returns a credit when input VAT exceeds output VAT", async () => {
    salesInvoiceRows = [];
    supplierInvoiceRows = [
      { id: 2, invoiceNo: "SI-2026-000001", supplierInvoiceNo: "S-1", supplierName: "مورد ب", poNo: "PO-1", invoiceDate: "2026-08-02", netAmount: "1052.63", vatAmount: "147.37", grossAmount: "1200", status: "posted" },
    ];

    const res = await request(testApp).get("/api/accounts/vat");
    expect(res.status).toBe(200);
    expect(res.body.input.vat).toBeCloseTo(147.37, 1);
    expect(res.body.credit).toBeGreaterThan(0);
    expect(res.body.payable).toBe(0);
  });

  it("ignores draft/void invoices", async () => {
    salesInvoiceRows = [
      { id: 1, invoiceNo: "INV-DRAFT", customerName: "عميل أ", customerPoNo: null, invoiceDate: "2026-08-01", netAmount: "1000", vatAmount: "140", grossAmount: "1140", status: "draft" },
    ];
    supplierInvoiceRows = [];
    const res = await request(testApp).get("/api/accounts/vat");
    expect(res.status).toBe(200);
    expect(res.body.output.net).toBe(0);
    expect(res.body.input.net).toBe(0);
    expect(res.body.netVat).toBe(0);
  });
});

describe("GET /api/accounts/withholding", () => {
  it("withholds from posted supplier invoices and sums totals", async () => {
    supplierInvoiceRows = [
      { id: 1, invoiceNo: "SI-2026-000001", supplierInvoiceNo: "S-1", supplierName: "مورد ب", poNo: "PO-2026-000001", invoiceDate: "2026-08-01", netAmount: "1200", withholdingRate: "3", withholdingAmount: "36", grossAmount: "1368", status: "posted" },
      { id: 2, invoiceNo: "SI-2026-000002", supplierInvoiceNo: "S-2", supplierName: "مورد ج", poNo: "PO-2026-000002", invoiceDate: "2026-08-03", netAmount: "100", withholdingRate: "3", withholdingAmount: "3", grossAmount: "114", status: "posted" },
    ];

    const res = await request(testApp).get("/api/accounts/withholding");
    expect(res.status).toBe(200);
    expect(res.body.withholdingRate).toBe(3);
    const l1 = res.body.lines.find((l: any) => l.poId === 1);
    const l2 = res.body.lines.find((l: any) => l.poId === 2);
    expect(l1.netValue).toBe(1200);
    expect(l1.withholding).toBe(36);
    expect(l1.payableToSupplier).toBe(1164);
    expect(l2.withholding).toBe(3);
    expect(res.body.totalNet).toBe(1300);
    expect(res.body.totalWithholding).toBe(39);
    expect(res.body.totalPayable).toBe(1261);
  });
});

describe("PUT /api/accounts/tax-settings", () => {
  it("rejects non-admin/manager users (403)", async () => {
    const res = await request(testApp).put("/api/accounts/tax-settings").send({ vatRate: 15 });
    expect(res.status).toBe(403);
  });

  it("allows a manager to update the VAT rate", async () => {
    sessionState = { employeeId: 7, role: "manager" };
    const res = await request(testApp)
      .put("/api/accounts/tax-settings")
      .send({ vatRate: "15", withholdingRate: 2 });
    expect(res.status).toBe(200);
    expect(res.body.vatRate).toBe(15);
    expect(res.body.withholdingRate).toBe(2);
  });
});

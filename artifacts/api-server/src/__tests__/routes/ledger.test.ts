import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth ───────────────────────────────────────────────────────────────
let sessionState: { employeeId: number; role: string; employeeName?: string } = {
  employeeId: 7,
  role: "accountant",
  employeeName: "المحاسب",
};
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.session = req.session ?? {};
    req.session.employeeId = sessionState.employeeId;
    req.session.role = sessionState.role;
    req.session.employeeName = sessionState.employeeName;
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

// Per-test row stores.
let coaRows: any[];
let journalEntryRows: any[];
let journalLineRows: any[];
let supplierInvoiceRows: any[];
let supplierPaymentRows: any[];
let supplierPaymentAppRows: any[];
let salesInvoiceRows: any[];
let salesInvoiceItemRows: any[];
let customerPoRows: any[];
let customerPoItemRows: any[];
let purchaseOrderRows: any[];
let purchaseOrderItemRows: any[];
let poItemChargeRows: any[];
let taxSettingsRow: any | null;

// The last insert captures so tests can assert generated journal lines.
let lastInsert: { table: string; rows: any[]; returning?: any[] } | null = null;
let entryIdSeq = 100;

function selectBuilder() {
  const api: any = {
    from: vi.fn((table: any) => {
      let rows: any[] = [];
      if (table === TABLES.chartOfAccountsTable) rows = coaRows;
      else if (table === TABLES.journalEntriesTable) rows = journalEntryRows;
      else if (table === TABLES.journalLinesTable) rows = journalLineRows;
      else if (table === TABLES.supplierInvoicesTable) rows = supplierInvoiceRows;
      else if (table === TABLES.supplierPaymentsTable) rows = supplierPaymentRows;
      else if (table === TABLES.supplierPaymentApplicationsTable) rows = supplierPaymentAppRows;
      else if (table === TABLES.salesInvoicesTable) rows = salesInvoiceRows;
      else if (table === TABLES.salesInvoiceItemsTable) rows = salesInvoiceItemRows;
      else if (table === TABLES.customerPosTable) rows = customerPoRows;
      else if (table === TABLES.customerPoItemsTable) rows = customerPoItemRows;
      else if (table === TABLES.purchaseOrdersTable) rows = purchaseOrderRows;
      else if (table === TABLES.purchaseOrderItemsTable) rows = purchaseOrderItemRows;
      else if (table === TABLES.poItemChargesTable) rows = poItemChargeRows;
      else if (table === TABLES.taxSettingsTable) rows = taxSettingsRow ? [taxSettingsRow] : [];
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
  insert: vi.fn((table: any) => ({
    values: vi.fn((rows: any) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      const withIds = arr.map((r, i) => ({ id: ++entryIdSeq + i, ...r }));
      lastInsert = { table, rows: withIds };
      return chainable(withIds, { returning: vi.fn(() => chainable(withIds)) });
    }),
  })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })) })),
  delete: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })),
};

// Table handles resolved from the real schema (the routes import the actual
// drizzle table objects from @workspace/db, so we match by reference here).
let TABLES: Record<string, any> = {};

vi.mock("@workspace/db", async () => {
  const actual: any = await vi.importActual("@workspace/db");
  TABLES = actual; // capture the real table handles for selectBuilder.from()
  return {
    ...actual,
    db: dbMock,
    ACCOUNT_CODES: actual.ACCOUNT_CODES,
  };
});

vi.mock("drizzle-orm", () => {
  const sql: any = (strings: TemplateStringsArray, ...vals: any[]) => ({
    __raw: true,
    sql: strings,
    values: vals,
    // some code reads .map or treats the result as a string; expose a string.
    toString: () => strings.join("?"),
  });
  // mimic the tagged-template helper properties used by drizzle helpers.
  sql.template = { raw: (s: any) => ({ __raw: true, sql: [s], values: [], toString: () => s }) };
  return {
    eq: (a: any, _b: any) => a,
    sql,
    and: (...args: any[]) => args.find((a) => a !== undefined) ?? undefined,
    desc: (a: any) => a,
    gte: (_a: any, _b: any) => undefined,
    lte: (_a: any, _b: any) => undefined,
  };
});

let testApp: express.Express;

beforeAll(async () => {
  const { default: ledgerRouter } = await import("../../modules/accounts/ledger");
  const { default: supplierInvoicesRouter } = await import("../../modules/accounts/supplier-invoices");
  const { default: salesInvoicesRouter } = await import("../../modules/accounts/sales-invoices");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { ...sessionState };
    next();
  });
  testApp.use("/api", ledgerRouter);
  testApp.use("/api", supplierInvoicesRouter);
  testApp.use("/api", salesInvoicesRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  lastInsert = null;
  entryIdSeq = 100;
  sessionState = { employeeId: 7, role: "accountant", employeeName: "المحاسب" };
  taxSettingsRow = { id: 1, vatRate: "14", withholdingRate: "3", withholdingRateServices: "5", withholdingRatePurchases: "1" };
  coaRows = [
    { id: 1, code: "1001", nameAr: "النقدية", nameEn: null, type: "asset", isControl: true, isActive: true },
    { id: 2, code: "1010", nameAr: "البنوك", nameEn: null, type: "asset", isControl: true, isActive: true },
    { id: 3, code: "1200", nameAr: "ذمم العملاء", nameEn: null, type: "asset", isControl: true, isActive: true },
    { id: 4, code: "1300", nameAr: "المخزون", nameEn: null, type: "asset", isControl: true, isActive: true },
    { id: 5, code: "1401", nameAr: "ض.ق.م. المدخلات", nameEn: null, type: "asset", isControl: true, isActive: true },
    { id: 6, code: "2100", nameAr: "ذمم الموردين", nameEn: null, type: "liability", isControl: true, isActive: true },
    { id: 7, code: "2401", nameAr: "ض.ق.م. المخرجات", nameEn: null, type: "liability", isControl: true, isActive: true },
    { id: 8, code: "2402", nameAr: "الخصم تحت حساب الضريبة", nameEn: null, type: "liability", isControl: true, isActive: true },
    { id: 9, code: "4100", nameAr: "المبيعات", nameEn: null, type: "revenue", isControl: false, isActive: true },
    { id: 10, code: "5100", nameAr: "تكلفة المبيعات", nameEn: null, type: "expense", isControl: false, isActive: true },
    { id: 11, code: "5900", nameAr: "مصاريف بنكية", nameEn: null, type: "expense", isControl: false, isActive: true },
  ];
  journalEntryRows = [];
  journalLineRows = [];
  supplierInvoiceRows = [];
  supplierPaymentRows = [];
  supplierPaymentAppRows = [];
  salesInvoiceRows = [];
  salesInvoiceItemRows = [];
  customerPoRows = [];
  customerPoItemRows = [];
  purchaseOrderRows = [];
  purchaseOrderItemRows = [];
  poItemChargeRows = [];
});

// ── Chart of accounts ────────────────────────────────────────────────────────
describe("GET /api/accounts/coa", () => {
  it("returns the chart of accounts ordered by code", async () => {
    const res = await request(testApp).get("/api/accounts/coa");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(4);
    expect(res.body[0].code).toBe("1001");
  });
});

describe("POST /api/accounts/coa", () => {
  it("rejects non-accountant (403)", async () => {
    sessionState = { employeeId: 7, role: "purchasing" };
    const res = await request(testApp).post("/api/accounts/coa").send({ code: "9999", nameAr: "اختبار", type: "expense" });
    expect(res.status).toBe(403);
  });

  it("creates an account (accountant)", async () => {
    const res = await request(testApp)
      .post("/api/accounts/coa")
      .send({ code: "1999", nameAr: "حساب تجريبي", type: "asset" });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe("1999");
  });

  it("validates required fields", async () => {
    const res = await request(testApp).post("/api/accounts/coa").send({ code: "1999" });
    expect(res.status).toBe(400);
  });
});

// ── Journal entries ────────────────────────────────────────────────────────
describe("POST /api/accounts/journal", () => {
  it("creates a balanced manual journal entry (draft)", async () => {
    const res = await request(testApp)
      .post("/api/accounts/journal")
      .send({
        entryDate: "2026-08-01",
        description: "قيد اختبار",
        status: "draft",
        lines: [
          { accountCode: "1001", debit: 1000, credit: 0 },
          { accountCode: "2100", debit: 0, credit: 1000 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    // the posting helper inserts a journal_entries + a journal_lines row
    expect(dbMock.insert).toHaveBeenCalled();
  });

  it("rejects an unbalanced entry", async () => {
    const res = await request(testApp)
      .post("/api/accounts/journal")
      .send({
        entryDate: "2026-08-01",
        description: "غير متوازن",
        lines: [
          { accountCode: "1001", debit: 1000, credit: 0 },
          { accountCode: "2100", debit: 0, credit: 500 },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/غير متوازن/);
  });

  it("rejects an entry with fewer than 2 lines", async () => {
    const res = await request(testApp)
      .post("/api/accounts/journal")
      .send({ entryDate: "2026-08-01", description: "بند واحد", lines: [{ accountCode: "1001", debit: 100, credit: 0 }] });
    expect(res.status).toBe(400);
  });

  it("rejects a zero entry", async () => {
    const res = await request(testApp)
      .post("/api/accounts/journal")
      .send({
        entryDate: "2026-08-01",
        description: "صفر",
        lines: [
          { accountCode: "1001", debit: 0, credit: 0 },
          { accountCode: "2100", debit: 0, credit: 0 },
        ],
      });
    expect(res.status).toBe(400);
  });
});

// ── Supplier invoices ──────────────────────────────────────────────────────
describe("POST /api/accounts/supplier-invoices", () => {
  it("creates a supplier invoice (draft) computing VAT + withholding", async () => {
    const res = await request(testApp)
      .post("/api/accounts/supplier-invoices")
      .send({
        supplierName: "مورد تجريبي",
        invoiceDate: "2026-08-01",
        netAmount: 1000,
        applyWithholding: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.invoiceNo).toMatch(/^SI-2026-/);
  });

  it("validates required fields", async () => {
    const res = await request(testApp)
      .post("/api/accounts/supplier-invoices")
      .send({ invoiceDate: "2026-08-01" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/accounts/supplier-invoices/:id/post", () => {
  it("posts a draft supplier invoice generating a balanced journal", async () => {
    // Net 1000, VAT 140, gross 1140, withholding 3% of net = 30 → payable 1110
    supplierInvoiceRows = [
      {
        id: 1,
        invoiceNo: "SI-2026-000001",
        supplierInvoiceNo: "INV-1",
        supplierId: 5,
        supplierName: "مورد تجريبي",
        poId: null,
        poNo: null,
        invoiceDate: "2026-08-01",
        dueDate: null,
        netAmount: "1000",
        vatAmount: "140",
        withholdingRate: "3",
        withholdingAmount: "30",
        grossAmount: "1140",
        paidAmount: "0",
        balance: "1110",
        status: "draft",
        notes: null,
      },
    ];
    const res = await request(testApp).post("/api/accounts/supplier-invoices/1/post");
    expect(res.status).toBe(200);
    expect(res.body.posted).toBe(true);
    expect(res.body.journalEntryId).toBeDefined();
    // the posting helper should have inserted a journal entry + lines
    expect(dbMock.insert).toHaveBeenCalled();
  });

  it("rejects posting a non-draft invoice", async () => {
    supplierInvoiceRows = [{ id: 2, invoiceNo: "SI-2", supplierName: "م", invoiceDate: "2026-08-01", netAmount: "1000", vatAmount: "140", withholdingRate: "3", withholdingAmount: "30", grossAmount: "1140", balance: "1110", status: "posted" }];
    const res = await request(testApp).post("/api/accounts/supplier-invoices/2/post");
    expect(res.status).toBe(400);
  });
});

// ── Sales invoices ─────────────────────────────────────────────────────────
describe("POST /api/accounts/sales-invoices", () => {
  it("creates a sales invoice with manual items computing VAT", async () => {
    const res = await request(testApp)
      .post("/api/accounts/sales-invoices")
      .send({
        customerName: "عميل تجريبي",
        invoiceDate: "2026-08-01",
        items: [
          { description: "بند 1", qty: 10, unitPrice: 100 },
          { description: "بند 2", qty: 2, unitPrice: 50 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.invoiceNo).toMatch(/^INV-2026-/);
  });

  it("auto-fills items from a customer PO", async () => {
    customerPoRows = [{ id: 9, no: "CPO-9", customerId: 3, name: "عميل من PO" }];
    customerPoItemRows = [
      { id: 1, customerPoId: 9, lineItem: "L1", partNo: "P1", description: "بند PO", uom: "قطعة", qty: "5", unitPrice: "200" },
    ];
    const res = await request(testApp)
      .post("/api/accounts/sales-invoices")
      .send({ customerPoId: 9, invoiceDate: "2026-08-01" });
    expect(res.status).toBe(200);
    expect(res.body.invoiceNo).toMatch(/^INV-2026-/);
  });

  it("validates invoice date is required", async () => {
    const res = await request(testApp)
      .post("/api/accounts/sales-invoices")
      .send({ customerName: "عميل" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/accounts/sales-invoices/:id/post", () => {
  it("posts a draft sales invoice generating AR + Sales + Output VAT journal", async () => {
    // Net 1000, VAT 140, gross 1140, no customer PO → no COGS.
    salesInvoiceRows = [
      {
        id: 1,
        invoiceNo: "INV-2026-000001",
        customerPoId: null,
        customerPoNo: null,
        customerId: 3,
        customerName: "عميل تجريبي",
        invoiceDate: "2026-08-01",
        dueDate: null,
        netAmount: "1000",
        vatAmount: "140",
        grossAmount: "1140",
        cogsAmount: "0",
        collectedAmount: "0",
        balance: "1140",
        status: "draft",
        notes: null,
      },
    ];
    const res = await request(testApp).post("/api/accounts/sales-invoices/1/post");
    expect(res.status).toBe(200);
    expect(res.body.posted).toBe(true);
    expect(res.body.journalEntryId).toBeDefined();
    expect(res.body.cogs).toBe("0");
  });

  it("recognizes COGS from a linked customer PO's supplier receipts", async () => {
    salesInvoiceRows = [
      {
        id: 2,
        invoiceNo: "INV-2026-000002",
        customerPoId: 7,
        customerPoNo: "CPO-7",
        customerId: 3,
        customerName: "عميل",
        invoiceDate: "2026-08-01",
        dueDate: null,
        netAmount: "1000",
        vatAmount: "140",
        grossAmount: "1140",
        cogsAmount: "0",
        collectedAmount: "0",
        balance: "1140",
        status: "draft",
        notes: null,
      },
    ];
    customerPoItemRows = [{ id: 11, customerPoId: 7, acceptedQty: "10", actualCost: "60", poItemId: 21 }];
    purchaseOrderItemRows = [];
    poItemChargeRows = [];
    const res = await request(testApp).post("/api/accounts/sales-invoices/2/post");
    expect(res.status).toBe(200);
    // COGS = 10 accepted × 60 cost = 600
    expect(res.body.cogs).toBe("600");
  });

  it("rejects posting a non-draft sales invoice", async () => {
    salesInvoiceRows = [{ id: 3, invoiceNo: "INV-3", customerName: "ع", invoiceDate: "2026-08-01", netAmount: "1000", vatAmount: "140", grossAmount: "1140", cogsAmount: "0", collectedAmount: "0", balance: "1140", status: "posted" }];
    const res = await request(testApp).post("/api/accounts/sales-invoices/3/post");
    expect(res.status).toBe(400);
  });
});

// ── Supplier payments ─────────────────────────────────────────────────────
describe("POST /api/accounts/supplier-payments", () => {
  it("creates a supplier payment and generates a journal entry", async () => {
    const res = await request(testApp)
      .post("/api/accounts/supplier-payments")
      .send({
        supplierName: "مورد تجريبي",
        paymentDate: "2026-08-05",
        method: "bank_transfer",
        amount: 500,
        bankCharges: 5,
      });
    expect(res.status).toBe(200);
    expect(res.body.paymentNo).toMatch(/^SP-2026-/);
    expect(res.body.journalEntryId).toBeDefined();
  });

  it("validates required fields", async () => {
    const res = await request(testApp)
      .post("/api/accounts/supplier-payments")
      .send({ supplierName: "مورد" });
    expect(res.status).toBe(400);
  });
});

// ── Dashboard ──────────────────────────────────────────────────────────────
describe("GET /api/accounts/dashboard", () => {
  it("returns AP/AR/cash/bank totals + pending drafts + recent entries", async () => {
    const res = await request(testApp).get("/api/accounts/dashboard");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("totalAP");
    expect(res.body).toHaveProperty("totalAR");
    expect(res.body).toHaveProperty("cash");
    expect(res.body).toHaveProperty("bank");
    expect(res.body).toHaveProperty("pendingDrafts");
  });
});

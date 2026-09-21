import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { marginOf, type MarginInput } from "../../modules/accounts/tax";

// ── Mock auth ───────────────────────────────────────────────────────────────
let sessionState = { employeeId: 7, role: "employee" };
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.session = req.session ?? {};
    req.session.employeeId = sessionState.employeeId;
    next();
  },
  requireRole:
    (...roles: string[]) =>
    (req: any, res: any, next: any) => {
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
const poChargesTbl = "poCharges";

// Per-test rows.
let taxSettingsRow: any | null;
let sellRows: any[];
let buyRows: any[];
let poRows: any[];
let customerPoRows: any[];
let salesInvoiceRows: any[];
let supplierInvoiceRows: any[];
let poChargeRows: any[];

function selectBuilder() {
  // The accounts routes call select().from(t).innerJoin().leftJoin().where().orderBy()
  // and select().from(t).leftJoin().leftJoin().where().orderBy(). We model each
  // by chaining through an object whose methods return the same builder; the
  // final await resolves the collected rows for the matching FROM table.
  const api: any = {
    from: vi.fn((table: any) => {
      let rows: any[] = [];
      if (table === customerPoItemsTbl) rows = sellRows;
      else if (table === customerPosTbl) rows = customerPoRows;
      else if (table === purchaseOrderItemsTbl) rows = buyRows;
      else if (table === purchaseOrdersTbl) rows = poRows;
      else if (table === taxSettingsTbl) rows = taxSettingsRow ? [taxSettingsRow] : [];
      else if (table === salesInvoicesTbl)
        rows = salesInvoiceRows.filter((r) => r.status === "posted");
      else if (table === supplierInvoicesTbl)
        rows = supplierInvoiceRows.filter((r) => r.status === "posted");
      else if (table === poChargesTbl) rows = poChargeRows;
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
  insert: vi.fn(() => ({
    values: vi.fn(() => chainable([{ id: 1 }], { returning: vi.fn(() => chainable([{ id: 1 }])) })),
  })),
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
  poItemChargesTable: poChargesTbl,
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
  taxSettingsRow = {
    id: 1,
    vatRate: "14",
    withholdingRate: "3",
    withholdingRateServices: "5",
    withholdingRatePurchases: "1",
  };
  sellRows = [];
  buyRows = [];
  poRows = [];
  customerPoRows = [];
  salesInvoiceRows = [];
  supplierInvoiceRows = [];
  poChargeRows = [];
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
      {
        id: 1,
        invoiceNo: "INV-2026-000001",
        customerName: "عميل أ",
        customerPoNo: "C-1",
        invoiceDate: "2026-08-01",
        netAmount: "1000",
        vatAmount: "140",
        grossAmount: "1140",
        status: "posted",
      },
    ];
    supplierInvoiceRows = [
      {
        id: 2,
        invoiceNo: "SI-2026-000001",
        supplierInvoiceNo: "S-1",
        supplierName: "مورد ب",
        poNo: "PO-1",
        invoiceDate: "2026-08-02",
        netAmount: "600",
        vatAmount: "84",
        grossAmount: "684",
        status: "posted",
      },
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
      {
        id: 2,
        invoiceNo: "SI-2026-000001",
        supplierInvoiceNo: "S-1",
        supplierName: "مورد ب",
        poNo: "PO-1",
        invoiceDate: "2026-08-02",
        netAmount: "1052.63",
        vatAmount: "147.37",
        grossAmount: "1200",
        status: "posted",
      },
    ];

    const res = await request(testApp).get("/api/accounts/vat");
    expect(res.status).toBe(200);
    expect(res.body.input.vat).toBeCloseTo(147.37, 1);
    expect(res.body.credit).toBeGreaterThan(0);
    expect(res.body.payable).toBe(0);
  });

  it("ignores draft/void invoices", async () => {
    salesInvoiceRows = [
      {
        id: 1,
        invoiceNo: "INV-DRAFT",
        customerName: "عميل أ",
        customerPoNo: null,
        invoiceDate: "2026-08-01",
        netAmount: "1000",
        vatAmount: "140",
        grossAmount: "1140",
        status: "draft",
      },
    ];
    supplierInvoiceRows = [];
    const res = await request(testApp).get("/api/accounts/vat");
    expect(res.status).toBe(200);
    expect(res.body.output.net).toBe(0);
    expect(res.body.input.net).toBe(0);
    expect(res.body.netVat).toBe(0);
  });

  it("separates evidenced input VAT from the non-VAT deficit (عجز ض.ق.م)", async () => {
    salesInvoiceRows = [
      {
        id: 1,
        invoiceNo: "INV-2026-000001",
        customerName: "عميل أ",
        customerPoNo: "C-1",
        invoiceDate: "2026-08-01",
        netAmount: "10000",
        vatAmount: "1400",
        grossAmount: "11400",
        status: "posted",
      },
    ];
    supplierInvoiceRows = [
      {
        id: 2,
        invoiceNo: "SI-2026-000001",
        supplierInvoiceNo: "S-1",
        supplierName: "مورد مسجل",
        poNo: "PO-1",
        invoiceDate: "2026-08-02",
        netAmount: "4000",
        vatAmount: "560",
        grossAmount: "4560",
        hasVat: true,
        status: "posted",
      },
      {
        id: 3,
        invoiceNo: "SI-2026-000002",
        supplierInvoiceNo: "S-2",
        supplierName: "مورد غير مسجل",
        poNo: "PO-2",
        invoiceDate: "2026-08-03",
        netAmount: "2000",
        vatAmount: "0",
        grossAmount: "2000",
        hasVat: false,
        status: "posted",
      },
    ];

    const res = await request(testApp).get("/api/accounts/vat");
    expect(res.status).toBe(200);
    // Evidenced input VAT = 560 only (the non-VAT supplier contributes none).
    expect(res.body.input.vat).toBe(560);
    expect(res.body.vatEvidence.evidencedInputVat).toBe(560);
    expect(res.body.vatEvidence.unevidencedNet).toBe(2000);
    // Deficit = 14% of the 2000 non-VAT purchases = 280.
    expect(res.body.vatEvidence.unevidencedInputVat).toBe(280);
    expect(res.body.vatEvidence.deficit).toBe(280);
    expect(res.body.vatEvidence.fullyEvidenced).toBe(false);
    // Net payable = 1400 − 560 = 840 (the deficit is absorbed, not deducted).
    expect(res.body.vatEvidence.netPayable).toBe(840);
  });
});

describe("GET /api/accounts/withholding", () => {
  it("withholds from posted supplier invoices and sums totals", async () => {
    supplierInvoiceRows = [
      {
        id: 1,
        invoiceNo: "SI-2026-000001",
        supplierInvoiceNo: "S-1",
        supplierName: "مورد ب",
        poNo: "PO-2026-000001",
        invoiceDate: "2026-08-01",
        netAmount: "1200",
        withholdingRate: "3",
        withholdingAmount: "36",
        grossAmount: "1368",
        status: "posted",
      },
      {
        id: 2,
        invoiceNo: "SI-2026-000002",
        supplierInvoiceNo: "S-2",
        supplierName: "مورد ج",
        poNo: "PO-2026-000002",
        invoiceDate: "2026-08-03",
        netAmount: "100",
        withholdingRate: "3",
        withholdingAmount: "3",
        grossAmount: "114",
        status: "posted",
      },
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

describe("GET /api/accounts/margins", () => {
  const baseRow = {
    customerPoId: 1,
    internalPoNo: "CPO-2026-000001",
    customerPoNo: "C-100",
    customerId: null,
    customerName: "عميل أ",
    storedCustomerName: null,
    poDate: "2026-08-01",
    poStatus: "sent",
    customerPoItemId: 11,
    lineItem: "1",
    partNo: "ABC-1",
    description: "بند",
    uom: "قطعة",
    sellQty: "10",
    sellUnitPrice: "100",
    deliveryStatus: "delivered",
    supplierPoId: 1,
    supplierPoItemId: 101,
    acceptedQty: "10",
    supplierLineStatus: "fulfilled",
  };

  it("strips VAT from a tax-inclusive supplier cost before computing the margin", async () => {
    taxSettingsRow = { id: 1, vatRate: "10", withholdingRate: "3" };
    // 110 tax-inclusive / 1.10 = 100 net per unit × 10 accepted = 1000 cost
    sellRows = [{ ...baseRow, finalActualCost: "110", supplierTaxIncluded: true } as any];
    const res = await request(testApp).get("/api/accounts/margins");
    expect(res.status).toBe(200);
    const line = res.body[0];
    expect(line.cost).toBe("1000");
    expect(line.margin).toBe("0");
    expect(line.isLoss).toBe(false);
    // VAT-inclusive raw cost was 1100; comparing it raw would have shown a loss.
    expect(line.finalActualCost).toBe("110");
  });

  it("keeps a tax-exclusive supplier cost untouched", async () => {
    sellRows = [{ ...baseRow, finalActualCost: "70", supplierTaxIncluded: false } as any];
    const res = await request(testApp).get("/api/accounts/margins");
    expect(res.status).toBe(200);
    const line = res.body[0];
    expect(line.cost).toBe("700"); // 70 × 10, no VAT to strip
    expect(line.margin).toBe("300");
    expect(line.isLoss).toBe(false);
  });
});

describe("GET /api/accounts/margins/summary", () => {
  it("normalizes tax-inclusive supplier cost so the order is not reported as a loss", async () => {
    taxSettingsRow = { id: 1, vatRate: "10", withholdingRate: "3" };
    sellRows = [
      {
        sellQty: "10",
        sellUnitPrice: "100",
        acceptedQty: "10",
        finalActualCost: "110",
        supplierTaxIncluded: true,
        supplierPoItemId: 101,
      } as any,
    ];
    const res = await request(testApp).get("/api/accounts/margins/summary");
    expect(res.status).toBe(200);
    expect(res.body.totalRevenue).toBe("1000");
    expect(res.body.totalCost).toBe("1000");
    expect(res.body.totalMargin).toBe("0");
    expect(res.body.lossLines).toBe(0);
  });

  it("folds in the cost of a received line that has no customer_po_item FK", async () => {
    // The customer-PO line has NO joined supplier line (customerPoItemId was
    // never persisted — the sheet-lookup case). Its cost must still be found
    // via the shared link ladder, or the profit reads as pure margin.
    customerPoRows = [{ id: 1, customerPoNo: "C-100" }];
    poRows = [{ id: 1, sheetPoNo: "C-100" }];
    sellRows = [
      {
        id: 11,
        customerPoId: 1,
        lineItem: "1",
        partNo: "ABC-1",
        description: null,
        customerPoItemId: 11,
        sellQty: "10",
        sellUnitPrice: "100",
        acceptedQty: null, // absent from the join
        finalActualCost: null,
        supplierTaxIncluded: null,
        supplierPoItemId: null, // no FK
      } as any,
    ];
    buyRows = [
      {
        id: 101,
        poId: 1,
        customerPoItemId: null,
        lineItem: "1",
        partNo: "ABC-1",
        description: null,
        totalAcceptedQty: "10",
        finalActualCost: "70",
        taxIncluded: false,
        lineStatus: "fulfilled",
      } as any,
    ];
    sellRows[0].customerPoNo = "C-100";

    const res = await request(testApp).get("/api/accounts/margins/summary");
    expect(res.status).toBe(200);
    expect(res.body.totalRevenue).toBe("1000");
    expect(res.body.totalCost).toBe("700"); // 10 × 70 found through the ladder
    expect(res.body.totalMargin).toBe("300");
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

// ── The single margin rule (tax.ts `marginOf`) ───────────────────────────────
// The margin formula is shared by /accounts/margins, /accounts/margins/summary
// and the analytics overview. These tests pin the RULE itself so a regression in
// one consumer cannot silently disagree with the others.
describe("marginOf — the shared realized-margin rule", () => {
  const line = (over: Partial<MarginInput> = {}): MarginInput => ({
    sellQty: 10,
    sellUnitPrice: 100,
    acceptedQty: 10,
    finalActualCost: 70,
    taxIncluded: false,
    ...over,
  });

  it("computes revenue, cost, margin and margin % on a realized line", () => {
    const r = marginOf(line(), 0);
    expect(r.revenue).toBe(1000);
    expect(r.cost).toBe(700);
    expect(r.margin).toBe(300);
    expect(r.marginPct).toBe(30);
    expect(r.isLoss).toBe(false);
  });

  it("strips VAT from a tax-inclusive cost before subtracting it", () => {
    // 110 gross / 1.10 = 100 net × 10 accepted = 1000; raw 1100 would be a false loss.
    const r = marginOf(line({ finalActualCost: 110, taxIncluded: true }), 10);
    expect(r.cost).toBe(1000);
    expect(r.margin).toBe(0);
    expect(r.isLoss).toBe(false);
  });

  it("has no cost until the supplier delivers (acceptedQty null)", () => {
    const r = marginOf(line({ acceptedQty: null }), 0);
    expect(r.cost).toBeNull();
    expect(r.margin).toBeNull();
    expect(r.marginPct).toBeNull();
    expect(r.isLoss).toBe(false);
  });

  it("folds PO line charges into the cost", () => {
    const r = marginOf(line({ charges: 150 }), 0);
    expect(r.cost).toBe(850);
    expect(r.margin).toBe(150);
  });

  it("flags a loss and never divides by a zero revenue", () => {
    const r = marginOf(line({ finalActualCost: 200 }), 0);
    expect(r.margin).toBe(-1000);
    expect(r.isLoss).toBe(true);
    const zero = marginOf(line({ sellUnitPrice: 0 }), 0);
    expect(zero.revenue).toBe(0);
    expect(zero.marginPct).toBeNull();
  });
});

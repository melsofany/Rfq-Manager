import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth ───────────────────────────────────────────────────────────────
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.session = req.session ?? {};
    req.session.employeeId = 7;
    next();
  },
}));

// ── Chainable + thenable DB mock ─────────────────────────────────────────────
function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

const customerPosTbl = "customerPos";
const customerPoItemsTbl = "customerPoItems";
const purchaseOrdersTbl = "purchaseOrders";
const purchaseOrderItemsTbl = "purchaseOrderItems";
const suppliersTbl = "suppliers";
const salesInvoicesTbl = "salesInvoices";
const supplierInvoicesTbl = "supplierInvoices";
const taxSettingsTbl = "taxSettings";
const poChargesTbl = "poCharges";

let taxSettingsRow: any | null;
let customerPoRows: any[];
let customerPoItemRows: any[];
let purchaseOrderRows: any[];
let purchaseOrderItemRows: any[];
let supplierRows: any[];
let salesInvoiceRows: any[];
let supplierInvoiceRows: any[];
let poChargeRows: any[];

function selectBuilder() {
  const api: any = {
    from: vi.fn((table: any) => {
      let rows: any[] = [];
      if (table === customerPosTbl) rows = customerPoRows;
      else if (table === customerPoItemsTbl) rows = customerPoItemRows;
      else if (table === purchaseOrdersTbl) rows = purchaseOrderRows;
      else if (table === purchaseOrderItemsTbl) rows = purchaseOrderItemRows;
      else if (table === suppliersTbl) rows = supplierRows;
      else if (table === salesInvoicesTbl)
        rows = salesInvoiceRows.filter((r) => r.status === "posted");
      else if (table === supplierInvoicesTbl)
        rows = supplierInvoiceRows.filter((r) => r.status === "posted");
      else if (table === taxSettingsTbl) rows = taxSettingsRow ? [taxSettingsRow] : [];
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
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  customerPosTable: customerPosTbl,
  customerPoItemsTable: customerPoItemsTbl,
  purchaseOrdersTable: purchaseOrdersTbl,
  purchaseOrderItemsTable: purchaseOrderItemsTbl,
  suppliersTable: suppliersTbl,
  salesInvoicesTable: salesInvoicesTbl,
  supplierInvoicesTable: supplierInvoicesTbl,
  taxSettingsTable: taxSettingsTbl,
  poItemChargesTable: poChargesTbl,
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: any, _b: any) => a,
  desc: (a: any) => a,
  sql: { template: { raw: (s: any) => s } },
}));

let testApp: express.Express;

beforeAll(async () => {
  const { default: ordersRouter } = await import("../../modules/accounts/orders");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { employeeId: 7 };
    next();
  });
  testApp.use("/api", ordersRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  taxSettingsRow = { id: 1, vatRate: "14" };
  customerPoRows = [];
  customerPoItemRows = [];
  purchaseOrderRows = [];
  purchaseOrderItemRows = [];
  supplierRows = [];
  salesInvoiceRows = [];
  supplierInvoiceRows = [];
  poChargeRows = [];
});

describe("GET /api/accounts/collected-orders", () => {
  it("includes only delivered/invoiced customer orders, not in-progress ones", async () => {
    customerPoRows = [
      {
        id: 1,
        internalPoNo: "CPO-2026-000001",
        customerPoNo: "C-100",
        customerName: "عميل أ",
        poDate: "2026-08-01",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
      {
        id: 2,
        internalPoNo: "CPO-2026-000002",
        customerPoNo: "C-200",
        customerName: "عميل ب",
        poDate: "2026-08-02",
        status: "draft",
        createdAt: new Date("2026-08-02"),
      },
    ];
    customerPoItemRows = [
      { id: 11, customerPoId: 1, qty: "10", unitPrice: "100", deliveryStatus: "delivered" },
      { id: 12, customerPoId: 1, qty: "5", unitPrice: "100", deliveryStatus: "delivered" },
      { id: 21, customerPoId: 2, qty: "3", unitPrice: "50", deliveryStatus: "pending" },
    ];
    // Realized cost for PO 1: 15 accepted × 60 = 900
    purchaseOrderItemRows = [
      { id: 101, poId: 1, customerPoItemId: 11, totalAcceptedQty: "10", finalActualCost: "60" },
      { id: 102, poId: 1, customerPoItemId: 12, totalAcceptedQty: "5", finalActualCost: "60" },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    expect(res.status).toBe(200);
    expect(res.body.customerOrders).toHaveLength(1);
    const o = res.body.customerOrders[0];
    expect(o.internalPoNo).toBe("CPO-2026-000001");
    // No posted invoice → net from items = 15 × 100 = 1500, VAT 14% = 210
    expect(o.net).toBe("1500");
    expect(o.vat).toBe("210");
    expect(o.gross).toBe("1710");
    expect(o.cost).toBe("900");
    expect(o.margin).toBe("600");
    expect(o.isLoss).toBe(false);
    expect(o.invoiceNo).toBeNull();
  });

  it("uses the posted sales invoice figures when one exists", async () => {
    customerPoRows = [
      {
        id: 1,
        internalPoNo: "CPO-2026-000001",
        customerPoNo: "C-100",
        customerName: "عميل أ",
        poDate: "2026-08-01",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    customerPoItemRows = [
      { id: 11, customerPoId: 1, qty: "10", unitPrice: "100", deliveryStatus: "pending" },
    ];
    salesInvoiceRows = [
      {
        id: 50,
        invoiceNo: "INV-2026-000001",
        customerPoId: 1,
        netAmount: "1000",
        vatAmount: "140",
        grossAmount: "1140",
        status: "posted",
      },
    ];
    purchaseOrderItemRows = [
      { id: 101, poId: 1, customerPoItemId: 11, totalAcceptedQty: "10", finalActualCost: "120" },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    expect(res.status).toBe(200);
    const o = res.body.customerOrders[0];
    expect(o.invoiceNo).toBe("INV-2026-000001");
    expect(o.net).toBe("1000");
    expect(o.vat).toBe("140");
    expect(o.cost).toBe("1200");
    // Loss: cost 1200 > net 1000
    expect(o.margin).toBe("-200");
    expect(o.isLoss).toBe(true);
  });

  it("fills the cost from the issued supplier PO price when nothing was received yet", async () => {
    customerPoRows = [
      {
        id: 1,
        internalPoNo: "CPO-2026-000001",
        customerPoNo: "C-100",
        customerName: "عميل أ",
        poDate: "2026-08-01",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    customerPoItemRows = [
      {
        id: 11,
        customerPoId: 1,
        lineItem: "1",
        partNo: "ABC-1",
        qty: "10",
        unitPrice: "100",
        deliveryStatus: "delivered",
      },
      {
        id: 12,
        customerPoId: 1,
        lineItem: "2",
        partNo: "ABC-2",
        qty: "5",
        unitPrice: "100",
        deliveryStatus: "delivered",
      },
    ];
    // Supplier PO dispatched but not received (no accepted qty / actual cost) and
    // its lines carry no customer_po_item FK — the reported "cost = 0" case.
    purchaseOrderRows = [
      {
        id: 1,
        internalPoNo: "PO-2026-000001",
        sheetPoNo: "C-100",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    purchaseOrderItemRows = [
      {
        id: 101,
        poId: 1,
        lineItem: "1",
        partNo: "ABC-1",
        customerPoItemId: null,
        totalAcceptedQty: null,
        finalActualCost: null,
        referencePrice: "60",
        lineStatus: "pending",
      },
      {
        id: 102,
        poId: 1,
        lineItem: "2",
        partNo: "ABC-2",
        customerPoItemId: null,
        totalAcceptedQty: null,
        finalActualCost: null,
        referencePrice: "60",
        lineStatus: "pending",
      },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    expect(res.status).toBe(200);
    const o = res.body.customerOrders[0];
    // 10 × 60 + 5 × 60 = 900 from the issued supplier PO price
    expect(o.cost).toBe("900");
    expect(o.costEstimated).toBe(true);
    expect(o.margin).toBe("600");
  });

  it("matches the supplier PO by its number when line ids differ", async () => {
    customerPoRows = [
      {
        id: 1,
        internalPoNo: "CPO-2026-000001",
        customerPoNo: "C-100",
        customerName: "عميل أ",
        poDate: "2026-08-01",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    customerPoItemRows = [
      {
        id: 11,
        customerPoId: 1,
        lineItem: "1",
        partNo: "ABC-1",
        qty: "4",
        unitPrice: "100",
        deliveryStatus: "delivered",
      },
    ];
    purchaseOrderRows = [
      {
        id: 1,
        internalPoNo: "PO-2026-000001",
        // Case-insensitive match against the customer PO number.
        sheetPoNo: "c-100",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    // The supplier line has a different lineItem but the same partNo.
    purchaseOrderItemRows = [
      {
        id: 101,
        poId: 1,
        lineItem: "9",
        partNo: "ABC-1",
        customerPoItemId: null,
        totalAcceptedQty: null,
        finalActualCost: null,
        referencePrice: "25",
        lineStatus: "pending",
      },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    const o = res.body.customerOrders[0];
    expect(o.cost).toBe("100");
    expect(o.costEstimated).toBe(true);
  });

  it("ignores cancelled or rejected supplier lines when estimating cost", async () => {
    customerPoRows = [
      {
        id: 1,
        internalPoNo: "CPO-2026-000001",
        customerPoNo: "C-100",
        customerName: "عميل أ",
        poDate: "2026-08-01",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    customerPoItemRows = [
      {
        id: 11,
        customerPoId: 1,
        lineItem: "1",
        qty: "10",
        unitPrice: "100",
        deliveryStatus: "delivered",
      },
    ];
    purchaseOrderRows = [
      {
        id: 1,
        internalPoNo: "PO-2026-000001",
        sheetPoNo: "C-100",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    purchaseOrderItemRows = [
      {
        id: 101,
        poId: 1,
        lineItem: "1",
        customerPoItemId: null,
        totalAcceptedQty: null,
        finalActualCost: null,
        referencePrice: "60",
        lineStatus: "cancelled",
      },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    const o = res.body.customerOrders[0];
    expect(o.cost).toBe("0");
    expect(o.costEstimated).toBe(false);
  });

  it("prefers the realized receipt cost over the supplier PO price", async () => {
    customerPoRows = [
      {
        id: 1,
        internalPoNo: "CPO-2026-000001",
        customerPoNo: "C-100",
        customerName: "عميل أ",
        poDate: "2026-08-01",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    customerPoItemRows = [
      {
        id: 11,
        customerPoId: 1,
        lineItem: "1",
        qty: "10",
        unitPrice: "100",
        deliveryStatus: "delivered",
      },
    ];
    purchaseOrderRows = [
      {
        id: 1,
        internalPoNo: "PO-2026-000001",
        sheetPoNo: "C-100",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    purchaseOrderItemRows = [
      {
        id: 101,
        poId: 1,
        lineItem: "1",
        customerPoItemId: 11,
        totalAcceptedQty: "10",
        finalActualCost: "70",
        referencePrice: "60",
        lineStatus: "fulfilled",
      },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    const o = res.body.customerOrders[0];
    // 10 × 70 realized, NOT 10 × 60 estimated
    expect(o.cost).toBe("700");
    expect(o.realizedCost).toBe("700");
    expect(o.estimatedCost).toBe("0");
    expect(o.costEstimated).toBe(false);
  });

  it("keeps realized and estimated cost separate when an order has both", async () => {
    customerPoRows = [
      {
        id: 1,
        internalPoNo: "CPO-2026-000001",
        customerPoNo: "C-100",
        customerName: "عميل أ",
        poDate: "2026-08-01",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    customerPoItemRows = [
      {
        id: 11,
        customerPoId: 1,
        lineItem: "1",
        qty: "10",
        unitPrice: "100",
        deliveryStatus: "delivered",
      },
      {
        id: 12,
        customerPoId: 1,
        lineItem: "2",
        qty: "5",
        unitPrice: "100",
        deliveryStatus: "delivered",
      },
    ];
    purchaseOrderRows = [
      {
        id: 1,
        internalPoNo: "PO-2026-000001",
        sheetPoNo: "C-100",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    purchaseOrderItemRows = [
      {
        id: 101,
        poId: 1,
        lineItem: "1",
        customerPoItemId: 11,
        totalAcceptedQty: "10",
        finalActualCost: "70",
        referencePrice: "60",
        lineStatus: "fulfilled",
      },
      {
        id: 102,
        poId: 1,
        lineItem: "2",
        customerPoItemId: null,
        totalAcceptedQty: null,
        finalActualCost: null,
        referencePrice: "60",
        lineStatus: "pending",
      },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    const o = res.body.customerOrders[0];
    // item 1: 10 × 70 realized; item 2: 5 × 60 estimated
    expect(o.realizedCost).toBe("700");
    expect(o.estimatedCost).toBe("300");
    expect(o.cost).toBe("1000");
    // net = 1500 → margin = 1500 − 1000
    expect(o.margin).toBe("500");
    // a partially realized order is not flagged as a pure estimate
    expect(o.costEstimated).toBe(false);
    expect(res.body.totals.realizedCost).toBe("700");
    expect(res.body.totals.estimatedCost).toBe("300");
  });

  it("includes a supplier order once received or invoiced, with cost + input VAT", async () => {
    purchaseOrderRows = [
      {
        id: 1,
        internalPoNo: "PO-2026-000001",
        sheetPoNo: "P26E1",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
      {
        id: 2,
        internalPoNo: "PO-2026-000002",
        sheetPoNo: "P26E2",
        status: "sent",
        createdAt: new Date("2026-08-02"),
      },
    ];
    supplierRows = [{ id: 9, name: "مورد أ" }];
    purchaseOrderItemRows = [
      {
        id: 201,
        poId: 1,
        supplierId: 9,
        lineStatus: "fulfilled",
        totalAcceptedQty: "10",
        finalActualCost: "60",
      },
      // PO 2 still pending, no receipt, no invoice → excluded
      {
        id: 202,
        poId: 2,
        supplierId: 9,
        lineStatus: "pending",
        totalAcceptedQty: null,
        finalActualCost: null,
      },
    ];
    supplierInvoiceRows = [
      {
        id: 70,
        invoiceNo: "SI-2026-000001",
        poId: 1,
        netAmount: "600",
        vatAmount: "84",
        hasVat: true,
        status: "posted",
      },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    expect(res.status).toBe(200);
    expect(res.body.supplierOrders).toHaveLength(1);
    const o = res.body.supplierOrders[0];
    expect(o.internalPoNo).toBe("PO-2026-000001");
    expect(o.supplierNames).toEqual(["مورد أ"]);
    expect(o.cost).toBe("600");
    expect(o.invoiceNet).toBe("600");
    expect(o.invoiceVat).toBe("84");
    expect(o.hasVat).toBe(true);
  });

  it("flags a non-VAT supplier order (hasVat false → VAT deficit)", async () => {
    purchaseOrderRows = [
      {
        id: 1,
        internalPoNo: "PO-2026-000001",
        sheetPoNo: "P26E1",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    supplierRows = [{ id: 9, name: "مورد غير مسجل" }];
    purchaseOrderItemRows = [
      {
        id: 201,
        poId: 1,
        supplierId: 9,
        lineStatus: "fulfilled",
        totalAcceptedQty: "10",
        finalActualCost: "60",
      },
    ];
    supplierInvoiceRows = [
      {
        id: 70,
        invoiceNo: "SI-2026-000001",
        poId: 1,
        netAmount: "600",
        vatAmount: "0",
        hasVat: false,
        status: "posted",
      },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    const o = res.body.supplierOrders[0];
    expect(o.hasVat).toBe(false);
    expect(o.invoiceVat).toBe("0");
  });

  it("aggregates totals across customer orders", async () => {
    customerPoRows = [
      {
        id: 1,
        internalPoNo: "CPO-1",
        customerPoNo: "C-1",
        customerName: "أ",
        poDate: "2026-08-01",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    customerPoItemRows = [
      { id: 11, customerPoId: 1, qty: "10", unitPrice: "100", deliveryStatus: "delivered" },
    ];
    purchaseOrderItemRows = [
      { id: 101, poId: 1, customerPoItemId: 11, totalAcceptedQty: "10", finalActualCost: "70" },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    expect(res.body.totals.customerOrders).toBe(1);
    expect(res.body.totals.net).toBe("1000");
    expect(res.body.totals.cost).toBe("700");
    expect(res.body.totals.margin).toBe("300");
    expect(res.body.totals.marginPct).toBe("30");
  });

  // The selling price is VAT-exclusive, a `taxIncluded` supplier price is not,
  // so the estimate must strip the embedded 14% before comparing the two —
  // otherwise a profitable order reports a loss (the live P26E12299 case).
  it("strips VAT from a tax-inclusive supplier price before estimating cost", async () => {
    customerPoRows = [
      {
        id: 1,
        internalPoNo: "CPO-2026-000214",
        customerPoNo: "P26E12299",
        customerName: "EDC",
        poDate: "2026-08-20",
        status: "sent",
        createdAt: new Date("2026-08-20"),
      },
    ];
    customerPoItemRows = [
      {
        id: 2181,
        customerPoId: 1,
        lineItem: "2211.008.GENRAL.7565",
        partNo: "A9R81440",
        qty: "10",
        unitPrice: "4750",
        deliveryStatus: "delivered",
      },
    ];
    purchaseOrderRows = [
      {
        id: 31,
        internalPoNo: "PO-2026-000024",
        sheetPoNo: "P26E12299",
        status: "sent",
        createdAt: new Date("2026-08-20"),
      },
    ];
    purchaseOrderItemRows = [
      {
        id: 57,
        poId: 31,
        lineItem: "2211.008.GENRAL.7565",
        partNo: "A9R81440",
        customerPoItemId: null,
        totalAcceptedQty: null,
        finalActualCost: null,
        referencePrice: "4775",
        taxIncluded: true,
        lineStatus: "pending",
      },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    expect(res.status).toBe(200);
    const o = res.body.customerOrders[0];
    // 4775 / 1.14 = 4188.5965 per unit × 10 = 41885.9649 → 41885.96
    expect(o.cost).toBe("41885.96");
    expect(o.costEstimated).toBe(true);
    expect(o.net).toBe("47500");
    // A profitable order must never be reported as a loss.
    expect(o.margin).toBe("5614.04");
    expect(o.isLoss).toBe(false);
  });

  it("leaves a VAT-exclusive supplier price untouched when estimating cost", async () => {
    customerPoRows = [
      {
        id: 1,
        internalPoNo: "CPO-2026-000001",
        customerPoNo: "C-100",
        customerName: "عميل أ",
        poDate: "2026-08-01",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    customerPoItemRows = [
      {
        id: 11,
        customerPoId: 1,
        lineItem: "1",
        partNo: "ABC-1",
        qty: "10",
        unitPrice: "100",
        deliveryStatus: "delivered",
      },
    ];
    purchaseOrderRows = [
      {
        id: 1,
        internalPoNo: "PO-2026-000001",
        sheetPoNo: "C-100",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    purchaseOrderItemRows = [
      {
        id: 101,
        poId: 1,
        lineItem: "1",
        partNo: "ABC-1",
        customerPoItemId: null,
        totalAcceptedQty: null,
        finalActualCost: null,
        referencePrice: "60",
        taxIncluded: false,
        lineStatus: "pending",
      },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    const o = res.body.customerOrders[0];
    expect(o.cost).toBe("600"); // 60 × 10, no VAT to strip
    expect(o.margin).toBe("400");
    expect(o.isLoss).toBe(false);
  });

  it("uses the configured VAT rate when stripping tax from the supplier price", async () => {
    taxSettingsRow = { id: 1, vatRate: "10" };
    customerPoRows = [
      {
        id: 1,
        internalPoNo: "CPO-2026-000001",
        customerPoNo: "C-100",
        customerName: "عميل أ",
        poDate: "2026-08-01",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    customerPoItemRows = [
      {
        id: 11,
        customerPoId: 1,
        lineItem: "1",
        partNo: "ABC-1",
        qty: "1",
        unitPrice: "100",
        deliveryStatus: "delivered",
      },
    ];
    purchaseOrderRows = [
      {
        id: 1,
        internalPoNo: "PO-2026-000001",
        sheetPoNo: "C-100",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    purchaseOrderItemRows = [
      {
        id: 101,
        poId: 1,
        lineItem: "1",
        partNo: "ABC-1",
        customerPoItemId: null,
        totalAcceptedQty: null,
        finalActualCost: null,
        referencePrice: "110",
        taxIncluded: true,
        lineStatus: "pending",
      },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    // 110 / 1.10 = 100 — the rate comes from tax_settings, not a hardcoded 14.
    expect(res.body.customerOrders[0].cost).toBe("100");
  });

  it("uses the configured VAT rate when computing realized cost from tax-inclusive supplier price", async () => {
    taxSettingsRow = { id: 1, vatRate: "10" };
    customerPoRows = [
      {
        id: 1,
        internalPoNo: "CPO-2026-000001",
        customerPoNo: "C-100",
        customerName: "عميل أ",
        poDate: "2026-08-01",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    customerPoItemRows = [
      {
        id: 11,
        customerPoId: 1,
        lineItem: "1",
        partNo: "ABC-1",
        qty: "10",
        unitPrice: "100",
        deliveryStatus: "delivered",
      },
    ];
    purchaseOrderRows = [
      {
        id: 1,
        internalPoNo: "PO-2026-000001",
        sheetPoNo: "C-100",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    // Supplier has taxInclusive price, receipt actual cost entered as tax-inclusive amount
    purchaseOrderItemRows = [
      {
        id: 101,
        poId: 1,
        customerPoItemId: 11,
        totalAcceptedQty: "10",
        finalActualCost: "110", // VAT-inclusive amount entered by operator
        taxIncluded: true,
        lineStatus: "fulfilled",
      },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    const o = res.body.customerOrders[0];
    // 110 / 1.10 = 100 per unit (VAT-exclusive cost) × 10 = 1000
    expect(o.cost).toBe("1000");
    expect(o.net).toBe("1000"); // 100 × 10
    expect(o.margin).toBe("0"); // 1000 - 1000 = 0
    expect(o.isLoss).toBe(false);
  });

  it("computes realized cost correctly for VAT-exclusive supplier price", async () => {
    customerPoRows = [
      {
        id: 1,
        internalPoNo: "CPO-2026-000001",
        customerPoNo: "C-100",
        customerName: "عميل أ",
        poDate: "2026-08-01",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    customerPoItemRows = [
      {
        id: 11,
        customerPoId: 1,
        lineItem: "1",
        partNo: "ABC-1",
        qty: "10",
        unitPrice: "100",
        deliveryStatus: "delivered",
      },
    ];
    purchaseOrderRows = [
      {
        id: 1,
        internalPoNo: "PO-2026-000001",
        sheetPoNo: "C-100",
        status: "sent",
        createdAt: new Date("2026-08-01"),
      },
    ];
    // Supplier has taxExclusive price, receipt actual cost entered as VAT-exclusive amount
    purchaseOrderItemRows = [
      {
        id: 101,
        poId: 1,
        customerPoItemId: 11,
        totalAcceptedQty: "10",
        finalActualCost: "70", // VAT-exclusive amount entered by operator
        taxIncluded: false,
        lineStatus: "fulfilled",
      },
    ];

    const res = await request(testApp).get("/api/accounts/collected-orders");
    const o = res.body.customerOrders[0];
    expect(o.cost).toBe("700"); // 70 × 10, no VAT to strip
    expect(o.margin).toBe("300"); // Wait, let me calculate: net = 1000, cost = 700, margin = 300
    expect(o.margin).toBe("300");
    expect(o.isLoss).toBe(false);
  });
});

describe("GET /api/accounts/po-charges", () => {
  it("lists PO line charges with their PO/supplier and groups by type", async () => {
    poChargeRows = [
      {
        id: 1,
        poId: 1,
        poItemId: 101,
        chargeType: "نقل",
        description: "نقل من المخزن",
        amount: "150",
        createdAt: new Date("2026-08-01"),
        internalPoNo: "PO-2026-000001",
        sheetPoNo: "P26E1",
        supplierId: 9,
        supplierName: "مورد أ",
        lineItem: "1",
        partNo: "ABC-1",
      },
      {
        id: 2,
        poId: 1,
        poItemId: 101,
        chargeType: "جمارك",
        description: null,
        amount: "50",
        createdAt: new Date("2026-08-02"),
        internalPoNo: "PO-2026-000001",
        sheetPoNo: "P26E1",
        supplierId: 9,
        supplierName: "مورد أ",
        lineItem: "1",
        partNo: "ABC-1",
      },
    ];

    const res = await request(testApp).get("/api/accounts/po-charges");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe("200");
    expect(res.body.count).toBe(2);
    expect(res.body.byType).toEqual([
      { type: "نقل", amount: "150" },
      { type: "جمارك", amount: "50" },
    ]);
    expect(res.body.charges[0].supplierName).toBe("مورد أ");
  });

  it("returns zero totals when no charges exist", async () => {
    const res = await request(testApp).get("/api/accounts/po-charges");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe("0");
    expect(res.body.count).toBe(0);
    expect(res.body.byType).toEqual([]);
  });
});

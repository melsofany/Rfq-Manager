import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../shared/email", () => ({
  verifyEmailConnection: vi.fn().mockResolvedValue({ ok: true }),
  sendRfqEmail: vi.fn().mockResolvedValue({ ok: true }),
  sendOfferConfirmation: vi.fn().mockResolvedValue({ ok: true }),
  sendPoEmail: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../shared/google-sheets", () => ({
  lookupPoFromSheet: vi.fn().mockResolvedValue([]),
  listSheetPoNumbers: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../modules/communications/routes", () => ({
  applyReceiptSideEffects: vi.fn().mockResolvedValue(undefined),
  applyDeliverySideEffects: vi.fn().mockResolvedValue(undefined),
  broadcastWaEvent: vi.fn(),
}));

vi.mock("../../modules/communications/service", () => ({
  sendPoWhatsApp: vi.fn(),
  isWhatsAppConfigured: false,
  formatQty: (q: any) => q,
}));

vi.mock("../../modules/po/po-pdf", () => ({
  generatePoPdf: vi.fn().mockResolvedValue(Buffer.from("")),
}));

const tables = {
  purchaseOrdersTable: { _: "po" },
  purchaseOrderItemsTable: { _: "poItems" },
  suppliersTable: { _: "suppliers" },
  employeesTable: { _: "employees" },
  auditLogTable: { _: "audit" },
  offersTable: { _: "offers" },
  offerItemsTable: { _: "offerItems" },
  rfqItemsTable: { _: "rfqItems" },
  whatsappChatsTable: { _: "wa" },
  rfqTable: { _: "rfq" },
};

let selectQueue: any[] = [];

function chainableThenable(rows: any): any {
  const api: any = {
    from: vi.fn(() => api),
    leftJoin: vi.fn(() => api),
    innerJoin: vi.fn(() => api),
    where: vi.fn(() => chainableThenable(rows)),
    limit: vi.fn(() => chainableThenable(rows)),
    orderBy: vi.fn(() => chainableThenable(rows)),
    then: (resolve: any) => Promise.resolve(rows).then(resolve),
  };
  return api;
}

const dbMock: any = {
  select: vi.fn(() => chainableThenable(selectQueue.shift() ?? [])),
};

vi.mock("@workspace/db", () => ({
  ...tables,
  db: dbMock,
}));

let testApp: express.Express;

beforeAll(async () => {
  const { default: poRouter } = await import("../../modules/po/index");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { employeeId: 1 };
    next();
  });
  testApp.use("/api", poRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue = [];
});

describe("GET /api/po/supplier-price — quoted price + tax flag", () => {
  it("returns the quote with taxIncluded=true when the offer included tax", async () => {
    selectQueue.push([{ price: "114.0000", taxIncluded: true }]);
    const res = await request(testApp)
      .get("/api/po/supplier-price")
      .query({ supplierId: "5", description: "Widget" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ price: 114, taxIncluded: true });
  });

  it("returns taxIncluded=false when the offer excluded tax", async () => {
    selectQueue.push([{ price: "100.0000", taxIncluded: false }]);
    const res = await request(testApp)
      .get("/api/po/supplier-price")
      .query({ supplierId: "5", description: "Widget" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ price: 100, taxIncluded: false });
  });

  it("falls back to partNo and still reports the tax flag", async () => {
    selectQueue.push([]);
    selectQueue.push([{ price: "57.5000", taxIncluded: true }]);
    const res = await request(testApp)
      .get("/api/po/supplier-price")
      .query({ supplierId: "5", description: "Widget", partNo: "W-1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ price: 57.5, taxIncluded: true });
  });

  it("returns no price and taxIncluded=false when no quote is found", async () => {
    selectQueue.push([]);
    selectQueue.push([]);
    const res = await request(testApp)
      .get("/api/po/supplier-price")
      .query({ supplierId: "5", description: "Widget", partNo: "W-1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ price: null, taxIncluded: false });
  });
});

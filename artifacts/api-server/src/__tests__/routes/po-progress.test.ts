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
  sendPoWhatsApp: vi.fn().mockResolvedValue("supplier-wa-id"),
  isWhatsAppConfigured: false,
  sendRepresentativeWorkOrderWhatsApp: vi.fn().mockResolvedValue({ ok: true }),
  sendRepresentativeItemReceiptWhatsApp: vi.fn().mockResolvedValue("rep-wa-id"),
  sendRepPoDispatchWhatsApp: vi.fn().mockResolvedValue("rep-wa-id"),
  sendPoCancelWhatsApp: vi.fn().mockResolvedValue("cancel-wa-id"),
  formatQty: (q: any) => (q == null ? null : String(q).replace(/0+$/, "").replace(/\.$/, "") || "0"),
}));

vi.mock("../../modules/po/po-pdf", () => ({
  generatePoPdf: vi.fn().mockResolvedValue(Buffer.from("")),
}));

function thenable<T>(value: T, extra: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, v] of Object.entries(extra)) obj[k] = v;
  return obj;
}

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
  workOrderAssignmentsTable: { _: "woa", poItemId: "poItemId" },
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
    groupBy: vi.fn(() => chainableThenable(rows)),
    then: (resolve: any) => Promise.resolve(rows).then(resolve),
  };
  return api;
}

const dbMock: any = {
  select: vi.fn(() => chainableThenable(selectQueue.shift() ?? [])),
  update: vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => thenable(undefined)) })),
  })),
  delete: vi.fn(() => ({
    where: vi.fn(() => thenable(undefined)),
  })),
  insert: vi.fn((table?: any) => ({
    values: vi.fn(() => thenable(undefined)),
  })),
};

vi.mock("@workspace/db", () => ({
  ...tables,
  db: dbMock,
  WORK_ORDER_KIND: { RECEIPT: "receipt", DELIVERY: "delivery" },
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

describe("GET /api/po/progress — receivable lines + suppliers", () => {
  it("counts receivable lines (supplier-assigned, non-cancelled) per PO", async () => {
    selectQueue.push([
      { poId: 1, lineStatus: "pending", supplierId: null, supplierName: null },
      { poId: 1, lineStatus: "pending", supplierId: 5, supplierName: "مورد أ" },
      { poId: 1, lineStatus: "fulfilled", supplierId: 5, supplierName: "مورد أ" },
      { poId: 1, lineStatus: "rejected", supplierId: 7, supplierName: "مورد ب" },
      { poId: 1, lineStatus: "cancelled", supplierId: 5, supplierName: "مورد أ" },
    ]);
    const res = await request(testApp).get("/api/po/progress");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        poId: 1,
        total: 4,
        received: 1,
        rejected: 1,
        receivable: 3,
        receivableReceived: 1,
        suppliers: ["مورد أ", "مورد ب"],
      },
    ]);
  });

  it("falls back to supplier #id when the supplier name is missing", async () => {
    selectQueue.push([
      { poId: 2, lineStatus: "pending", supplierId: 9, supplierName: null },
    ]);
    const res = await request(testApp).get("/api/po/progress");
    expect(res.status).toBe(200);
    expect(res.body[0].suppliers).toEqual(["#9"]);
    expect(res.body[0].receivable).toBe(1);
  });

  it("omits a PO whose lines are all cancelled", async () => {
    selectQueue.push([
      { poId: 3, lineStatus: "cancelled", supplierId: 5, supplierName: "مورد أ" },
    ]);
    const res = await request(testApp).get("/api/po/progress");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("marks fulfilled supplier lines as receivableReceived", async () => {
    selectQueue.push([
      { poId: 4, lineStatus: "fulfilled", supplierId: 5, supplierName: "مورد أ" },
      { poId: 4, lineStatus: "fulfilled", supplierId: 7, supplierName: "مورد ب" },
    ]);
    const res = await request(testApp).get("/api/po/progress");
    expect(res.status).toBe(200);
    expect(res.body[0].receivable).toBe(2);
    expect(res.body[0].receivableReceived).toBe(2);
  });
});

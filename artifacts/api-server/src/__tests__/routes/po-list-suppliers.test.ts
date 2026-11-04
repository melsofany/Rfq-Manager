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
  formatQty: (q: any) => (q == null ? null : String(q)),
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
    set: vi.fn(() => ({ where: vi.fn(() => chainableThenable(undefined)) })),
  })),
  delete: vi.fn(() => ({ where: vi.fn(() => chainableThenable(undefined)) })),
  insert: vi.fn(() => ({ values: vi.fn(() => chainableThenable(undefined)) })),
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
    req.session = { employeeId: 1, role: "admin" };
    next();
  });
  testApp.use("/api", poRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue = [];
});

const poRow = (id: number) => ({
  po: {
    id,
    internalPoNo: `PO-2026-00000${id}`,
    sheetPoNo: `P26E0000${id}`,
    receiverName: "مندوب",
    receiverPhone: "201000000000",
    status: "sent",
    employeeId: 1,
    notes: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  },
  employeeName: "أحمد",
});

/**
 * The /purchase-orders list shows a «الموردون» column, so each row must name the
 * suppliers of that PO — resolved in ONE batched query for the whole page, not
 * one query per row (the list is the busiest screen in the app).
 */
describe("GET /api/po — suppliers per purchase order", () => {
  it("returns each supplier once, with its id and name", async () => {
    selectQueue.push([poRow(1)]);
    selectQueue.push([{ poId: 1, cnt: 3 }]);
    selectQueue.push([
      { poId: 1, supplierId: 5, supplierName: "مورد أ" },
      { poId: 1, supplierId: 5, supplierName: "مورد أ" },
      { poId: 1, supplierId: 7, supplierName: "مورد ب" },
    ]);

    const res = await request(testApp).get("/api/po");
    expect(res.status).toBe(200);
    expect(res.body[0].suppliers).toEqual([
      { id: 5, name: "مورد أ" },
      { id: 7, name: "مورد ب" },
    ]);
    // item count is preserved alongside the new field
    expect(res.body[0].itemCount).toBe(3);
  });

  it("falls back to #id when the supplier row is missing", async () => {
    selectQueue.push([poRow(2)]);
    selectQueue.push([]);
    selectQueue.push([{ poId: 2, supplierId: 9, supplierName: null }]);

    const res = await request(testApp).get("/api/po");
    expect(res.status).toBe(200);
    expect(res.body[0].suppliers).toEqual([{ id: 9, name: "#9" }]);
  });

  it("ignores lines with no supplier (manual rows)", async () => {
    selectQueue.push([poRow(3)]);
    selectQueue.push([]);
    selectQueue.push([{ poId: 3, supplierId: null, supplierName: null }]);

    const res = await request(testApp).get("/api/po");
    expect(res.status).toBe(200);
    expect(res.body[0].suppliers).toEqual([]);
  });

  it("returns an empty list when a PO has no items at all", async () => {
    selectQueue.push([poRow(4)]);
    selectQueue.push([]);
    selectQueue.push([]);

    const res = await request(testApp).get("/api/po");
    expect(res.status).toBe(200);
    expect(res.body[0].suppliers).toEqual([]);
  });

  it("keeps each PO's suppliers separate", async () => {
    selectQueue.push([poRow(1), poRow(2)]);
    selectQueue.push([
      { poId: 1, cnt: 1 },
      { poId: 2, cnt: 2 },
    ]);
    selectQueue.push([
      { poId: 1, supplierId: 5, supplierName: "مورد أ" },
      { poId: 2, supplierId: 7, supplierName: "مورد ب" },
      { poId: 2, supplierId: 8, supplierName: "مورد ج" },
    ]);

    const res = await request(testApp).get("/api/po");
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.map((r: any) => [r.id, r.suppliers]));
    expect(byId[1]).toEqual([{ id: 5, name: "مورد أ" }]);
    expect(byId[2]).toEqual([
      { id: 7, name: "مورد ب" },
      { id: 8, name: "مورد ج" },
    ]);
  });
});

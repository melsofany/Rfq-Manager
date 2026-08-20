import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth + side-effectful modules ─────────────────────────────────────
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

const sendPoCancelMock = vi.fn().mockResolvedValue("cancel-wa-id");
let _whatsappConfigured = true;

vi.mock("../../modules/communications/routes", () => ({
  applyReceiptSideEffects: vi.fn().mockResolvedValue(undefined),
  applyDeliverySideEffects: vi.fn().mockResolvedValue(undefined),
  broadcastWaEvent: vi.fn(),
}));

vi.mock("../../modules/communications/service", () => ({
  sendPoWhatsApp: vi.fn().mockResolvedValue("supplier-wa-id"),
  get isWhatsAppConfigured() {
    return _whatsappConfigured;
  },
  sendRepresentativeWorkOrderWhatsApp: vi.fn().mockResolvedValue({ ok: true }),
  sendRepresentativeItemReceiptWhatsApp: vi.fn().mockResolvedValue("rep-wa-id"),
  sendRepPoDispatchWhatsApp: vi.fn().mockResolvedValue("rep-wa-id"),
  sendPoCancelWhatsApp: sendPoCancelMock,
  formatQty: (q: any) => (q == null ? null : String(q).replace(/0+$/, "").replace(/\.$/, "") || "0"),
}));

vi.mock("../../modules/po/po-pdf", () => ({
  generatePoPdf: vi.fn().mockResolvedValue(Buffer.from("")),
}));

// ── Configurable chainable DB mock ────────────────────────────────────────
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

// Queue of result-sets returned by successive db.select(...).where() calls.
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

const insertCalls: any[] = [];
const updateSets: any[] = [];
const deleteWheres: any[] = [];
const txOps: { updates: any[]; deletes: any[]; inserts: any[] } = { updates: [], deletes: [], inserts: [] };

const dbMock: any = {
  select: vi.fn(() => chainableThenable(selectQueue.shift() ?? [])),
  update: vi.fn(() => ({
    set: vi.fn((vals: any) => {
      updateSets.push(vals);
      const setApi = { where: vi.fn(() => thenable(undefined)) };
      return setApi;
    }),
  })),
  delete: vi.fn(() => ({
    where: vi.fn((...args: any[]) => {
      deleteWheres.push(args);
      return thenable(undefined);
    }),
  })),
  insert: vi.fn((table?: any) => ({
    values: vi.fn((vals: any) => {
      insertCalls.push({ table: table?._, vals });
      return thenable(undefined);
    }),
  })),
  transaction: vi.fn(async (cb: any) => {
    const tx = {
      update: vi.fn(() => ({
        set: vi.fn((vals: any) => {
          txOps.updates.push(vals);
          return { where: vi.fn(() => thenable(undefined)) };
        }),
      })),
      delete: vi.fn(() => ({
        where: vi.fn((...args: any[]) => {
          txOps.deletes.push(args);
          return thenable(undefined);
        }),
      })),
      insert: vi.fn((table?: any) => ({
        values: vi.fn((vals: any) => {
          txOps.inserts.push({ table: table?._, vals });
          return thenable(undefined);
        }),
      })),
    };
    return await cb(tx);
  }),
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
  insertCalls.length = 0;
  updateSets.length = 0;
  deleteWheres.length = 0;
  txOps.updates.length = 0;
  txOps.deletes.length = 0;
  txOps.inserts.length = 0;
  _whatsappConfigured = true;
});

describe("POST /api/po/:id/cancel — per-supplier cancellation", () => {
  it("returns 400 when supplierId is missing", async () => {
    const res = await request(testApp).post("/api/po/1/cancel").send({ reason: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/المورد/);
  });

  it("returns 404 when the PO does not exist", async () => {
    selectQueue = [[]];
    const res = await request(testApp).post("/api/po/999/cancel").send({ supplierId: 7 });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 400 when the PO is still a draft", async () => {
    selectQueue = [[{ id: 1, internalPoNo: "PO-2025-000001", status: "draft" }]];
    const res = await request(testApp).post("/api/po/1/cancel").send({ supplierId: 7 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Draft/i);
  });

  it("returns 404 when the supplier does not exist", async () => {
    selectQueue = [
      [{ id: 1, internalPoNo: "PO-2025-000001", status: "sent" }], // poRow
      [], // supplier lookup → empty
    ];
    const res = await request(testApp).post("/api/po/1/cancel").send({ supplierId: 99 });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/المورد/);
  });

  it("returns 400 when the supplier has no items in this PO", async () => {
    selectQueue = [
      [{ id: 1, internalPoNo: "PO-2025-000001", status: "sent" }],
      [{ id: 7, name: "Acme", phone: "201111111111", contactPerson: null, email: null }],
      [], // no items for supplier 7
    ];
    const res = await request(testApp).post("/api/po/1/cancel").send({ supplierId: 7 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/لا توجد بنود/);
  });

  it("returns 400 when any of the supplier's lines was already received/delivered", async () => {
    // One line is already fulfilled (received via WhatsApp bot) → cancel blocked.
    selectQueue = [
      [{ id: 1, internalPoNo: "PO-2025-000001", status: "sent" }],
      [{ id: 7, name: "Acme", phone: "201111111111", contactPerson: null, email: null }],
      [{ id: 10, lineStatus: "fulfilled" }, { id: 11, lineStatus: "pending" }],
    ];
    const res = await request(testApp).post("/api/po/1/cancel").send({ supplierId: 7 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/تم استلام أو تسليم/);
    // Nothing cancelled — no WhatsApp, no audit, no transaction.
    expect(sendPoCancelMock).not.toHaveBeenCalled();
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("cancels one supplier's lines only (other supplier stays active)", async () => {
    // poRow, supplier(7), items-for-7 (2 items), all-items (7's 2 + supplier-8's 2).
    selectQueue = [
      [{ id: 1, internalPoNo: "PO-2025-000001", status: "sent" }],
      [{ id: 7, name: "Acme", phone: "201111111111", contactPerson: "Hassan", email: null }],
      [{ id: 10, lineStatus: "pending" }, { id: 11, lineStatus: "pending" }], // supplier 7's items
      [
        { id: 10, lineStatus: "pending", supplierId: 7 },
        { id: 11, lineStatus: "pending", supplierId: 7 },
        { id: 20, lineStatus: "pending", supplierId: 8 }, // other supplier — stays active
        { id: 21, lineStatus: "pending", supplierId: 8 },
      ],
    ];

    const res = await request(testApp)
      .post("/api/po/1/cancel")
      .send({ supplierId: 7, reason: "إلغاء بناءً على طلب العميل" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      id: 1,
      poStatus: "sent", // NOT cancelled — supplier 8 still has active lines
    });
    expect(res.body.cancelledSupplier).toMatchObject({ id: 7, name: "Acme" });
    expect(res.body.cancelledItemIds).toEqual([10, 11]);

    // WhatsApp sent to supplier 7 only (not supplier 8).
    expect(sendPoCancelMock).toHaveBeenCalledTimes(1);
    expect(sendPoCancelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        poNo: "PO-2025-000001",
        supplierName: "Acme",
        contactPerson: "Hassan",
        reason: "إلغاء بناءً على طلب العميل",
      }),
    );
    // One outbound chat record for supplier 7.
    expect(insertCalls.filter((c) => c.table === "wa")).toHaveLength(1);

    // Transaction: 1 items-update (cancelled), 1 assignments-delete, NO po-status
    // update (supplier 8 still active), 1 audit insert.
    expect(dbMock.transaction).toHaveBeenCalled();
    expect(txOps.updates).toHaveLength(1);
    expect(txOps.updates[0]).toMatchObject({
      lineStatus: "cancelled",
      totalReceivedQty: null,
      totalAcceptedQty: null,
      totalRejectedQty: null,
      finalActualCost: null,
    });
    expect(txOps.deletes).toHaveLength(1); // work_order_assignments for items 10,11
    expect(txOps.inserts.find((c) => c.table === "audit")).toBeTruthy();
    expect(txOps.inserts.find((c) => c.table === "audit").vals.action).toBe("po.supplier_cancelled");
  });

  it("flips the whole PO to cancelled when the supplier was the LAST active one", async () => {
    selectQueue = [
      [{ id: 1, internalPoNo: "PO-2025-000002", status: "sent" }],
      [{ id: 7, name: "Acme", phone: "201111111111", contactPerson: null, email: null }],
      [{ id: 10, lineStatus: "pending" }],
      [{ id: 10, lineStatus: "pending", supplierId: 7 }], // only supplier 7 → all cancelled
    ];

    const res = await request(testApp)
      .post("/api/po/1/cancel")
      .send({ supplierId: 7, reason: null });

    expect(res.status).toBe(200);
    expect(res.body.poStatus).toBe("cancelled");
    // Default reason applied inside sendPoCancelWhatsApp; route passes null.
    expect(sendPoCancelMock).toHaveBeenCalledTimes(1);
    expect(sendPoCancelMock.mock.calls[0][0].reason).toBeNull();
    // PO-status update WAS issued this time.
    expect(txOps.updates).toHaveLength(2); // items + po-status
    const poUpdate = txOps.updates[1];
    expect(poUpdate).toMatchObject({ status: "cancelled" });
  });

  it("does not send WhatsApp when not configured (still cancels the supplier)", async () => {
    _whatsappConfigured = false;
    selectQueue = [
      [{ id: 1, internalPoNo: "PO-2025-000003", status: "sent" }],
      [{ id: 7, name: "Acme", phone: "201111111111", contactPerson: null, email: null }],
      [{ id: 10, lineStatus: "pending" }],
      [{ id: 10, lineStatus: "pending", supplierId: 7 }],
    ];
    const res = await request(testApp).post("/api/po/1/cancel").send({ supplierId: 7 });
    expect(res.status).toBe(200);
    expect(res.body.cancelledSupplier.id).toBe(7);
    expect(sendPoCancelMock).not.toHaveBeenCalled();
    expect(res.body.whatsapp).toMatchObject({ whatsappSent: false });
    expect(res.body.whatsapp.whatsappError).toMatch(/not configured/i);
    // Still audited.
    expect(txOps.inserts.find((c) => c.table === "audit")).toBeTruthy();
  });

  it("skips WhatsApp when the supplier has no phone number", async () => {
    selectQueue = [
      [{ id: 1, internalPoNo: "PO-2025-000004", status: "sent" }],
      [{ id: 7, name: "NoPhone", phone: null, contactPerson: null, email: null }],
      [{ id: 10, lineStatus: "pending" }],
      [{ id: 10, lineStatus: "pending", supplierId: 7 }],
    ];
    const res = await request(testApp).post("/api/po/1/cancel").send({ supplierId: 7 });
    expect(res.status).toBe(200);
    expect(sendPoCancelMock).not.toHaveBeenCalled();
    expect(res.body.whatsapp.whatsappError).toMatch(/No phone/);
  });

  it("still cancels the supplier even if a WhatsApp send throws", async () => {
    sendPoCancelMock.mockRejectedValueOnce(new Error("Meta 503"));
    selectQueue = [
      [{ id: 1, internalPoNo: "PO-2025-000005", status: "sent" }],
      [{ id: 7, name: "Acme", phone: "201111111111", contactPerson: null, email: null }],
      [{ id: 10, lineStatus: "pending" }],
      [{ id: 10, lineStatus: "pending", supplierId: 7 }],
    ];
    const res = await request(testApp).post("/api/po/1/cancel").send({ supplierId: 7 });
    expect(res.status).toBe(200);
    expect(res.body.cancelledSupplier.id).toBe(7);
    expect(res.body.whatsapp).toMatchObject({ whatsappSent: false });
    expect(res.body.whatsapp.whatsappError).toMatch(/Meta 503/);
  });

  it("returns 400 when the PO is already cancelled", async () => {
    selectQueue = [[{ id: 1, internalPoNo: "PO-2025-000006", status: "cancelled" }]];
    const res = await request(testApp).post("/api/po/1/cancel").send({ supplierId: 7 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ملغي/);
  });
});


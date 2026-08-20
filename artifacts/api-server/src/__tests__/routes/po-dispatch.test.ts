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

const sendPoWhatsAppMock = vi.fn().mockResolvedValue("supplier-wa-id");
const sendRepDispatchMock = vi.fn().mockResolvedValue("rep-wa-id");
// `isWhatsAppConfigured` is a const boolean in the real module, so the mock
// must expose a value (not a function — a function ref is always truthy).
// A getter lets tests flip it per-case.
let _whatsappConfigured = true;

vi.mock("../../modules/communications/routes", () => ({
  applyReceiptSideEffects: vi.fn().mockResolvedValue(undefined),
  applyDeliverySideEffects: vi.fn().mockResolvedValue(undefined),
  broadcastWaEvent: vi.fn(),
}));

vi.mock("../../modules/communications/service", () => ({
  sendPoWhatsApp: sendPoWhatsAppMock,
  get isWhatsAppConfigured() {
    return _whatsappConfigured;
  },
  sendRepresentativeWorkOrderWhatsApp: vi.fn().mockResolvedValue({ ok: true }),
  sendRepresentativeItemReceiptWhatsApp: vi.fn().mockResolvedValue("rep-wa-id"),
  sendRepPoDispatchWhatsApp: sendRepDispatchMock,
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
  whatsappChatsTable: { _: "wa" },
  workOrderAssignmentsTable: { _: "woa" },
};

// Queue of result-sets returned by successive db.select(...).where() calls.
let selectQueue: any[] = [];

// A thenable that is also chainable for `.limit()` / `.orderBy()` — drizzle's
// query builders can be awaited at any point in the chain.
function chainableThenable(rows: any): any {
  const api: any = {
    from: vi.fn(() => api),
    leftJoin: vi.fn(() => api),
    where: vi.fn(() => chainableThenable(rows)),
    limit: vi.fn(() => chainableThenable(rows)),
    orderBy: vi.fn(() => chainableThenable(rows)),
    then: (resolve: any) => Promise.resolve(rows).then(resolve),
  };
  return api;
}

function selectChain(rows: any) {
  return chainableThenable(rows);
}

const insertCalls: any[] = [];

const dbMock: any = {
  select: vi.fn(() => selectChain(selectQueue.shift() ?? [])),
  update: vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => thenable(undefined)) })),
  })),
  insert: vi.fn((table?: any) => ({
    values: vi.fn((vals: any) => {
      insertCalls.push({ table: table?._, vals });
      return thenable(undefined);
    }),
  })),
  transaction: vi.fn(async (cb: any) => cb(dbMock)),
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
  _whatsappConfigured = true;
});

describe("POST /api/po/:id/dispatch — consolidated rep receipt notification", () => {
  it("sends ONE consolidated receipt notification per supplier + creates a kind=receipt assignment per pending item", async () => {
    const poRow = {
      po: {
        id: 1,
        internalPoNo: "CPO-2025-000001",
        createdAt: new Date("2025-01-01"),
        receiverName: "Ahmed",
        receiverPhone: "201000000000",
        notes: null,
        status: "draft",
        employeeId: null,
      },
      employeeName: "Sara",
      employeePhone: null,
    };
    const itemRows = [
      {
        item: {
          id: 10,
          lineItem: "1",
          description: "Widget",
          qty: "5.0000",
          uom: "pcs",
          lineStatus: "pending",
          supplierId: 7,
        },
        supplier: {
          id: 7,
          name: "Acme",
          phone: "201111111111",
          email: "acme@example.com",
          contactPerson: "Hassan",
          address: "Cairo",
        },
      },
      {
        item: {
          id: 11,
          lineItem: "2",
          description: "Gadget",
          qty: "3.5000",
          uom: "pcs",
          lineStatus: "pending",
          supplierId: 7,
        },
        supplier: { id: 7, name: "Acme", phone: "201111111111", email: "", contactPerson: null, address: null },
      },
    ];
    selectQueue = [[poRow], itemRows];

    const res = await request(testApp).post("/api/po/1/dispatch");

    expect(res.status).toBe(200);
    expect(res.body.workOrderSent).toBe(true);
    // ONE consolidated message per supplier (both items share supplier 7).
    expect(sendRepDispatchMock).toHaveBeenCalledTimes(1);
    expect(sendRepDispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        poNo: "CPO-2025-000001",
        supplierName: "Acme",
        supplierAddress: "Cairo",
        supplierPhone: "201111111111",
      }),
    );
    // Both pending items included with clean quantities ("5", "3.5").
    const call = sendRepDispatchMock.mock.calls[0][0];
    expect(call.items).toHaveLength(2);
    expect(call.items[0]).toMatchObject({ description: "Widget", qty: "5" });
    expect(call.items[1]).toMatchObject({ description: "Gadget", qty: "3.5" });
    // Two work-order assignments inserted (one per pending item), kind=receipt.
    const woaInserts = insertCalls.filter((c) => c.table === "woa");
    expect(woaInserts).toHaveLength(2);
    expect(woaInserts[0].vals).toMatchObject({ poId: 1, poItemId: 10, kind: "receipt", status: "sent" });
    expect(woaInserts[1].vals).toMatchObject({ poId: 1, poItemId: 11, kind: "receipt", status: "sent" });
    expect(woaInserts[0].vals.representativeName).toBe("Ahmed");
    // Phone normalized (no leading +).
    expect(woaInserts[0].vals.representativePhone).toBe("201000000000");
  });

  it("does not send rep prompts when WhatsApp is not configured", async () => {
    _whatsappConfigured = false;
    selectQueue = [
      [
        {
          po: {
            id: 1,
            internalPoNo: "CPO-2025-000002",
            createdAt: new Date("2025-01-01"),
            receiverName: "Ahmed",
            receiverPhone: "201000000000",
            notes: null,
            status: "draft",
            employeeId: null,
          },
          employeeName: null,
          employeePhone: null,
        },
      ],
      [
        {
          item: { id: 20, lineItem: "1", description: "X", qty: "1", lineStatus: "pending", supplierId: 7 },
          supplier: { id: 7, name: "Acme", phone: "201111111111", email: "", contactPerson: null, address: null },
        },
      ],
    ];

    const res = await request(testApp).post("/api/po/1/dispatch");

    expect(res.status).toBe(200);
    expect(res.body.workOrderSent).toBe(false);
    expect(sendRepDispatchMock).not.toHaveBeenCalled();
    expect(insertCalls.filter((c) => c.table === "woa")).toHaveLength(0);
  });

  it("skips items already fulfilled/rejected when building the rep notification", async () => {
    selectQueue = [
      [
        {
          po: {
            id: 1,
            internalPoNo: "CPO-2025-000003",
            createdAt: new Date("2025-01-01"),
            receiverName: "Ahmed",
            receiverPhone: "201000000000",
            notes: null,
            status: "draft",
            employeeId: null,
          },
          employeeName: null,
          employeePhone: null,
        },
      ],
      [
        {
          item: { id: 30, lineItem: "1", description: "Done", qty: "2", lineStatus: "fulfilled", supplierId: 7 },
          supplier: { id: 7, name: "Acme", phone: "201111111111", email: "", contactPerson: null, address: null },
        },
        {
          item: { id: 31, lineItem: "2", description: "Open", qty: "4", lineStatus: "pending", supplierId: 7 },
          supplier: { id: 7, name: "Acme", phone: "201111111111", email: "", contactPerson: null, address: null },
        },
      ],
    ];

    const res = await request(testApp).post("/api/po/1/dispatch");

    expect(res.status).toBe(200);
    expect(res.body.workOrderSent).toBe(true);
    // Only the pending item is included.
    expect(sendRepDispatchMock).toHaveBeenCalledTimes(1);
    const call = sendRepDispatchMock.mock.calls[0][0];
    expect(call.items).toHaveLength(1);
    expect(call.items[0]).toMatchObject({ description: "Open" });
    // Only one assignment for the pending item.
    const woaInserts = insertCalls.filter((c) => c.table === "woa");
    expect(woaInserts).toHaveLength(1);
    expect(woaInserts[0].vals).toMatchObject({ poItemId: 31 });
  });

  it("returns 404 when the PO does not exist", async () => {
    selectQueue = [[]];
    const res = await request(testApp).post("/api/po/999/dispatch");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

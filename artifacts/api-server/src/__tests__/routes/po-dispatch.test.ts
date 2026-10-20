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
  formatQty: (q: any) =>
    q == null ? null : String(q).replace(/0+$/, "").replace(/\.$/, "") || "0",
}));

vi.mock("../../modules/po/po-pdf", () => ({
  generatePoPdf: vi.fn().mockResolvedValue(Buffer.from("")),
}));

// The registration gate: dispatch must call into the registration module for a
// supplier with incomplete data, and must NOT send the PO to that supplier.
const createRegistrationMock = vi.fn().mockResolvedValue({
  requestId: 1,
  token: "tok",
  url: "https://example.com/s/tok",
  reused: false,
  missingFields: ["bankName"],
  whatsappSent: true,
  whatsappError: null,
  emailSent: true,
  emailError: null,
});
vi.mock("../../modules/users/supplier-registration", () => ({
  createRegistrationRequest: (...a: any[]) => createRegistrationMock(...a),
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
          commercialRegister: "12345",
          taxRegistration: "67890",
          bankName: "NBE",
          bankAccountHolder: "Acme Co",
          bankAccountNumber: "1234567890",
          iban: "EG380019000500000000263180002",
          swiftCode: "NBEGEGCX",
          bankBranch: "Cairo",
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
        supplier: {
          id: 7,
          name: "Acme",
          phone: "201111111111",
          email: "",
          contactPerson: null,
          address: null,
          commercialRegister: "12345",
          taxRegistration: "67890",
          bankName: "NBE",
          bankAccountHolder: "Acme Co",
          bankAccountNumber: "1234567890",
          iban: "EG380019000500000000263180002",
          swiftCode: "NBEGEGCX",
          bankBranch: "Cairo",
        },
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
    expect(woaInserts[0].vals).toMatchObject({
      poId: 1,
      poItemId: 10,
      kind: "receipt",
      status: "sent",
    });
    expect(woaInserts[1].vals).toMatchObject({
      poId: 1,
      poItemId: 11,
      kind: "receipt",
      status: "sent",
    });
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
          item: {
            id: 20,
            lineItem: "1",
            description: "X",
            qty: "1",
            lineStatus: "pending",
            supplierId: 7,
          },
          supplier: {
            id: 7,
            name: "Acme",
            phone: "201111111111",
            email: "",
            contactPerson: null,
            address: null,
            commercialRegister: "12345",
            taxRegistration: "67890",
            bankName: "NBE",
            bankAccountHolder: "Acme Co",
            bankAccountNumber: "1234567890",
            iban: "EG380019000500000000263180002",
            swiftCode: "NBEGEGCX",
            bankBranch: "Cairo",
          },
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
          item: {
            id: 30,
            lineItem: "1",
            description: "Done",
            qty: "2",
            lineStatus: "fulfilled",
            supplierId: 7,
          },
          supplier: {
            id: 7,
            name: "Acme",
            phone: "201111111111",
            email: "",
            contactPerson: null,
            address: null,
            commercialRegister: "12345",
            taxRegistration: "67890",
            bankName: "NBE",
            bankAccountHolder: "Acme Co",
            bankAccountNumber: "1234567890",
            iban: "EG380019000500000000263180002",
            swiftCode: "NBEGEGCX",
            bankBranch: "Cairo",
          },
        },
        {
          item: {
            id: 31,
            lineItem: "2",
            description: "Open",
            qty: "4",
            lineStatus: "pending",
            supplierId: 7,
          },
          supplier: {
            id: 7,
            name: "Acme",
            phone: "201111111111",
            email: "",
            contactPerson: null,
            address: null,
            commercialRegister: "12345",
            taxRegistration: "67890",
            bankName: "NBE",
            bankAccountHolder: "Acme Co",
            bankAccountNumber: "1234567890",
            iban: "EG380019000500000000263180002",
            swiftCode: "NBEGEGCX",
            bankBranch: "Cairo",
          },
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

describe("POST /api/po/:id/dispatch — the supplier-registration gate", () => {
  const basePoRow = {
    po: {
      id: 1,
      internalPoNo: "CPO-2025-000009",
      createdAt: new Date("2025-01-01"),
      receiverName: null,
      receiverPhone: null,
      notes: null,
      status: "draft",
      employeeId: null,
    },
    employeeName: null,
    employeePhone: null,
  };

  const unregisteredSupplier = {
    id: 7,
    name: "Acme",
    phone: "201111111111",
    email: "acme@example.com",
    contactPerson: "Hassan",
    address: "Cairo",
    // No bank data at all — this is the supplier the PO must NOT reach.
    commercialRegister: null,
    taxRegistration: null,
    bankName: null,
    bankAccountHolder: null,
    bankAccountNumber: null,
    iban: null,
    swiftCode: null,
    bankBranch: null,
  };

  it("withholds the PO and sends a registration link instead when the supplier has no bank data", async () => {
    selectQueue = [
      [basePoRow],
      [
        {
          item: {
            id: 40,
            lineItem: "1",
            description: "Widget",
            qty: "5",
            lineStatus: "pending",
            supplierId: 7,
          },
          supplier: unregisteredSupplier,
        },
      ],
    ];

    const res = await request(testApp).post("/api/po/1/dispatch");

    expect(res.status).toBe(200);
    // The PO was NOT sent...
    expect(sendPoWhatsAppMock).not.toHaveBeenCalled();
    // ...the registration link was.
    expect(createRegistrationMock).toHaveBeenCalledTimes(1);
    expect(createRegistrationMock).toHaveBeenCalledWith(
      expect.objectContaining({ supplierId: 7, poId: 1 }),
    );
    // The supplier is told a purchase order was issued for HIM — the clause
    // carries the REAL PO number, not a generic phrase.
    const regArg = createRegistrationMock.mock.calls[0][0];
    expect(regArg.documentLabel).toBe("أمر شراء رقم CPO-2025-000009");
    expect(res.body.results[0]).toMatchObject({
      registrationRequired: true,
      whatsappSent: true,
      emailSent: true,
    });
    expect(res.body.registrationWithheld).toBe(1);
    // A registration link is not a PO: the PO must NOT be marked "sent".
    expect(res.body.poDelivered).toBe(false);
    // The rep is not queued to collect an order that was never issued.
    expect(sendRepDispatchMock).not.toHaveBeenCalled();
  });

  it("sends the PO normally once the supplier's data is complete", async () => {
    selectQueue = [
      [basePoRow],
      [
        {
          item: {
            id: 41,
            lineItem: "1",
            description: "Widget",
            qty: "5",
            lineStatus: "pending",
            supplierId: 7,
          },
          supplier: {
            ...unregisteredSupplier,
            commercialRegister: "12345",
            taxRegistration: "67890",
            bankName: "NBE",
            bankAccountHolder: "Acme Co",
            bankAccountNumber: "1234567890",
            iban: "EG380019000500000000263180002",
            swiftCode: "NBEGEGCX",
            bankBranch: "Cairo",
          },
        },
      ],
    ];

    const res = await request(testApp).post("/api/po/1/dispatch");

    expect(res.status).toBe(200);
    expect(createRegistrationMock).not.toHaveBeenCalled();
    expect(sendPoWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(res.body.results[0].registrationRequired).toBe(false);
    expect(res.body.poDelivered).toBe(true);
  });
});

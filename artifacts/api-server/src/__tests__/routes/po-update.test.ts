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

vi.mock("../../modules/communications/service", () => ({
  sendPoWhatsApp: vi.fn().mockResolvedValue({ ok: true }),
  isWhatsAppConfigured: vi.fn().mockReturnValue(false),
  sendRepresentativeWorkOrderWhatsApp: vi.fn().mockResolvedValue({ ok: true }),
  sendRepresentativeItemReceiptWhatsApp: vi.fn().mockResolvedValue("wa-id"),
}));

vi.mock("../../modules/po/po-pdf", () => ({
  generatePoPdf: vi.fn().mockResolvedValue(Buffer.from("")),
}));

// ── Configurable chainable DB mock ────────────────────────────────────────
// A thenable that also exposes extra chain methods (e.g. .returning()).
function thenable<T>(value: T, extra: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, v] of Object.entries(extra)) obj[k] = v;
  return obj;
}

// Tables just need to be truthy references used by .from() / eq().
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
  workOrderAssignmentsTable: { _: "woa" },
};

// State injected into the mock per-test.
let existingPoRow: any | null;
let updatedPoRow: any;
let itemCountRow: { cnt: number };

function selectChain(arg: any) {
  const api: any = {
    from: vi.fn(() => api),
    where: vi.fn(() => {
      // count() query passes a {cnt: count()} object as select arg
      if (arg && typeof arg === "object" && "cnt" in arg) {
        return thenable([itemCountRow]);
      }
      return thenable(existingPoRow ? [existingPoRow] : []);
    }),
  };
  return api;
}

const dbMock: any = {
  select: vi.fn((arg: any) => selectChain(arg)),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => thenable([updatedPoRow])),
      })),
    })),
  })),
  delete: vi.fn(() => ({
    where: vi.fn(() => thenable(undefined)),
  })),
  insert: vi.fn(() => ({
    values: vi.fn(() => thenable(undefined)),
  })),
  transaction: vi.fn(async (cb: any) => cb(dbMock)),
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
  // Provide req.log + req.session so the route's audit logging works without real middleware.
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { employeeId: 1 };
    next();
  });
  testApp.use("/api", poRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  existingPoRow = null;
  updatedPoRow = {
    id: 1,
    internalPoNo: "CPO-2025-000001",
    sheetPoNo: "PO-100",
    receiverName: "Ahmed",
    receiverPhone: "0100",
    status: "draft",
    employeeId: null,
    rfqId: null,
    notes: "n",
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-02"),
  };
  itemCountRow = { cnt: 2 };
});

const validBody = {
  sheetPoNo: "PO-100",
  receiverName: "Ahmed",
  receiverPhone: "0100",
  notes: "updated notes",
  employeeId: null,
  items: [{ description: "Widget", qty: 5, referencePrice: 10, supplierId: null }],
};

describe("PUT /api/po/:id (draft-only update)", () => {
  it("returns 404 when the PO does not exist", async () => {
    existingPoRow = null;
    const res = await request(testApp).put("/api/po/999").send(validBody);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 400 when the PO is not a draft (sent)", async () => {
    existingPoRow = { ...updatedPoRow, status: "sent" };
    const res = await request(testApp).put("/api/po/1").send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Draft/);
  });

  it("returns 400 when sheetPoNo is missing", async () => {
    existingPoRow = { ...updatedPoRow };
    const res = await request(testApp).put("/api/po/1").send({ ...validBody, sheetPoNo: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sheetPoNo/);
  });

  it("returns 400 when there are no valid items", async () => {
    existingPoRow = { ...updatedPoRow };
    const res = await request(testApp)
      .put("/api/po/1")
      .send({ ...validBody, items: [{ description: "   " }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/item/i);
  });

  it("updates a draft PO and returns 200 with the updated shape", async () => {
    existingPoRow = { ...updatedPoRow };
    const res = await request(testApp).put("/api/po/1").send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
    expect(res.body.sheetPoNo).toBe("PO-100");
    expect(res.body.status).toBe("draft");
    expect(res.body.itemCount).toBe(2);
    // transaction must have run (items deleted + re-inserted)
    expect(dbMock.transaction).toHaveBeenCalled();
  });
});

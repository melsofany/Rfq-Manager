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
  workOrderAssignmentsTable: { _: "woa" },
};

let existingPoRow: any | null;

function selectChain() {
  return {
    from: vi.fn(() => selectChain()),
    where: vi.fn(() => thenable(existingPoRow ? [existingPoRow] : [])),
  };
}

const dbMock: any = {
  select: vi.fn(() => selectChain()),
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
});

describe("DELETE /api/po/:id (draft-only delete)", () => {
  it("returns 404 when the PO does not exist", async () => {
    existingPoRow = null;
    const res = await request(testApp).delete("/api/po/999");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 400 when the PO is not a draft (sent)", async () => {
    existingPoRow = {
      id: 1,
      internalPoNo: "CPO-2025-000001",
      sheetPoNo: "PO-100",
      status: "sent",
    };
    const res = await request(testApp).delete("/api/po/1");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Draft/);
  });

  it("deletes a draft PO within a transaction and returns 200", async () => {
    existingPoRow = {
      id: 1,
      internalPoNo: "CPO-2025-000001",
      sheetPoNo: "PO-100",
      status: "draft",
    };
    const res = await request(testApp).delete("/api/po/1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: 1 });
    // Transaction must have run with deletes for items, assignments, and the PO itself.
    expect(dbMock.transaction).toHaveBeenCalled();
    expect(dbMock.delete).toHaveBeenCalledTimes(3);
  });
});

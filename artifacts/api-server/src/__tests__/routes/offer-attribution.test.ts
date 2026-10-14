import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Chainable + thenable DB mock ─────────────────────────────────────────────
function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

const sentLogTbl = {
  _: "sentLog",
  token: "token",
  rfqId: "rfqId",
  supplierId: "supplierId",
  employeeId: "employeeId",
  id: "id",
};
const rfqTbl = { _: "rfq", id: "id", status: "status", expiresAt: "expiresAt" };
const suppliersTbl = { _: "suppliers" };
const offersTbl = { _: "offers", rfqId: "rfqId", supplierId: "supplierId", id: "id" };
const offerItemsTbl = { _: "offerItems" };
const rfqItemsTbl = { _: "rfqItems" };
const auditTbl = { _: "audit" };

// Per-test state.
let sentLogRow: any;
let rfqRow: any;
let existingOfferRow: any | null;
const insertedOffers: any[] = [];
const offerUpdates: any[] = [];

const dbMock: any = {
  select: vi.fn(() => ({
    from: vi.fn((table: any) => {
      if (table === sentLogTbl) {
        const rows = [{ log: sentLogRow, rfq: rfqRow, supplier: {} }];
        const withWhere = () => chainable(rows, { where: vi.fn(() => chainable(rows)) });
        return chainable(rows, {
          leftJoin: vi.fn(() => withWhere()),
          where: vi.fn(() => chainable(rows)),
        });
      }
      if (table === offersTbl) {
        return chainable(existingOfferRow ? [existingOfferRow] : [], {
          where: vi.fn(() =>
            chainable(existingOfferRow ? [existingOfferRow] : [], {
              orderBy: vi.fn(() =>
                chainable(existingOfferRow ? [existingOfferRow] : [], {
                  limit: vi.fn(() => chainable(existingOfferRow ? [existingOfferRow] : [])),
                }),
              ),
            }),
          ),
        });
      }
      return chainable([], {
        where: vi.fn(() => chainable([])),
      });
    }),
  })),
  insert: vi.fn((table: any) => ({
    values: vi.fn((vals: any) => {
      if (table === offersTbl) {
        insertedOffers.push(vals);
        return { returning: vi.fn(() => chainable([{ id: 999, ...vals }])) };
      }
      return chainable(undefined);
    }),
  })),
  update: vi.fn(() => ({
    set: vi.fn((vals: any) => {
      offerUpdates.push(vals);
      return { where: vi.fn(() => chainable(undefined)) };
    }),
  })),
  delete: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  sentLogTable: sentLogTbl,
  rfqTable: rfqTbl,
  suppliersTable: suppliersTbl,
  offersTable: offersTbl,
  offerItemsTable: offerItemsTbl,
  rfqItemsTable: rfqItemsTbl,
  auditLogTable: auditTbl,
}));

let testApp: express.Express;

beforeAll(async () => {
  const { default: pricingRouter } = await import("../../modules/rfq/pricing");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { employeeId: 7, role: "employee" };
    next();
  });
  testApp.use("/api", pricingRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  insertedOffers.length = 0;
  offerUpdates.length = 0;
  rfqRow = { id: 3, status: "SENT", expiresAt: null };
  sentLogRow = {
    id: 55,
    token: "tok-1",
    rfqId: 3,
    supplierId: 9,
    employeeId: 42,
    closeDate: null,
  };
  existingOfferRow = null;
});

describe("POST /api/pricing/:token/submit — «من أحضر السعر»", () => {
  it("stamps the SENDING employee on the new offer (offers.employee_id)", async () => {
    const res = await request(testApp)
      .post("/api/pricing/tok-1/submit")
      .send({ items: [{ rfqItemId: 50, price: 12.5 }] });
    expect(res.status).toBe(201);
    expect(insertedOffers.length).toBe(1);
    // The owner is the employee recorded on the sent-log row — never client input.
    expect(insertedOffers[0].employeeId).toBe(42);
    expect(insertedOffers[0].sentLogId).toBe(55);
  });

  it("keeps the sending employee when the supplier REVISES an offer", async () => {
    existingOfferRow = {
      id: 88,
      rfqId: 3,
      supplierId: 9,
      employeeId: 42,
    };
    const res = await request(testApp)
      .post("/api/pricing/tok-1/submit")
      .send({ items: [{ rfqItemId: 50, price: 11 }] });
    expect(res.status).toBe(201);
    // Revision path: no new insert; the UPDATE carries the employee id.
    expect(insertedOffers.length).toBe(0);
    const set = offerUpdates.find((u) => "employeeId" in u);
    expect(set?.employeeId).toBe(42);
  });

  it("falls back to null when the sent-log has no employee", async () => {
    sentLogRow = { ...sentLogRow, employeeId: null };
    const res = await request(testApp)
      .post("/api/pricing/tok-1/submit")
      .send({ items: [{ rfqItemId: 50, price: 9 }] });
    expect(res.status).toBe(201);
    expect(insertedOffers[0].employeeId).toBe(null);
  });
});

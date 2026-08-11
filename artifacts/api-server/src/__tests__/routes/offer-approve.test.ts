import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth ───────────────────────────────────────────────────────────────
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

// ── Chainable + thenable DB mock ─────────────────────────────────────────────
function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

const offersTbl = { _: "offers" };
const suppliersTbl = { _: "suppliers" };
const offerItemsTbl = { _: "offerItems", rfqItemId: "rfqItemId", isApproved: "isApproved" };
const rfqItemsTbl = { _: "rfqItems" };
const auditTbl = { _: "audit" };

// Per-test state for the approve route.
let offerItemRow: any | null;
let lastUpdates: Array<{ id: number; set: any; whereTable: string }>;

const dbMock: any = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      leftJoin: vi.fn(() => chainable([])),
      where: vi.fn(() => chainable([])),
    })),
  })),
  insert: vi.fn((table: any) => ({
    values: vi.fn(() => (table === auditTbl ? chainable(undefined) : chainable(undefined))),
  })),
  update: vi.fn((table: any) => ({
    set: vi.fn((vals: any) => {
      lastUpdates.push({ id: -1, set: vals, whereTable: table._ });
      return {
        where: vi.fn(() => chainable(undefined)),
      };
    }),
  })),
};

// The approve route reads an offer_item by id via select().from(offerItems).where().
// Override select() to return the per-test offerItemRow for that path.
dbMock.select = vi.fn(() => ({
  from: vi.fn((table: any) => {
    if (table === offerItemsTbl) {
      return chainable(offerItemRow ? [offerItemRow] : [], {
        where: vi.fn(() => chainable(offerItemRow ? [offerItemRow] : [])),
      });
    }
    return chainable([], { leftJoin: vi.fn(() => chainable([])), where: vi.fn(() => chainable([])) });
  }),
}));

vi.mock("@workspace/db", () => ({
  db: dbMock,
  offersTable: offersTbl,
  suppliersTable: suppliersTbl,
  offerItemsTable: offerItemsTbl,
  rfqItemsTable: rfqItemsTbl,
  auditLogTable: auditTbl,
}));

let testApp: express.Express;

beforeAll(async () => {
  const { default: offersRouter } = await import("../../modules/rfq/offers");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { employeeId: 7, role: "employee" };
    next();
  });
  testApp.use("/api", offersRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  offerItemRow = { id: 100, rfqItemId: 50, price: "10.0000", taxIncluded: false, isApproved: false };
  lastUpdates = [];
});

describe("PATCH /api/offers/items/:offerItemId/approve", () => {
  it("approves an offer item and un-approves the previous approved item for the same rfq_item", async () => {
    const res = await request(testApp)
      .patch("/api/offers/items/100/approve")
      .send({ approved: true });
    expect(res.status).toBe(200);
    expect(res.body.isApproved).toBe(true);
    // Two updates: first un-approves existing approved for the rfq_item, second sets this one true.
    const approvedUpdates = lastUpdates.filter((u) => u.set.isApproved === true);
    expect(approvedUpdates.length).toBe(1);
    const clearedUpdates = lastUpdates.filter((u) => u.set.isApproved === false);
    expect(clearedUpdates.length).toBeGreaterThanOrEqual(1);
  });

  it("un-approves an offer item when approved=false", async () => {
    offerItemRow = { ...offerItemRow, isApproved: true };
    const res = await request(testApp)
      .patch("/api/offers/items/100/approve")
      .send({ approved: false });
    expect(res.status).toBe(200);
    expect(res.body.isApproved).toBe(false);
    expect(lastUpdates.some((u) => u.set.isApproved === false)).toBe(true);
    // Should NOT have set anything to true when un-approving.
    expect(lastUpdates.some((u) => u.set.isApproved === true)).toBe(false);
  });

  it("defaults to approved=true when body is empty", async () => {
    const res = await request(testApp).patch("/api/offers/items/100/approve").send({});
    expect(res.status).toBe(200);
    expect(res.body.isApproved).toBe(true);
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await request(testApp).patch("/api/offers/items/abc/approve").send({ approved: true });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the offer item does not exist", async () => {
    offerItemRow = null;
    const res = await request(testApp).patch("/api/offers/items/999/approve").send({ approved: true });
    expect(res.status).toBe(404);
  });
});

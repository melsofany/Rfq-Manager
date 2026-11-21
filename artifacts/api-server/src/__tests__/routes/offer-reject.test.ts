/**
 * Buyer rejection of a supplier price (PATCH /offers/items/:id/reject) and the
 * guard that stops a rejected price from being approved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  item: null as any,
  updates: [] as any[],
  audits: [] as any[],
}));

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../shared/permissions", () => ({
  guardFor: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  and: (...args: any[]) => ({ __op: "and", args }),
}));
vi.mock("@workspace/db", () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(state.item ? [state.item] : []),
      }),
    }),
    update: () => ({
      set: (vals: any) => ({
        where: () => {
          state.updates.push(vals);
          return Promise.resolve();
        },
      }),
    }),
    insert: () => ({
      values: (vals: any) => {
        state.audits.push(vals);
        return Promise.resolve();
      },
    }),
  };
  return {
    db,
    offersTable: {},
    suppliersTable: {},
    offerItemsTable: { id: "id", rfqItemId: "rfqItemId", isApproved: "isApproved" },
    rfqItemsTable: {},
    auditLogTable: {},
  };
});

let testApp: express.Express;

beforeEach(async () => {
  state.item = { id: 5, rfqItemId: 9, rejectedAt: null, isApproved: true };
  state.updates = [];
  state.audits = [];
  vi.resetModules();
  const mod = await import("../../modules/rfq/offers");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.session = { employeeId: 7 };
    next();
  });
  testApp.use("/api", mod.default);
});

describe("PATCH /offers/items/:id/reject", () => {
  it("rejects a price when a reason is given, and withdraws its approval", async () => {
    const res = await request(testApp)
      .patch("/api/offers/items/5/reject")
      .send({ rejected: true, reason: "  السعر أعلى من المرجع  " });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 5,
      isRejected: true,
      rejectionReason: "السعر أعلى من المرجع",
    });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].rejectedAt).toBeInstanceOf(Date);
    expect(state.updates[0].rejectedBy).toBe(7);
    expect(state.updates[0].rejectionReason).toBe("السعر أعلى من المرجع");
    expect(state.updates[0].isApproved).toBe(false);
    expect(state.audits[0].action).toBe("offer_item.rejection_toggled");
  });

  it("refuses a rejection without a real reason", async () => {
    const missing = await request(testApp)
      .patch("/api/offers/items/5/reject")
      .send({ rejected: true });
    const tooShort = await request(testApp)
      .patch("/api/offers/items/5/reject")
      .send({ rejected: true, reason: "  ab " });

    expect(missing.status).toBe(400);
    expect(tooShort.status).toBe(400);
    expect(state.updates).toHaveLength(0);
  });

  it("restores a rejected price and clears the reason", async () => {
    state.item = { id: 5, rfqItemId: 9, rejectedAt: new Date(), isApproved: false };
    const res = await request(testApp)
      .patch("/api/offers/items/5/reject")
      .send({ rejected: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 5, isRejected: false, rejectionReason: null });
    expect(state.updates[0]).toEqual({ rejectedAt: null, rejectedBy: null, rejectionReason: null });
  });

  it("returns 404 for an unknown offer item and 400 for a bad id", async () => {
    state.item = null;
    expect(
      (
        await request(testApp)
          .patch("/api/offers/items/5/reject")
          .send({ rejected: true, reason: "سبب كافٍ" })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(testApp)
          .patch("/api/offers/items/abc/reject")
          .send({ rejected: true, reason: "سبب كافٍ" })
      ).status,
    ).toBe(400);
  });
});

describe("PATCH /offers/items/:id/approve on a rejected price", () => {
  it("blocks approving a rejected price with 409 and writes nothing", async () => {
    state.item = { id: 5, rfqItemId: 9, rejectedAt: new Date(), isApproved: false };
    const res = await request(testApp)
      .patch("/api/offers/items/5/approve")
      .send({ approved: true });

    expect(res.status).toBe(409);
    expect(state.updates).toHaveLength(0);
  });

  it("still allows un-approving a rejected price", async () => {
    state.item = { id: 5, rfqItemId: 9, rejectedAt: new Date(), isApproved: false };
    const res = await request(testApp)
      .patch("/api/offers/items/5/approve")
      .send({ approved: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 5, isApproved: false });
  });
});

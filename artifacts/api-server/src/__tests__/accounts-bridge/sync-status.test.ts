/**
 * `GET /accounts/sync-status` is the endpoint the task requires for surfacing
 * failed syncs. These tests pin its contract: it is behind auth, it reports the
 * counts, and — the point of the endpoint — it lists every failed sync with the
 * error that stopped it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as any[],
}));

vi.mock("@workspace/db", () => ({
  db: {},
  accountsBridgeSyncTable: { __t: "bridge" },
  taxSettingsTable: { __t: "tax" },
}));

vi.mock("drizzle-orm", () => ({ eq: (col: any, val: any) => ({ __eq: [col, val] }) }));

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

// The store is the real module; only its DB access is doubled. The double must
// match the store's three query shapes: `.from(t)` awaited directly (syncCounts),
// `.from(t).orderBy().limit()` (listSyncRows) and `.from(t).where().limit()`.
vi.mock("@workspace/db", () => {
  const rowsFor = () => [...state.rows];
  return {
    db: {
      select: () => ({
        from: () => {
          const rows = rowsFor();
          const chain = {
            orderBy: () => ({ limit: async () => rows }),
            where: () => ({ limit: async () => rows }),
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
          };
          return chain;
        },
      }),
    },
    accountsBridgeSyncTable: { __t: "bridge" },
    taxSettingsTable: { __t: "tax" },
  };
});

vi.mock("../../modules/accounts-bridge/service", () => ({
  probeOdoo: async () => ({ configured: true, ok: true, version: "Cortoba" }),
}));

vi.mock("../../modules/accounts-bridge/replay", () => ({
  replayEvent: async () => ({ eventKey: "x", status: "synced" }),
}));

import express from "express";
import request from "supertest";
import bridgeRouter from "../../modules/accounts-bridge/routes";

const app = express();
app.use(express.json());
app.use("/api", bridgeRouter);

beforeEach(() => {
  state.rows = [];
});

describe("GET /api/accounts/sync-status", () => {
  it("returns counts and the Odoo probe", async () => {
    state.rows = [
      { id: 1, eventKey: "a", eventType: "expense", status: "synced", odooId: 5, attempts: 1 },
      {
        id: 2,
        eventKey: "b",
        eventType: "expense",
        status: "failed",
        odooId: null,
        attempts: 2,
        lastError: "boom",
      },
    ];
    const res = await request(app).get("/api/accounts/sync-status");
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ total: 2, synced: 1, failed: 1, pending: 0 });
    expect(res.body.odoo.ok).toBe(true);
    expect(res.body.rates).toEqual({ vatRate: 14, withholdingRate: 3 });
  });

  it("lists every failed sync with the error that stopped it", async () => {
    state.rows = [
      { id: 1, eventKey: "ok", eventType: "expense", status: "synced", odooId: 5, attempts: 1 },
      {
        id: 2,
        eventKey: "supplier_receipt:po_item_receipts:9",
        eventType: "supplier_receipt",
        sourceTable: "po_item_receipts",
        sourceId: 9,
        status: "failed",
        odooId: null,
        attempts: 3,
        lastError: "Odoo: AccessDenied",
      },
    ];
    const res = await request(app).get("/api/accounts/sync-status");
    expect(res.body.failedCount).toBe(1);
    expect(res.body.failures).toHaveLength(1);
    expect(res.body.failures[0].eventKey).toBe("supplier_receipt:po_item_receipts:9");
    expect(res.body.failures[0].lastError).toBe("Odoo: AccessDenied");
    expect(res.body.failures[0].attempts).toBe(3);
  });

  it("reports zero failures on a clean bridge", async () => {
    state.rows = [
      { id: 1, eventKey: "a", eventType: "expense", status: "synced", odooId: 5, attempts: 1 },
    ];
    const res = await request(app).get("/api/accounts/sync-status");
    expect(res.body.failedCount).toBe(0);
    expect(res.body.failures).toEqual([]);
  });

  it("is exposed under /accounts/bridge/status as an alias", async () => {
    const res = await request(app).get("/api/accounts/bridge/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("counts");
  });
});

describe("auth", () => {
  it("mounted behind requireAuth (401 without a session, not 404)", async () => {
    vi.resetModules();
    vi.doMock("../../middlewares/auth", () => ({
      requireAuth: (_req: any, res: any) => res.status(401).json({ error: "Unauthorized" }),
    }));
    const { default: guarded } = await import("../../modules/accounts-bridge/routes");
    const guardedApp = express();
    guardedApp.use(express.json());
    guardedApp.use("/api", guarded);
    const res = await request(guardedApp).get("/api/accounts/sync-status");
    expect(res.status).toBe(401);
  });
});

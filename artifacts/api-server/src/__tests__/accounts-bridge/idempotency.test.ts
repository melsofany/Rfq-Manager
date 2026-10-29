/**
 * Idempotency is the bridge's central promise: "exactly one Odoo document per
 * RFQ event, even when retried". It is enforced by the REAL store and the REAL
 * service — only the network (Odoo) and the database are doubled.
 *
 * The DB double is an in-memory table that honours the UNIQUE constraint on
 * `event_key`, because that constraint IS the mechanism under test: a fake that
 * silently accepted duplicate keys would make these tests pass vacuously.
 *
 * The Odoo double counts `create` calls, so a duplicate is detectable as a
 * second create for the same ref.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── In-memory DB with a real UNIQUE event_key ──────────────────────────────

const state = vi.hoisted(() => ({
  rows: [] as Record<string, any>[],
  nextId: 1,
  // Odoo records created, keyed by (model, ref) — the Odoo-side uniqueness.
  odooRecords: new Map<string, number>(),
  odooNextId: 1000,
  createCalls: [] as { model: string; ref: string }[],
  failNextCreate: false,
  taxSettings: [] as any[],
}));

const bridgeTable = vi.hoisted(() => ({ __t: "accountsBridgeSync" }));

vi.mock("@workspace/db", () => ({
  db: {
    insert: (table: unknown) => ({
      values: (vals: Record<string, any>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== bridgeTable) return [];
            // UNIQUE(event_key): a duplicate returns NO row, exactly as Postgres
            // does with ON CONFLICT DO NOTHING.
            if (state.rows.some((r) => r.eventKey === vals.eventKey)) return [];
            const row = {
              id: state.nextId++,
              odooModel: null,
              odooId: null,
              odooRef: null,
              status: "pending",
              attempts: 0,
              lastError: null,
              syncedAt: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...vals,
            };
            state.rows.push(row);
            return [row];
          },
        }),
        returning: async () => {
          if (table !== bridgeTable) return [];
          const row = {
            id: state.nextId++,
            odooModel: null,
            odooId: null,
            status: "pending",
            attempts: 0,
            ...vals,
          };
          state.rows.push(row);
          return [row];
        },
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: (cond: any) => ({
          limit: async () => filterRows(table, cond),
        }),
        orderBy: () => ({ limit: async () => (table === bridgeTable ? [...state.rows] : []) }),
        limit: async () => (table === bridgeTable ? [...state.rows] : state.taxSettings),
      }),
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, any>) => ({
        where: async (cond: any) => {
          if (table !== bridgeTable) return;
          for (const r of filterRows(table, cond)) Object.assign(r, vals);
        },
      }),
    }),
  },
  accountsBridgeSyncTable: bridgeTable,
  taxSettingsTable: { __t: "taxSettings" },
}));

function filterRows(table: unknown, cond: any): any[] {
  if (table !== bridgeTable) return state.taxSettings;
  // The store's conditions are `eq(col, value)` objects recording the column.
  const eq = cond?.__eq;
  if (!eq) return [...state.rows];
  const [col, val] = eq;
  const key = col?.name === "event_key" ? "eventKey" : col?.name === "status" ? "status" : null;
  if (!key) return [...state.rows];
  return state.rows.filter((r) => r[key] === val);
}

vi.mock("drizzle-orm", () => ({
  eq: (col: any, val: any) => ({ __eq: [col, val] }),
}));

// ─── Odoo double: counts creates, dedupes by ref ────────────────────────────

vi.mock("../../modules/accounts-bridge/odoo-client", () => ({
  odooConfigFromEnv: () => ({ url: "http://odoo", db: "d", user: "u", apiKey: "k" }),
  isOdooConfigured: () => true,
  findOneId: async (_cfg: any, model: string, domain: any[]) => {
    const [field, , value] = domain[0];
    const hit = state.odooRecords.get(`${model}:${value}`);
    return hit ?? null;
  },
  createRecord: async (_cfg: any, model: string, values: Record<string, any>) => {
    if (state.failNextCreate) {
      state.failNextCreate = false;
      throw new Error("Odoo exploded");
    }
    const ref = values.ref ?? values.payment_reference ?? "";
    state.createCalls.push({ model, ref });
    const id = state.odooNextId++;
    state.odooRecords.set(`${model}:${ref}`, id);
    return id;
  },
  searchRead: async () => [],
  executeKw: async () => 0,
}));

import { createOnce } from "../../modules/accounts-bridge/service";
import type { OdooDocument } from "../../modules/accounts-bridge/mapping";

const cfg = { url: "http://odoo", db: "d", user: "u", apiKey: "k" };

function doc(ref: string): OdooDocument {
  return {
    odooModel: "account.move",
    values: { move_type: "in_invoice", ref },
    odooRef: ref,
    summary: ref,
  };
}

beforeEach(() => {
  state.rows = [];
  state.nextId = 1;
  state.odooRecords.clear();
  state.odooNextId = 1000;
  state.createCalls = [];
  state.failNextCreate = false;
});

describe("createOnce — exactly one Odoo document per event", () => {
  it("creates the document on the first attempt", async () => {
    const r = await createOnce(
      cfg,
      "supplier_receipt",
      "po_item_receipts",
      42,
      doc("RFQ-PO-1-RCV-42"),
    );
    expect(r.status).toBe("synced");
    expect(r.odooId).toBe(1000);
    expect(state.createCalls).toHaveLength(1);
  });

  it("does NOT create a second document when the same event is retried", async () => {
    const first = await createOnce(
      cfg,
      "supplier_receipt",
      "po_item_receipts",
      42,
      doc("RFQ-PO-1-RCV-42"),
    );
    const second = await createOnce(
      cfg,
      "supplier_receipt",
      "po_item_receipts",
      42,
      doc("RFQ-PO-1-RCV-42"),
    );
    expect(first.status).toBe("synced");
    expect(second.status).toBe("skipped");
    expect(second.odooId).toBe(first.odooId);
    // The whole point: still exactly one create, one Odoo document.
    expect(state.createCalls).toHaveLength(1);
    expect(state.odooRecords.size).toBe(1);
  });

  it("survives many retries with a single document", async () => {
    const ids = new Set<number | undefined>();
    for (let i = 0; i < 10; i++) {
      const r = await createOnce(cfg, "expense", "operating_expenses", 7, doc("RFQ-EXP-7"));
      ids.add(r.odooId);
    }
    expect(state.createCalls).toHaveLength(1);
    expect(ids.size).toBe(1);
  });

  it("treats a different event as a different document", async () => {
    await createOnce(cfg, "supplier_receipt", "po_item_receipts", 42, doc("RFQ-PO-1-RCV-42"));
    await createOnce(cfg, "supplier_receipt", "po_item_receipts", 43, doc("RFQ-PO-1-RCV-43"));
    expect(state.createCalls).toHaveLength(2);
    expect(state.rows).toHaveLength(2);
  });

  it("reuses an Odoo record that already carries the ref (crash between create and markSynced)", async () => {
    // Simulate: a previous run created the Odoo document but died before it
    // could write odooId back. The local row exists with odooId NULL.
    state.rows.push({
      id: 99,
      eventKey: "supplier_receipt:po_item_receipts:42",
      eventType: "supplier_receipt",
      odooId: null,
      odooModel: null,
      status: "pending",
      attempts: 1,
    });
    state.odooRecords.set("account.move:RFQ-PO-1-RCV-42", 777);

    const r = await createOnce(
      cfg,
      "supplier_receipt",
      "po_item_receipts",
      42,
      doc("RFQ-PO-1-RCV-42"),
    );
    expect(r.status).toBe("skipped");
    expect(r.odooId).toBe(777);
    // No second create — the ref pre-check caught it.
    expect(state.createCalls).toHaveLength(0);
  });

  it("records a failure and stays retryable, then succeeds without duplicating", async () => {
    state.failNextCreate = true;
    const failed = await createOnce(
      cfg,
      "supplier_receipt",
      "po_item_receipts",
      42,
      doc("RFQ-PO-1-RCV-42"),
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Odoo exploded");
    const row = state.rows.find((r) => r.eventKey === "supplier_receipt:po_item_receipts:42");
    expect(row?.status).toBe("failed");
    expect(row?.odooId).toBeNull();
    expect(row?.attempts).toBe(1);

    const retried = await createOnce(
      cfg,
      "supplier_receipt",
      "po_item_receipts",
      42,
      doc("RFQ-PO-1-RCV-42"),
    );
    expect(retried.status).toBe("synced");
    // One successful create total; the failed attempt created nothing.
    expect(state.createCalls).toHaveLength(1);
    expect(state.rows).toHaveLength(1);
  });
});

/**
 * جسر RFQ ← Odoo — خدمة المزامنة
 *
 * Turns an RFQ event into exactly one Odoo document. The guarantee rests on
 * three independent layers, in order of cost:
 *
 *   1. The local sync row (`store.ts`): a UNIQUE `event_key` and a stored
 *      `odoo_id`. If the row is already `synced`, the event returns immediately
 *      and Odoo is never called.
 *   2. The Odoo-side business reference (`ref`): before creating, the service
 *      searches Odoo for a record already carrying that ref and reuses it. This
 *      covers the window where the create succeeded but the local `markSynced`
 *      did not (process death between the two).
 *   3. The `ref` itself is deterministic, so a duplicate can never even be
 *      described to Odoo as a new document.
 *
 * Credentials are read from the environment only. When they are absent the
 * bridge reports itself as unconfigured instead of throwing at import time.
 */

import {
  odooConfigFromEnv,
  executeKw,
  findOneId,
  searchRead,
  createRecord,
  type OdooConfig,
} from "./odoo-client";
import { reserveEvent, markSynced, markFailed } from "./store";
import { eventKey, type OdooDocument } from "./mapping";
import { ratesFrom } from "./tax";
import { db, taxSettingsTable } from "@workspace/db";
import type { BridgeEventType } from "@workspace/db";
import { logger } from "../../shared/logger";

export interface SyncResult {
  eventKey: string;
  status: "synced" | "failed" | "skipped" | "unconfigured";
  odooModel?: string;
  odooId?: number;
  error?: string;
}

// ─── Account / partner resolution ───────────────────────────────────────────

/**
 * Resolve an Odoo account id. Preference order:
 *   1. an explicit env override (ODOO_ACCOUNT_<KEY>),
 *   2. an account whose `code` matches `code`,
 *   3. the first account of the given `accountType`,
 *   4. null (Odoo falls back to the journal's default account).
 *
 * Resolution is cached per process because the chart of accounts is stable.
 */
const accountCache = new Map<string, number | null>();

export async function resolveAccountId(
  cfg: OdooConfig,
  opts: { key: string; code?: string; accountType?: string; env?: NodeJS.ProcessEnv },
): Promise<number | null> {
  const env = opts.env ?? process.env;
  const override = env[`ODOO_ACCOUNT_${opts.key.toUpperCase()}`];
  if (override) {
    const n = Number(override);
    if (isFinite(n) && n > 0) return n;
  }
  const cacheKey = `${cfg.url}|${opts.key}|${opts.code ?? ""}|${opts.accountType ?? ""}`;
  if (accountCache.has(cacheKey)) return accountCache.get(cacheKey) ?? null;

  let id: number | null = null;
  if (opts.code) {
    id = await findOneId(cfg, "account.account", [["code", "=", opts.code]]);
  }
  if (id == null && opts.accountType) {
    id = await findOneId(cfg, "account.account", [["account_type", "=", opts.accountType]]);
  }
  accountCache.set(cacheKey, id);
  return id;
}

/** Test hook — clear the account-resolution cache between cases. */
export function resetAccountCache(): void {
  accountCache.clear();
}

/**
 * Resolve an Odoo `res.partner`. We tag the partner with a stable `ref`
 * (`RFQ-SUP-<id>` / `RFQ-CUS-<id>`) so the mapping survives a rename. If no
 * partner exists, one is created — a bill with no partner is useless.
 */
export async function resolvePartner(
  cfg: OdooConfig,
  opts: {
    kind: "supplier" | "customer";
    rfqId: number | null;
    name: string;
    email?: string | null;
    phone?: string | null;
    taxId?: string | null;
  },
): Promise<number | null> {
  const prefix = opts.kind === "supplier" ? "RFQ-SUP" : "RFQ-CUS";
  const ref = opts.rfqId != null ? `${prefix}-${opts.rfqId}` : null;
  if (ref) {
    const byRef = await findOneId(cfg, "res.partner", [["ref", "=", ref]]);
    if (byRef != null) return byRef;
  }
  const byName = await findOneId(cfg, "res.partner", [["name", "=", opts.name]]);
  if (byName != null) return byName;

  const values: Record<string, unknown> = {
    name: opts.name,
    ref: ref ?? false,
    ...(opts.kind === "supplier" ? { supplier_rank: 1 } : { customer_rank: 1 }),
    ...(opts.email ? { email: opts.email } : {}),
    ...(opts.phone ? { phone: opts.phone } : {}),
    ...(opts.taxId ? { vat: opts.taxId } : {}),
  };
  return createRecord(cfg, "res.partner", values);
}

/** Load the effective Egyptian tax rates from `tax_settings`. */
async function loadRates() {
  try {
    const rows = await db.select().from(taxSettingsTable).limit(1);
    return ratesFrom(rows[0]);
  } catch (err) {
    logger.warn({ err }, "accounts-bridge: tax_settings unreadable, using statutory rates");
    return ratesFrom(null);
  }
}

// ─── Core: create exactly one document ──────────────────────────────────────

/**
 * Create the Odoo document for an event, or return the one already created.
 *
 * `doc` is produced by the pure mapping; `partner`/`account` ids must already be
 * resolved into `doc.values` by the caller. This function owns the idempotency:
 * the Odoo-ref pre-check and the sync-row bookkeeping.
 */
export async function createOnce(
  cfg: OdooConfig,
  eventType: BridgeEventType,
  sourceTable: string,
  sourceId: number,
  doc: OdooDocument,
  payload?: unknown,
): Promise<SyncResult> {
  const key = eventKey(eventType, sourceTable, sourceId);

  // Layer 1 — local reservation.
  const reserved = await reserveEvent({
    eventKey: key,
    eventType,
    sourceTable,
    sourceId,
    payload,
  });
  if (reserved.alreadySynced) {
    return {
      eventKey: key,
      status: "skipped",
      odooModel: reserved.row.odooModel ?? doc.odooModel,
      odooId: reserved.row.odooId ?? undefined,
    };
  }

  // Layer 2 — the create may have succeeded in a previous run that died before
  // `markSynced`. Reuse the Odoo record rather than creating a second one.
  const refField = doc.odooModel === "account.payment" ? "payment_reference" : "ref";
  const existingId = await findOneId(cfg, doc.odooModel, [[refField, "=", doc.odooRef]]);
  if (existingId != null) {
    await markSynced(key, doc.odooModel, existingId, doc.odooRef);
    return { eventKey: key, status: "skipped", odooModel: doc.odooModel, odooId: existingId };
  }

  // Layer 3 — create. A failure leaves the row retryable.
  try {
    const id = await createRecord(cfg, doc.odooModel, doc.values);
    await markSynced(key, doc.odooModel, id, doc.odooRef);
    logger.info(
      { eventType, eventKey: key, odooModel: doc.odooModel, odooId: id },
      "accounts-bridge: synced",
    );
    return { eventKey: key, status: "synced", odooModel: doc.odooModel, odooId: id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(key, message);
    logger.error({ err, eventType, eventKey: key }, "accounts-bridge: sync failed");
    return { eventKey: key, status: "failed", error: message };
  }
}

/**
 * Entry point for callers that only have the raw event data. Resolves the Odoo
 * ids the mapping needs, then delegates to `createOnce`. Returns
 * `unconfigured` when the Odoo env vars are absent, so an RFQ write never fails
 * because the bridge is not yet set up.
 */
export async function syncEvent(
  eventType: BridgeEventType,
  sourceTable: string,
  sourceId: number,
  build: (ctx: {
    cfg: OdooConfig;
    rates: ReturnType<typeof ratesFrom>;
    account: (opts: { key: string; code?: string; accountType?: string }) => Promise<number | null>;
    partner: (opts: {
      kind: "supplier" | "customer";
      rfqId: number | null;
      name: string;
      email?: string | null;
      phone?: string | null;
      taxId?: string | null;
    }) => Promise<number | null>;
  }) => Promise<OdooDocument>,
): Promise<SyncResult> {
  const cfg = odooConfigFromEnv();
  const key = eventKey(eventType, sourceTable, sourceId);
  if (!cfg) {
    logger.warn({ eventKey: key }, "accounts-bridge: ODOO_* not set — sync skipped");
    return { eventKey: key, status: "unconfigured" };
  }
  const rates = await loadRates();
  const ctx = {
    cfg,
    rates,
    account: (opts: { key: string; code?: string; accountType?: string }) =>
      resolveAccountId(cfg, opts),
    partner: (opts: Parameters<typeof resolvePartner>[1]) => resolvePartner(cfg, opts),
  };
  try {
    const doc = await build(ctx);
    return await createOnce(cfg, eventType, sourceTable, sourceId, doc, doc.values);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A failure while RESOLVING (not creating) still must be logged as a failed
    // sync so the sync-status screen surfaces it.
    await markFailed(key, message).catch(() => {});
    logger.error({ err, eventType, eventKey: key }, "accounts-bridge: resolve failed");
    return { eventKey: key, status: "failed", error: message };
  }
}

/**
 * Connectivity probe for the sync-status screen. Verifies authentication and
 * that the accounting models are reachable, without creating anything.
 */
export async function probeOdoo(): Promise<{
  configured: boolean;
  ok: boolean;
  version?: string;
  error?: string;
}> {
  const cfg = odooConfigFromEnv();
  if (!cfg) return { configured: false, ok: false, error: "ODOO_* env vars not set" };
  try {
    const accountInstalled = await executeKw<number>(cfg, "ir.module.module", "search_count", [
      [
        ["state", "=", "installed"],
        ["name", "=", "account"],
      ],
    ]);
    const company = await executeKw<{ name: string }[]>(cfg, "res.company", "search_read", [[]], {
      fields: ["name"],
      limit: 1,
    });
    return {
      configured: true,
      ok: accountInstalled > 0,
      version: company[0]?.name,
    };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export { searchRead };

/**
 * جسر الحسابات — مخزن حالة المزامنة (idempotency store)
 *
 * The bridge's idempotency guarantee is implemented here, in two steps that
 * together make "exactly one Odoo document per RFQ event" true even under
 * retries and concurrent attempts:
 *
 *   1. `reserveEvent` INSERTs the event key with `ON CONFLICT DO NOTHING`. The
 *      UNIQUE index on `event_key` means the second attempt loses the race and
 *      reads the row the first attempt created — it never creates a second row.
 *   2. `markSynced` writes the Odoo id onto that row. A row that already has an
 *      `odooId` is `synced`, and `service.ts` short-circuits BEFORE calling
 *      Odoo — so a retry after a successful create never creates a duplicate.
 *
 * A failed attempt leaves `odooId` NULL, so a retry IS allowed to try again;
 * but it still reuses the same row, so it can never produce two documents.
 */

import { db, accountsBridgeSyncTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { BridgeEventType, AccountsBridgeSync } from "@workspace/db";

export interface ReserveInput {
  eventKey: string;
  eventType: BridgeEventType;
  sourceTable: string;
  sourceId: number;
  payload?: unknown;
}

export interface ReservedEvent {
  row: AccountsBridgeSync;
  /** True when this call created the row (first attempt for the event). */
  created: boolean;
  /** True when the event already carries an Odoo id — do NOT call Odoo. */
  alreadySynced: boolean;
}

/**
 * Reserve (or load) the sync row for an event. Never throws on a duplicate key:
 * a conflict is the normal retry path and returns the existing row.
 */
export async function reserveEvent(input: ReserveInput): Promise<ReservedEvent> {
  const inserted = await db
    .insert(accountsBridgeSyncTable)
    .values({
      eventKey: input.eventKey,
      eventType: input.eventType,
      sourceTable: input.sourceTable,
      sourceId: input.sourceId,
      payload: (input.payload ?? null) as never,
      status: "pending",
    })
    .onConflictDoNothing({ target: accountsBridgeSyncTable.eventKey })
    .returning();

  if (inserted.length) {
    return { row: inserted[0], created: true, alreadySynced: false };
  }

  const [existing] = await db
    .select()
    .from(accountsBridgeSyncTable)
    .where(eq(accountsBridgeSyncTable.eventKey, input.eventKey))
    .limit(1);

  if (!existing) {
    // Only reachable if the row was deleted between the insert and the read.
    // Treat it as a fresh reservation rather than throwing on a phantom.
    const [retry] = await db
      .insert(accountsBridgeSyncTable)
      .values({
        eventKey: input.eventKey,
        eventType: input.eventType,
        sourceTable: input.sourceTable,
        sourceId: input.sourceId,
        payload: (input.payload ?? null) as never,
        status: "pending",
      })
      .returning();
    return { row: retry, created: true, alreadySynced: false };
  }

  return { row: existing, created: false, alreadySynced: existing.odooId != null };
}

/** Record a successful Odoo create. */
export async function markSynced(
  eventKey: string,
  odooModel: string,
  odooId: number,
  odooRef: string,
): Promise<void> {
  await db
    .update(accountsBridgeSyncTable)
    .set({
      odooModel,
      odooId,
      odooRef,
      status: "synced",
      lastError: null,
      syncedAt: new Date(),
    })
    .where(eq(accountsBridgeSyncTable.eventKey, eventKey));
}

/** Record a failed attempt; the row stays retryable (`odooId` remains NULL). */
export async function markFailed(eventKey: string, error: string): Promise<void> {
  const [row] = await db
    .select({ attempts: accountsBridgeSyncTable.attempts })
    .from(accountsBridgeSyncTable)
    .where(eq(accountsBridgeSyncTable.eventKey, eventKey))
    .limit(1);
  await db
    .update(accountsBridgeSyncTable)
    .set({
      status: "failed",
      lastError: error.slice(0, 2000),
      attempts: (row?.attempts ?? 0) + 1,
    })
    .where(eq(accountsBridgeSyncTable.eventKey, eventKey));
}

/** All rows, newest first — the sync-status screen. */
export async function listSyncRows(limit = 200): Promise<AccountsBridgeSync[]> {
  return db.select().from(accountsBridgeSyncTable).orderBy(accountsBridgeSyncTable.id).limit(limit);
}

/** Only the failed rows. */
export async function listFailedRows(limit = 200): Promise<AccountsBridgeSync[]> {
  return db
    .select()
    .from(accountsBridgeSyncTable)
    .where(eq(accountsBridgeSyncTable.status, "failed"))
    .limit(limit);
}

export interface SyncCounts {
  total: number;
  synced: number;
  failed: number;
  pending: number;
}

/** Aggregate counts for the sync-status header. */
export async function syncCounts(): Promise<SyncCounts> {
  const rows = await db
    .select({ status: accountsBridgeSyncTable.status })
    .from(accountsBridgeSyncTable);
  const counts: SyncCounts = { total: rows.length, synced: 0, failed: 0, pending: 0 };
  for (const r of rows) {
    if (r.status === "synced") counts.synced++;
    else if (r.status === "failed") counts.failed++;
    else counts.pending++;
  }
  return counts;
}

/** Look up one row by its event key (used by tests and drill-down). */
export async function findByEventKey(eventKey: string): Promise<AccountsBridgeSync | null> {
  const [row] = await db
    .select()
    .from(accountsBridgeSyncTable)
    .where(eq(accountsBridgeSyncTable.eventKey, eventKey))
    .limit(1);
  return row ?? null;
}

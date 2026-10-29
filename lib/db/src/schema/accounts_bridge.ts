import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ═══════════════════════════════════════════════════════════════════════════
// جسر RFQ ← Odoo — RFQ-to-Odoo bridge sync state
//
// The bridge maps an RFQ business event (a supplier goods receipt, a customer
// delivery, an expense, a customer payment, a cancellation/rejection) to ONE
// Odoo document. Idempotency is enforced by this table, not by Odoo:
//
//   • `eventKey` is a deterministic string derived from the event itself
//     (e.g. `receipt:<poItemReceiptId>`). It is UNIQUE, so a retry of the same
//     event can never reserve a second row.
//   • `odooModel` + `odooId` are the Odoo record created for that event. Once
//     both are set the event is `synced` and every later attempt short-circuits
//     WITHOUT calling Odoo again.
//   • A failed attempt keeps `odooId` NULL and records `lastError` + `attempts`
//     so a retry is allowed to try again — but it still cannot create a second
//     row, and therefore cannot create a second Odoo document.
//
// The UNIQUE event key plus the "odooId already set ⇒ skip" check are the two
// halves of the guarantee: at most one Odoo document per RFQ event, even when
// the sync is retried concurrently or after a partial failure.
// ═══════════════════════════════════════════════════════════════════════════

export const BRIDGE_EVENT_TYPES = [
  "supplier_receipt", // استلام بند من المورد → vendor bill
  "customer_delivery", // تسليم بند للعميل → customer invoice + COGS
  "expense", // مصروف تشغيلي → journal entry
  "customer_payment", // تحصيل من العميل → payment entry
  "cancellation", // إلغاء / رفض → credit note
] as const;
export type BridgeEventType = (typeof BRIDGE_EVENT_TYPES)[number];

export const BRIDGE_SYNC_STATUS = ["pending", "synced", "failed"] as const;
export type BridgeSyncStatus = (typeof BRIDGE_SYNC_STATUS)[number];

export const accountsBridgeSyncTable = pgTable(
  "accounts_bridge_sync",
  {
    id: serial("id").primaryKey(),
    // Deterministic per-event key, e.g. "supplier_receipt:po_item_receipts:42".
    // UNIQUE — the idempotency guarantee lives here.
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull(),
    // The RFQ row this event came from, for drill-down and re-sync.
    sourceTable: text("source_table"),
    sourceId: integer("source_id"),
    // The Odoo document. NULL until the create succeeds.
    odooModel: text("odoo_model"),
    odooId: integer("odoo_id"),
    // The RFQ business key stored ON the Odoo record (idempotency mirror on the
    // Odoo side, via `ref`), so a human can trace a document back to the event.
    odooRef: text("odoo_ref"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    // The exact payload sent to Odoo, kept for audit + replay debugging.
    payload: jsonb("payload"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("accounts_bridge_sync_event_key_idx").on(t.eventKey),
    index("accounts_bridge_sync_status_idx").on(t.status),
    index("accounts_bridge_sync_type_idx").on(t.eventType),
  ],
);

export type AccountsBridgeSync = typeof accountsBridgeSyncTable.$inferSelect;
export type InsertAccountsBridgeSync = typeof accountsBridgeSyncTable.$inferInsert;

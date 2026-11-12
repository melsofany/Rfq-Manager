import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  numeric,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { rfqTable, rfqItemsTable } from "./rfq";
import { suppliersTable } from "./suppliers";

/**
 * WhatsApp supplier bot — per-item reply drafts.
 *
 * The supplier answers item by item over WhatsApp, which means a reply is built
 * up across SEVERAL messages and may be interrupted at any point (they go and
 * check a price, or simply stop). Keeping the draft on our side, one row per
 * (request, item, supplier), is what makes «استكمال الرد لاحقاً» real: the
 * supplier returns, picks the same request, and the values they already entered
 * are still there.
 *
 * Nothing here is a quotation. A draft becomes a real offer only when the
 * supplier CONFIRMS it (see the confirm flow), and even then it lands in
 * `offers`/`offer_items` unapproved — an employee still reviews it. Treating a
 * half-typed WhatsApp message as an approved price is the failure this table
 * exists to prevent.
 *
 * The unique index is on the (rfq, item, supplier) triple so a re-sent value
 * UPDATES the draft instead of piling up rows, and so two concurrent webhooks
 * (Meta retries) cannot create a duplicate line.
 */
export const supplierItemDraftsTable = pgTable(
  "supplier_item_drafts",
  {
    id: serial("id").primaryKey(),
    rfqId: integer("rfq_id")
      .notNull()
      .references(() => rfqTable.id, { onDelete: "cascade" }),
    rfqItemId: integer("rfq_item_id")
      .notNull()
      .references(() => rfqItemsTable.id, { onDelete: "cascade" }),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "cascade" }),
    /** "available" | "unavailable" — the supplier's availability answer. */
    availability: text("availability"),
    unitPrice: numeric("unit_price", { precision: 15, scale: 4 }),
    currency: text("currency"),
    deliveryDays: integer("delivery_days"),
    originCountry: text("origin_country"),
    brand: text("brand"),
    notes: text("notes"),
    /** WhatsApp media id of an attached quotation (PDF/image), if any. */
    attachmentMediaId: text("attachment_media_id"),
    attachmentName: text("attachment_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("supplier_item_drafts_uq").on(t.rfqId, t.rfqItemId, t.supplierId)],
);

export type SupplierItemDraft = typeof supplierItemDraftsTable.$inferSelect;

/**
 * One conversational step per (supplier, request) so the bot knows what the
 * supplier's next free-text message means.
 *
 * Without this the bot cannot tell «120» answering a price prompt from «120»
 * answering a delivery-days prompt. It is deliberately tiny and rebuildable:
 * losing it costs the supplier one re-tap, never data.
 */
export const supplierBotSessionsTable = pgTable(
  "supplier_bot_sessions",
  {
    id: serial("id").primaryKey(),
    phone: text("phone").notNull(),
    supplierId: integer("supplier_id").references(() => suppliersTable.id, {
      onDelete: "cascade",
    }),
    rfqId: integer("rfq_id").references(() => rfqTable.id, { onDelete: "cascade" }),
    rfqItemId: integer("rfq_item_id").references(() => rfqItemsTable.id, {
      onDelete: "cascade",
    }),
    /** e.g. "await_price" | "await_delivery" | "await_origin" | "await_brand" | "await_notes". */
    step: text("step"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("supplier_bot_sessions_phone_uq").on(t.phone)],
);

export type SupplierBotSession = typeof supplierBotSessionsTable.$inferSelect;

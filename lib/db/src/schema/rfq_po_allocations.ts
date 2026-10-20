import {
  pgTable,
  serial,
  timestamp,
  integer,
  numeric,
  text,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { rfqItemsTable } from "./rfq";
import { purchaseOrderItemsTable } from "./purchase_orders";

/**
 * Allocation of a supplier PO line to a customer RFQ line (طلب التسعير).
 *
 * Many-to-many on purpose: one RFQ line can be bought in several PO lines
 * (batches / several suppliers), and one PO line can cover several RFQ lines.
 *
 * Purchased quantity is derived from this table, never stored on the RFQ line,
 * so it cannot drift. Cancelled lines are excluded from the sums by the caller.
 *
 * `matchBasis` records how the link was produced:
 *   explicit | lineItem | partNo | itemId | manual
 * `confidence` is "auto" (system matched on an exact key and unit) or
 * "confirmed" (the PO creator accepted a suggestion).
 *
 * This table is internal. Supplier-facing documents must never include RFQ
 * numbers or these rows (see shared/rfq-links.ts).
 */
export const rfqPoAllocationsTable = pgTable(
  "rfq_po_allocations",
  {
    id: serial("id").primaryKey(),
    rfqItemId: integer("rfq_item_id")
      .notNull()
      .references(() => rfqItemsTable.id, { onDelete: "cascade" }),
    poItemId: integer("po_item_id")
      .notNull()
      .references(() => purchaseOrderItemsTable.id, { onDelete: "cascade" }),
    allocatedQty: numeric("allocated_qty", { precision: 15, scale: 4 }).notNull(),
    matchBasis: text("match_basis").notNull(),
    confidence: text("confidence").notNull().default("auto"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rfq_po_alloc_rfq_item_idx").on(t.rfqItemId),
    uniqueIndex("rfq_po_alloc_pair_uidx").on(t.rfqItemId, t.poItemId),
  ],
);

export type RfqPoAllocation = typeof rfqPoAllocationsTable.$inferSelect;

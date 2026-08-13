import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { purchaseOrdersTable, purchaseOrderItemsTable } from "./purchase_orders";
import { representativesTable } from "./representatives";

export const workOrderAssignmentsTable = pgTable("work_order_assignments", {
  id: serial("id").primaryKey(),
  poId: integer("po_id").notNull().references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
  representativeId: integer("representative_id").references(() => representativesTable.id),
  representativeName: text("representative_name").notNull(),
  representativePhone: text("representative_phone").notNull(),
  status: text("status").notNull().default("sent"),
  pendingAction: text("pending_action"),
  waMessageId: text("wa_message_id"),
  rejectionReason: text("rejection_reason"),
  // When set, this assignment tracks a single PO line item (per-item receipt)
  // rather than the whole PO. Null keeps legacy whole-PO behaviour intact.
  poItemId: integer("po_item_id").references(() => purchaseOrderItemsTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorkOrderAssignment = typeof workOrderAssignmentsTable.$inferSelect;

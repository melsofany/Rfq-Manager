import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { purchaseOrdersTable } from "./purchase_orders";
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorkOrderAssignment = typeof workOrderAssignmentsTable.$inferSelect;

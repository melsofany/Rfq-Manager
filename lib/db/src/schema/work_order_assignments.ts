import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { purchaseOrdersTable, purchaseOrderItemsTable } from "./purchase_orders";
import { customerPosTable, customerPoItemsTable } from "./customer_pos";
import { representativesTable } from "./representatives";

// نوع أمر الشغل: استلام من المورد (receipt) أو تسليم للعميل (delivery).
// Defaults to "receipt" so existing rows (legacy, poItemId-only) keep working.
export const WORK_ORDER_KIND = {
  RECEIPT: "receipt",
  DELIVERY: "delivery",
} as const;
export type WorkOrderKind = (typeof WORK_ORDER_KIND)[keyof typeof WORK_ORDER_KIND];

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
  // When set, this assignment tracks a single supplier PO line item (per-item
  // receipt) rather than the whole PO. Null keeps legacy whole-PO behaviour.
  poItemId: integer("po_item_id").references(() => purchaseOrderItemsTable.id, {
    onDelete: "set null",
  }),
  // Delivery-side links (kind="delivery"). poId is still required (set to the
  // purchase-order id that fulfils this customer line) so the table's NOT NULL
  // constraint holds; customerPoId/customerPoItemId pinpoint the customer line.
  kind: text("kind").notNull().default("receipt"),
  customerPoId: integer("customer_po_id").references(() => customerPosTable.id, {
    onDelete: "cascade",
  }),
  customerPoItemId: integer("customer_po_item_id").references(() => customerPoItemsTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorkOrderAssignment = typeof workOrderAssignmentsTable.$inferSelect;

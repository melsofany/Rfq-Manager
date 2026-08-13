import { pgTable, text, serial, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { purchaseOrdersTable, purchaseOrderItemsTable } from "./purchase_orders";
import { customerPosTable, customerPoItemsTable } from "./customer_pos";
import { workOrderAssignmentsTable } from "./work_order_assignments";

// سجل استلام بند أمر شراء من المورد — Supplier PO line-item receipt.
// A single purchase_order_item may have several receipts (partial shipments):
// e.g. line A received in full in one row, line B postponed (no rows), line C
// received across two rows. The aggregated totals are mirrored onto
// purchase_order_items for fast reads, but the rows are the source of truth.
export const poItemReceiptsTable = pgTable("po_item_receipts", {
  id: serial("id").primaryKey(),
  poItemId: integer("po_item_id")
    .notNull()
    .references(() => purchaseOrderItemsTable.id, { onDelete: "cascade" }),
  poId: integer("po_id")
    .notNull()
    .references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
  assignmentId: integer("assignment_id").references(() => workOrderAssignmentsTable.id, {
    onDelete: "set null",
  }),
  receivedQty: numeric("received_qty", { precision: 15, scale: 4 }),
  acceptedQty: numeric("accepted_qty", { precision: 15, scale: 4 }),
  rejectedQty: numeric("rejected_qty", { precision: 15, scale: 4 }),
  rejectionReason: text("rejection_reason"),
  actualCost: numeric("actual_cost", { precision: 15, scale: 4 }),
  // received | partial | rejected
  receiptStatus: text("receipt_status").notNull().default("received"),
  receivedBy: text("received_by"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPoItemReceiptSchema = createInsertSchema(poItemReceiptsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPoItemReceipt = z.infer<typeof insertPoItemReceiptSchema>;
export type PoItemReceipt = typeof poItemReceiptsTable.$inferSelect;

// سجل تسليم بند للعميل — Customer PO line-item delivery.
// We deliver to the customer; the customer may reject part (defective/wrong).
// Guarded in the API: delivered qty may not exceed the accepted qty received
// from the supplier on the linked purchase_order_items (via customerPoItemId).
export const customerPoItemDeliveriesTable = pgTable("customer_po_item_deliveries", {
  id: serial("id").primaryKey(),
  customerPoItemId: integer("customer_po_item_id")
    .notNull()
    .references(() => customerPoItemsTable.id, { onDelete: "cascade" }),
  customerPoId: integer("customer_po_id")
    .notNull()
    .references(() => customerPosTable.id, { onDelete: "cascade" }),
  deliveredQty: numeric("delivered_qty", { precision: 15, scale: 4 }),
  rejectedByCustomerQty: numeric("rejected_by_customer_qty", { precision: 15, scale: 4 }),
  rejectionReason: text("rejection_reason"),
  // delivered | partial | rejected
  deliveryStatus: text("delivery_status").notNull().default("delivered"),
  deliveredBy: text("delivered_by"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCustomerPoItemDeliverySchema = createInsertSchema(
  customerPoItemDeliveriesTable,
).omit({
  id: true,
  createdAt: true,
});
export type InsertCustomerPoItemDelivery = z.infer<
  typeof insertCustomerPoItemDeliverySchema
>;
export type CustomerPoItemDelivery = typeof customerPoItemDeliveriesTable.$inferSelect;

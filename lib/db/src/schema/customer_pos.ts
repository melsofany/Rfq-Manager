import { pgTable, text, serial, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { employeesTable } from "./employees";
import { customersTable } from "./customers";
import { customerRfqsTable, customerRfqItemsTable } from "./customer_rfqs";

// أمر شراء العميل — Customer Purchase Order
// A customer PO can mix items from several customer RFQs, and the same
// customer_rfq_item can appear on more than one customer PO (partial
// shipments). A customer PO may also arrive with no customer RFQ number, so
// both the RFQ and item links are nullable. The owning customer is explicitly
// selected on entry (customerId/customerName), so a PO's customer is known even
// without an RFQ link.
export const customerPosTable = pgTable("customer_pos", {
  id: serial("id").primaryKey(),
  internalPoNo: text("internal_po_no").notNull().unique(),
  customerPoNo: text("customer_po_no").notNull(),
  customerId: integer("customer_id").references(() => customersTable.id),
  customerName: text("customer_name"),
  poDate: text("po_date"),
  buyerName: text("buyer_name"),
  employeeId: integer("employee_id").references(() => employeesTable.id),
  employeeName: text("employee_name"),
  notes: text("notes"),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const customerPoItemsTable = pgTable("customer_po_items", {
  id: serial("id").primaryKey(),
  customerPoId: integer("customer_po_id")
    .notNull()
    .references(() => customerPosTable.id, { onDelete: "cascade" }),
  // Link back to the originating customer RFQ (nullable for POs without one).
  customerRfqId: integer("customer_rfq_id").references(() => customerRfqsTable.id),
  // The specific customer RFQ line item this PO line was sourced from. Nullable
  // for free/manual lines, and intentionally NOT unique: the same item may be
  // ordered again on a later PO (partial shipments).
  customerRfqItemId: integer("customer_rfq_item_id").references(() => customerRfqItemsTable.id, {
    onDelete: "set null",
  }),
  partNo: text("part_no"),
  lineItem: text("line_item"),
  description: text("description"),
  uom: text("uom"),
  qty: numeric("qty", { precision: 15, scale: 4 }),
  unitPrice: numeric("unit_price", { precision: 15, scale: 4 }),
  deliveryDate: text("delivery_date"),
  // Delivery summary — rolled up from customer_po_item_deliveries so the UI can
  // render a snapshot. Guarded in the API: delivered qty may not exceed the
  // accepted qty received from the supplier on the linked purchase_order_items.
  totalDeliveredQty: numeric("total_delivered_qty", { precision: 15, scale: 4 }),
  totalRejectedByCustomerQty: numeric("total_rejected_by_customer_qty", { precision: 15, scale: 4 }),
  // pending | partial | delivered | rejected
  deliveryStatus: text("delivery_status").notNull().default("pending"),
  // Manual highlight (admin/accountant): color row tint shown on `/items`
  // (سجل البنود والطلبات) + free-form note appended to the «السبب» column.
  // Cleared together (both null) or set together.
  highlightColor: text("highlight_color"),
  highlightNote: text("highlight_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCustomerPoSchema = createInsertSchema(customerPosTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCustomerPo = z.infer<typeof insertCustomerPoSchema>;
export type CustomerPo = typeof customerPosTable.$inferSelect;

export const insertCustomerPoItemSchema = createInsertSchema(customerPoItemsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCustomerPoItem = z.infer<typeof insertCustomerPoItemSchema>;
export type CustomerPoItem = typeof customerPoItemsTable.$inferSelect;

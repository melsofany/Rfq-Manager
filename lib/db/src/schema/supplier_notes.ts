import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { suppliersTable } from "./suppliers";
import { purchaseOrderItemsTable } from "./purchase_orders";

// Notes recorded against a supplier, optionally tied to one PO line (for example
// a wrong price or an item that was never requested). Free text is for review
// only; it does not change the supplier score.
export const supplierNotesTable = pgTable("supplier_notes", {
  id: serial("id").primaryKey(),
  supplierId: integer("supplier_id")
    .notNull()
    .references(() => suppliersTable.id, { onDelete: "cascade" }),
  poItemId: integer("po_item_id").references(() => purchaseOrderItemsTable.id, {
    onDelete: "set null",
  }),
  // wrong_price | unrequested_item | wrong_qty | late_delivery | quality | other
  reason: text("reason").notNull(),
  text: text("text"),
  createdByEmployeeId: integer("created_by_employee_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

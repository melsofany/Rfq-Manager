import { pgTable, text, serial, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { employeesTable } from "./employees";
import { customerRfqItemsTable } from "./customer_rfqs";

export const rfqTable = pgTable("rfq", {
  id: serial("id").primaryKey(),
  internalRfqNo: text("internal_rfq_no").notNull().unique(),
  customerRfqNo: text("customer_rfq_no").notNull(),
  customerRfqDate: text("customer_rfq_date"),
  requiredResponseDate: text("required_response_date"),
  status: text("status").notNull().default("DRAFT"),
  employeeId: integer("employee_id").references(() => employeesTable.id),
  notes: text("notes"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const rfqItemsTable = pgTable("rfq_items", {
  id: serial("id").primaryKey(),
  rfqId: integer("rfq_id")
    .notNull()
    .references(() => rfqTable.id, { onDelete: "cascade" }),
  itemId: text("item_id"),
  lineItem: text("line_item"),
  partNo: text("part_no"),
  description: text("description").notNull(),
  uom: text("uom"),
  qty: numeric("qty", { precision: 15, scale: 4 }),
  referencePrice: numeric("reference_price", { precision: 15, scale: 4 }),
  // Links this supplier RFQ item back to the originating customer RFQ item,
  // enabling exact margin checks on the customer-rfq side. Nullable for
  // legacy/sheet-only supplier RFQs that have no DB customer RFQ origin.
  customerRfqItemId: integer("customer_rfq_item_id").references(() => customerRfqItemsTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRfqSchema = createInsertSchema(rfqTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertRfq = z.infer<typeof insertRfqSchema>;
export type Rfq = typeof rfqTable.$inferSelect;

export const insertRfqItemSchema = createInsertSchema(rfqItemsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertRfqItem = z.infer<typeof insertRfqItemSchema>;
export type RfqItem = typeof rfqItemsTable.$inferSelect;

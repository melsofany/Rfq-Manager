import { pgTable, text, serial, timestamp, integer, numeric, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { rfqTable, rfqItemsTable } from "./rfq";
import { suppliersTable } from "./suppliers";
import { sentLogTable } from "./sent_log";
import { employeesTable } from "./employees";

export const offersTable = pgTable("offers", {
  id: serial("id").primaryKey(),
  rfqId: integer("rfq_id")
    .notNull()
    .references(() => rfqTable.id, { onDelete: "cascade" }),
  supplierId: integer("supplier_id")
    .notNull()
    .references(() => suppliersTable.id),
  sentLogId: integer("sent_log_id").references(() => sentLogTable.id),
  employeeId: integer("employee_id").references(() => employeesTable.id),
  totalPrice: numeric("total_price", { precision: 15, scale: 4 }),
  generalNotes: text("general_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const offerItemsTable = pgTable("offer_items", {
  id: serial("id").primaryKey(),
  offerId: integer("offer_id")
    .notNull()
    .references(() => offersTable.id, { onDelete: "cascade" }),
  rfqItemId: integer("rfq_item_id")
    .notNull()
    .references(() => rfqItemsTable.id),
  price: numeric("price", { precision: 15, scale: 4 }).notNull(),
  taxIncluded: boolean("tax_included").notNull().default(false),
  // Marks this supplier price as the approved/endorsed one for its rfq_item —
  // the reference cost used by the customer-rfq margin check. Only one
  // offer_item per rfq_item may be approved at a time (enforced in the API).
  isApproved: boolean("is_approved").notNull().default(false),
  deliveryDays: integer("delivery_days"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertOfferSchema = createInsertSchema(offersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOffer = z.infer<typeof insertOfferSchema>;
export type Offer = typeof offersTable.$inferSelect;

export const insertOfferItemSchema = createInsertSchema(offerItemsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertOfferItem = z.infer<typeof insertOfferItemSchema>;
export type OfferItem = typeof offerItemsTable.$inferSelect;

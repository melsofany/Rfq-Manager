import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";

export const supplierCategoriesTable = pgTable("supplier_categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SupplierCategory = typeof supplierCategoriesTable.$inferSelect;

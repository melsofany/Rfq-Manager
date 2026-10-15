import { pgTable, text, serial, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { suppliersTable } from "./suppliers";

export const supplierCategoriesTable = pgTable("supplier_categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ربط المورد بالتصنيفات — supplier ↔ category LINK TABLE.
//
// `suppliers.category` is FREE TEXT (comma-separated category NAMES, no FK), so
// a rename had to rewrite the text and a deleted category left a dangling name.
// This table is the SOURCE OF TRUTH for the relationship: a rename only touches
// `supplier_categories.name` and every link follows automatically, and a delete
// cascades. The legacy text column is kept in step (write-through) for backward
// compatibility with callers that still read it; it is no longer authoritative.
export const supplierCategoryLinksTable = pgTable(
  "supplier_category_links",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => supplierCategoriesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("supplier_category_links_unique").on(t.supplierId, t.categoryId)],
);

export type SupplierCategory = typeof supplierCategoriesTable.$inferSelect;
export type SupplierCategoryLink = typeof supplierCategoryLinksTable.$inferSelect;

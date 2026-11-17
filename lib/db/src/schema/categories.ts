import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { suppliersTable } from "./suppliers";
import { itemCategoriesTable } from "./item_categories";

export const supplierCategoriesTable = pgTable("supplier_categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  parentId: integer("parent_id"),
  // Soft delete — a deleted category is HIDDEN, never removed. Its links,
  // keywords and history stay intact so `restore` is exact and the historical
  // audit rows never dangle. `deleted_at` doubles as the "when" for the log.
  isActive: boolean("is_active").notNull().default(true),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ربط المورد بتصنيفات البنود — supplier ↔ ITEM-category LINK TABLE.
//
// Distinct from `supplier_category_links` (the supplier's TRADE categories on
// /suppliers). This records which ITEM categories a supplier can actually
// SUPPLY, so «مين يقدر يورّد بند من تصنيف كابلات؟» has a real answer. One row
// per (supplier, item category); a rename of either side follows by id.
export const supplierItemCategoryLinksTable = pgTable(
  "supplier_item_category_links",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => itemCategoriesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("supplier_item_category_links_unique").on(t.supplierId, t.categoryId)],
);

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

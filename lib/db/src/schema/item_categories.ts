import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  boolean,
  numeric,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { employeesTable } from "./employees";
import { rfqItemsTable } from "./rfq";
import { customerRfqItemsTable } from "./customer_rfqs";

// تصنيف البنود — Item categories (أجهزة، قطع غيار، كهرباء، قواطع، مقاومة حريق…)
// Separate from supplier_categories: a supplier's trade category is not the
// category of the item it supplies (one supplier may cover several categories).
export const itemCategoriesTable = pgTable("item_categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  // Short stable code used for the deterministic classifier seeds.
  code: text("code"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// اختصاص الموظفين — which categories each procurement employee is responsible
// for. One employee may own several categories; a category may have one
// `is_primary` owner (the fallback when load-balancing is ambiguous).
export const employeeCategoriesTable = pgTable(
  "employee_categories",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employeesTable.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => itemCategoriesTable.id, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("employee_categories_employee_category_uq").on(t.employeeId, t.categoryId),
    // At most ONE primary owner per category — enforced by the database so no
    // write path can create a second one (the API guard is a convenience, not
    // the source of truth). Without this, `pickOwner`'s primary map silently
    // kept whichever row Postgres returned last, making the responsible
    // employee non-deterministic.
    uniqueIndex("employee_categories_one_primary_uq")
      .on(t.categoryId)
      .where(sql`${t.isPrimary}`),
  ],
);

// إسناد البند — one row per rfq_item, recording the responsible employee.
// `category_id` is null when the item could not be classified with enough
// confidence: such an item is deliberately left unassigned (never fabricated).
export const rfqItemAssignmentsTable = pgTable(
  "rfq_item_assignments",
  {
    id: serial("id").primaryKey(),
    rfqItemId: integer("rfq_item_id")
      .notNull()
      .references(() => rfqItemsTable.id, { onDelete: "cascade" }),
    customerRfqItemId: integer("customer_rfq_item_id").references(() => customerRfqItemsTable.id, {
      onDelete: "set null",
    }),
    categoryId: integer("category_id").references(() => itemCategoriesTable.id, {
      onDelete: "set null",
    }),
    employeeId: integer("employee_id").references(() => employeesTable.id, {
      onDelete: "set null",
    }),
    // auto | manual
    source: text("source").notNull().default("auto"),
    confidence: numeric("confidence", { precision: 5, scale: 2 }),
    assignedBy: integer("assigned_by").references(() => employeesTable.id, {
      onDelete: "set null",
    }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("rfq_item_assignments_item_uq").on(t.rfqItemId)],
);

export const insertItemCategorySchema = createInsertSchema(itemCategoriesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertItemCategory = z.infer<typeof insertItemCategorySchema>;
export type ItemCategory = typeof itemCategoriesTable.$inferSelect;

export const insertEmployeeCategorySchema = createInsertSchema(employeeCategoriesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertEmployeeCategory = z.infer<typeof insertEmployeeCategorySchema>;
export type EmployeeCategory = typeof employeeCategoriesTable.$inferSelect;

// كلمات التصنيف المفتاحية — admin-managed classifier vocabulary.
// Replaces the hardcoded CATEGORY_KEYWORDS table in classification.ts so a
// manager can add/edit/disable keywords without a code change. The classifier
// keeps its deterministic algorithm, weights and no-guessing rule; only the
// source of the terms changes. `weight = 0` means "use the default weight for
// the term type" (phrase vs single token), so a seeded term never loses the
// weight it had in code.
export const itemCategoryKeywordsTable = pgTable(
  "item_category_keywords",
  {
    id: serial("id").primaryKey(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => itemCategoriesTable.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    // 0 = use the default weight for the term type (phrase/token).
    weight: integer("weight").notNull().default(0),
    // 'ar' | 'en' | null — display/filter only; matching is normalisation-based.
    language: text("language"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("item_category_keywords_category_keyword_uq").on(t.categoryId, t.keyword)],
);

export const insertItemCategoryKeywordSchema = createInsertSchema(itemCategoryKeywordsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertItemCategoryKeyword = z.infer<typeof insertItemCategoryKeywordSchema>;
export type ItemCategoryKeyword = typeof itemCategoryKeywordsTable.$inferSelect;

export const insertRfqItemAssignmentSchema = createInsertSchema(rfqItemAssignmentsTable).omit({
  id: true,
  assignedAt: true,
});
export type InsertRfqItemAssignment = z.infer<typeof insertRfqItemAssignmentSchema>;
export type RfqItemAssignment = typeof rfqItemAssignmentsTable.$inferSelect;

// إسناد بند طلب العميل — SOURCE OF TRUTH for procurement responsibility.
// Responsibility starts at the customer's item, not at the supplier RFQ: a
// single customer item may be sent to several suppliers, but it has exactly ONE
// responsible employee at any point in time.
//
// Responsibility is now a TIME-RANGED history: each row is a period
// [valid_from, valid_to). A partial unique index guarantees at most ONE OPEN
// period (valid_to IS NULL) per item; a gist EXCLUDE constraint (added in
// init-db.ts, needs btree_gist) forbids overlapping periods. The employee FK is
// RESTRICT so deleting an employee can never erase assignment history — an
// employee is DISABLED instead.
export const customerRfqItemAssignmentsTable = pgTable(
  "customer_rfq_item_assignments",
  {
    id: serial("id").primaryKey(),
    customerRfqItemId: integer("customer_rfq_item_id")
      .notNull()
      .references(() => customerRfqItemsTable.id, { onDelete: "restrict" }),
    categoryId: integer("category_id").references(() => itemCategoriesTable.id, {
      onDelete: "set null",
    }),
    employeeId: integer("employee_id").references(() => employeesTable.id, {
      onDelete: "restrict",
    }),
    // auto | manual | inherited (migrated from the legacy rfq_item_assignments)
    source: text("source").notNull().default("auto"),
    confidence: numeric("confidence", { precision: 5, scale: 2 }),
    // Action recorder only — NOT the historical owner. Kept SET NULL so an
    // employee deletion does not block, and it is never used as an owner key.
    assignedBy: integer("assigned_by").references(() => employeesTable.id, {
      onDelete: "set null",
    }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    // Period start/end. `validTo` null = the currently open period.
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
  },
  (t) => [
    // At most ONE open period per item. Overlap protection for CLOSED periods
    // is the gist EXCLUDE constraint (init-db.ts).
    uniqueIndex("customer_rfq_item_assignments_open_uq")
      .on(t.customerRfqItemId)
      .where(sql`${t.validTo} IS NULL`),
  ],
);

export const insertCustomerRfqItemAssignmentSchema = createInsertSchema(
  customerRfqItemAssignmentsTable,
).omit({ id: true, assignedAt: true });
export type InsertCustomerRfqItemAssignment = z.infer<typeof insertCustomerRfqItemAssignmentSchema>;
export type CustomerRfqItemAssignment = typeof customerRfqItemAssignmentsTable.$inferSelect;

// سجل تدقيق الإسناد والتصنيف — one row per change to a responsibility or a
// category, recording old/new values, the actor, the time and an optional
// reason. Kept separate from `audit_log` (which is free-text) so a change is
// queryable field-by-field and historical KPIs can be explained.
export const itemAssignmentAuditTable = pgTable("item_assignment_audit", {
  id: serial("id").primaryKey(),
  // "customer" (customer_rfq_items) | "rfq" (legacy rfq_items)
  scope: text("scope").notNull(),
  customerRfqItemId: integer("customer_rfq_item_id"),
  rfqItemId: integer("rfq_item_id"),
  categoryIdOld: integer("category_id_old"),
  categoryIdNew: integer("category_id_new"),
  employeeIdOld: integer("employee_id_old"),
  employeeIdNew: integer("employee_id_new"),
  changedBy: integer("changed_by").references(() => employeesTable.id, { onDelete: "set null" }),
  reason: text("reason"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ItemAssignmentAudit = typeof itemAssignmentAuditTable.$inferSelect;

// تصنيفات البند المتعددة — a single item may belong to MORE THAN ONE category
// (e.g. a device that is also an electrical component). `customer_rfq_items.category_id`
// stays as the PRIMARY category (the one the classifier picked, used for
// ownership), while this junction records every additional category the manager
// has attached for review. One row per (item, category); a manager may add or
// remove them. The classifier itself stays single-category — multi-category is a
// deliberate human decision, never inferred.
export const customerRfqItemCategoriesTable = pgTable(
  "customer_rfq_item_categories",
  {
    id: serial("id").primaryKey(),
    customerRfqItemId: integer("customer_rfq_item_id")
      .notNull()
      .references(() => customerRfqItemsTable.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => itemCategoriesTable.id, { onDelete: "cascade" }),
    // The employee responsible for THIS category on THIS item (coverage). Set
    // from the category's owner at attach time; nullable so an uncovered
    // category can still be recorded.
    employeeId: integer("employee_id").references(() => employeesTable.id, {
      onDelete: "set null",
    }),
    addedBy: integer("added_by").references(() => employeesTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customer_rfq_item_categories_uq").on(t.customerRfqItemId, t.categoryId)],
);

export type CustomerRfqItemCategory = typeof customerRfqItemCategoriesTable.$inferSelect;

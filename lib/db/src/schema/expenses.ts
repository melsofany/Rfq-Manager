import { pgTable, text, serial, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { purchaseOrdersTable, purchaseOrderItemsTable } from "./purchase_orders";
import { customerPosTable } from "./customer_pos";
import { employeesTable } from "./employees";

// ─────────────────────────────────────────────────────────────────────────────
// مصاريف مرتبطة ببند أمر شراء — PO line-item charges
//
// Charges attached to a single supplier purchase-order line item (نقل، شحن،
// جمارك، تحميل، تنزيل، …). Recorded at the line level — not the PO total — so
// the true cost of each line is known precisely. Summed into the realized
// cost in the accounts margin computation (accepted qty × actualCost + Σ
// charges for the line).
// ─────────────────────────────────────────────────────────────────────────────
export const poItemChargesTable = pgTable("po_item_charges", {
  id: serial("id").primaryKey(),
  poItemId: integer("po_item_id")
    .notNull()
    .references(() => purchaseOrderItemsTable.id, { onDelete: "cascade" }),
  poId: integer("po_id")
    .notNull()
    .references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
  chargeType: text("charge_type").notNull(),
  description: text("description"),
  amount: numeric("amount", { precision: 15, scale: 4 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPoItemChargeSchema = createInsertSchema(poItemChargesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPoItemCharge = z.infer<typeof insertPoItemChargeSchema>;
export type PoItemCharge = typeof poItemChargesTable.$inferSelect;

// Allowed charge types (extensible — stored as free text, surfaced as a list).
export const PO_CHARGE_TYPES = [
  "نقل",
  "شحن",
  "جمارك",
  "تحميل",
  "تنزيل",
  "تخزين",
  "تأمين",
  "أخرى",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// مصروفات الشركة التشغيلية — Company operating expenses
//
// Expenses NOT tied to a specific PO: rent, hosting/domains, utilities,
// maintenance, admin, etc. Each row carries a date, category, amount, notes,
// and optional file attachments (receipts/invoices stored as base64).
// ─────────────────────────────────────────────────────────────────────────────
export const operatingExpensesTable = pgTable("operating_expenses", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(),
  description: text("description"),
  expenseDate: text("expense_date").notNull(),
  amount: numeric("amount", { precision: 15, scale: 4 }).notNull(),
  notes: text("notes"),
  employeeId: integer("employee_id").references(() => employeesTable.id),
  employeeName: text("employee_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertOperatingExpenseSchema = createInsertSchema(operatingExpensesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertOperatingExpense = z.infer<typeof insertOperatingExpenseSchema>;
export type OperatingExpense = typeof operatingExpensesTable.$inferSelect;

// File attachments for an operating expense (base64-encoded content).
export const expenseAttachmentsTable = pgTable("expense_attachments", {
  id: serial("id").primaryKey(),
  expenseId: integer("expense_id")
    .notNull()
    .references(() => operatingExpensesTable.id, { onDelete: "cascade" }),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  content: text("content").notNull(), // base64-encoded
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ExpenseAttachment = typeof expenseAttachmentsTable.$inferSelect;

export const OPERATING_EXPENSE_CATEGORIES = [
  "إيجارات",
  "دومينات واستضافة وخدمات تقنية",
  "كهرباء ومياه",
  "اتصالات",
  "نثريات",
  "صيانة",
  "مصروفات إدارية",
  "رواتب",
  "أخرى",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// تحصيل مستحقات العملاء — Customer collection tracking
//
// When a customer PO is delivered, collection terms are set: a start date and
// the agreed number of days to collect. The system computes the due date and
// tracks the collection status across recorded payment installments.
// customer_po_collections is 1:1 with customer_pos (one terms record per PO).
// customer_po_payments holds each received payment installment.
// ─────────────────────────────────────────────────────────────────────────────
export const customerPoCollectionsTable = pgTable("customer_po_collections", {
  id: serial("id").primaryKey(),
  customerPoId: integer("customer_po_id")
    .notNull()
    .references(() => customerPosTable.id, { onDelete: "cascade" }),
  collectionStartDate: text("collection_start_date"),
  collectionDays: integer("collection_days").notNull().default(30),
  dueDate: text("due_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertCustomerPoCollectionSchema = createInsertSchema(
  customerPoCollectionsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCustomerPoCollection = z.infer<typeof insertCustomerPoCollectionSchema>;
export type CustomerPoCollection = typeof customerPoCollectionsTable.$inferSelect;

export const customerPoPaymentsTable = pgTable("customer_po_payments", {
  id: serial("id").primaryKey(),
  customerPoId: integer("customer_po_id")
    .notNull()
    .references(() => customerPosTable.id, { onDelete: "cascade" }),
  paymentDate: text("payment_date").notNull(),
  amount: numeric("amount", { precision: 15, scale: 4 }).notNull(),
  method: text("method"),
  reference: text("reference"),
  notes: text("notes"),
  employeeId: integer("employee_id").references(() => employeesTable.id),
  employeeName: text("employee_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCustomerPoPaymentSchema = createInsertSchema(customerPoPaymentsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCustomerPoPayment = z.infer<typeof insertCustomerPoPaymentSchema>;
export type CustomerPoPayment = typeof customerPoPaymentsTable.$inferSelect;

// Collection status values (computed, not stored):
//   pending       — مستحق للتحصيل (not yet due)
//   due_soon      — قريب الاستحقاق (within DUE_SOON_DAYS of due date)
//   overdue       — متأخر (past due date, not fully collected)
//   partial       — تم التحصيل جزئياً
//   collected     — تم التحصيل بالكامل
export const COLLECTION_STATUS = {
  pending: "pending",
  dueSoon: "due_soon",
  overdue: "overdue",
  partial: "partial",
  collected: "collected",
} as const;

export const DUE_SOON_DAYS = 7;

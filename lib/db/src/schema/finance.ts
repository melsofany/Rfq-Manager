/**
 * Finance Module — الماليات (supplier payment requests)
 *
 * A purchase order's money lives per (PO, supplier) pair: one PO can go to
 * several suppliers and each is owed its own amount. A `finance_payment_request`
 * is the operator's DECISION that a given pair is to be paid — created by
 * selecting the PO on /purchase-orders.
 *
 * Two invariants, both enforced in the schema rather than in the UI:
 *   1. one request per (po_id, supplier_id) — UNIQUE, so a PO can never be
 *      queued for payment twice for the same supplier;
 *   2. the request is a single running record — partial payments accumulate
 *      against it and `status` flips to `paid` only when the due amount is
 *      settled. A settled request cannot be paid again.
 *
 * `finance_payments` holds each actual payment (one row per installment) so a
 * partial payment is a fact about the ledger, not a mutation of a total.
 */
import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  numeric,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { suppliersTable } from "./suppliers";
import { purchaseOrdersTable } from "./purchase_orders";
import { employeesTable } from "./employees";

/**
 * Payment status values (stored, and recomputed from the payments on every
 * write — never trusted as the only source of truth):
 *   unpaid  — مستحق ولم يُسدد
 *   partial — تم سداد جزء
 *   paid    — تم السداد بالكامل
 */
export const FINANCE_REQUEST_STATUS = ["unpaid", "partial", "paid"] as const;
export type FinanceRequestStatus = (typeof FINANCE_REQUEST_STATUS)[number];

/** Payment methods offered in the payment dialog. */
export const FINANCE_PAYMENT_METHODS = [
  "تحويل بنكي",
  "شيك",
  "نقدية",
  "محفظة إلكترونية",
  "أخرى",
] as const;

export const financePaymentRequestsTable = pgTable(
  "finance_payment_requests",
  {
    id: serial("id").primaryKey(),
    poId: integer("po_id")
      .notNull()
      .references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "cascade" }),
    // Snapshots so the finance list stays readable if a PO or supplier is
    // renamed later — the row records what was owed AT SELECTION TIME.
    poNo: text("po_no"),
    internalPoNo: text("internal_po_no"),
    supplierName: text("supplier_name").notNull(),
    // Due amount in EGP, from the PO lines for THIS supplier:
    // Σ qty × reference_price, cancelled lines excluded.
    dueAmount: numeric("due_amount", { precision: 15, scale: 4 }).notNull().default("0"),
    paidAmount: numeric("paid_amount", { precision: 15, scale: 4 }).notNull().default("0"),
    status: text("status").notNull().default("unpaid"),
    // Bank snapshot at selection time, so a later supplier edit cannot rewrite
    // the account a payment was actually made to.
    bankName: text("bank_name"),
    bankAccountHolder: text("bank_account_holder"),
    bankAccountNumber: text("bank_account_number"),
    iban: text("iban"),
    swiftCode: text("swift_code"),
    bankBranch: text("bank_branch"),
    notes: text("notes"),
    selectedBy: integer("selected_by").references(() => employeesTable.id, {
      onDelete: "set null",
    }),
    selectedByName: text("selected_by_name"),
    selectedAt: timestamp("selected_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The double-payment guard. One request per PO+supplier, forever.
    uniqueIndex("finance_payment_requests_po_supplier_uq").on(t.poId, t.supplierId),
    index("finance_payment_requests_status_idx").on(t.status),
  ],
);

export const financePaymentsTable = pgTable(
  "finance_payments",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id")
      .notNull()
      .references(() => financePaymentRequestsTable.id, { onDelete: "cascade" }),
    amount: numeric("amount", { precision: 15, scale: 4 }).notNull(),
    paymentDate: text("payment_date").notNull(),
    method: text("method").notNull(),
    reference: text("reference"),
    notes: text("notes"),
    employeeId: integer("employee_id").references(() => employeesTable.id, {
      onDelete: "set null",
    }),
    employeeName: text("employee_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("finance_payments_request_idx").on(t.requestId)],
);

export const insertFinancePaymentRequestSchema = createInsertSchema(
  financePaymentRequestsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFinancePaymentRequest = z.infer<typeof insertFinancePaymentRequestSchema>;
export type FinancePaymentRequest = typeof financePaymentRequestsTable.$inferSelect;

export const insertFinancePaymentSchema = createInsertSchema(financePaymentsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertFinancePayment = z.infer<typeof insertFinancePaymentSchema>;
export type FinancePayment = typeof financePaymentsTable.$inferSelect;

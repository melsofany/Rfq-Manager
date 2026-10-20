import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { suppliersTable } from "./suppliers";
import { purchaseOrdersTable } from "./purchase_orders";
import { employeesTable } from "./employees";

/**
 * طلب استكمال بيانات المورد — supplier self-registration link.
 *
 * A supplier that has no registered bank account must NOT receive a purchase
 * order: we cannot pay him, so the order is unactionable. Instead the dispatch
 * sends him a one-time link where he enters the required data himself.
 *
 * The link is deliberately single-use and un-editable: once the data is
 * confirmed (entered twice and matching) the request is `completed` and the
 * token is dead — "لا تظهر مرة أخرى بعد ملء البيانات". Any later correction is
 * the company's job (or the supplier contacts us), never a second submission.
 */
export const SUPPLIER_REGISTRATION_STATUS = {
  PENDING: "pending",
  COMPLETED: "completed",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
} as const;
export type SupplierRegistrationStatus =
  (typeof SUPPLIER_REGISTRATION_STATUS)[keyof typeof SUPPLIER_REGISTRATION_STATUS];

export const supplierRegistrationRequestsTable = pgTable("supplier_registration_requests", {
  id: serial("id").primaryKey(),
  supplierId: integer("supplier_id")
    .notNull()
    .references(() => suppliersTable.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  status: text("status").notNull().default("pending"),
  /**
   * The data the COMPANY already holds, snapshotted when the link was created.
   * The supplier sees exactly this (read-only) so he can confirm what we have
   * rather than guess it.
   */
  heldData: jsonb("held_data").$type<Record<string, string | null>>(),
  /** Field keys the supplier is asked to fill (the missing ones). */
  requestedFields: jsonb("requested_fields").$type<string[]>(),
  /** First entry. Kept for the audit trail even when the confirmation fails. */
  submittedData: jsonb("submitted_data").$type<Record<string, string | null>>(),
  /** The confirmation entry — stored only when it matched the first entry. */
  confirmedData: jsonb("confirmed_data").$type<Record<string, string | null>>(),
  /** How many confirmation attempts were refused (mismatch). */
  attempts: integer("attempts").notNull().default(0),
  lastMismatchAt: timestamp("last_mismatch_at", { withTimezone: true }),
  lastMismatchFields: jsonb("last_mismatch_fields").$type<string[]>(),
  /** The PO that triggered this request (null when requested manually). */
  poId: integer("po_id").references(() => purchaseOrdersTable.id, { onDelete: "set null" }),
  createdByEmployeeId: integer("created_by_employee_id").references(() => employeesTable.id, {
    onDelete: "set null",
  }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SupplierRegistrationRequest = typeof supplierRegistrationRequestsTable.$inferSelect;

import { integer, pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { employeesTable } from "./employees";
import { rfqTable } from "./rfq";
import { purchaseOrdersTable } from "./purchase_orders";
import { customerRfqsTable } from "./customer_rfqs";
import { customerPosTable } from "./customer_pos";

/**
 * نوع كيان الإدخال: طلب تسعير مورد / طلب تسعير عميل / أمر شراء مورد / أمر شراء عميل.
 * Tracks the form the operator opened (new RFQ / new PO).
 */
export const DATA_ENTRY_TYPE = {
  SUPPLIER_RFQ: "supplier_rfq",
  CUSTOMER_RFQ: "customer_rfq",
  SUPPLIER_PO: "supplier_po",
  CUSTOMER_PO: "customer_po",
} as const;
export type DataEntryType = (typeof DATA_ENTRY_TYPE)[keyof typeof DATA_ENTRY_TYPE];

/**
 * جلسة إدخال بيانات — تسجِّل اللحظة اللي فتح فيها الموظف فورم «جديد»
 * حتى لحظة الحفظ الناجح، عشان نقيس «الوقت الفعلي المستغرق في إدخال الطلب».
 *
 * - startedAt = وقت فتح الفورم (POST من الواجهة).
 * - endedAt   = وقت الحفظ الناجح (PATCH من الواجهة بعد نجاح الإنشاء).
 * - abandoned = true لو الفورم اتقفل بدون حفظ.
 *
 * entityId يربط الجلسة بالكيان اللي اتعمل (rfq/po id) بعد الحفظ.
 */
export const dataEntrySessionsTable = pgTable("data_entry_sessions", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id")
    .notNull()
    .references(() => employeesTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  // Optional link to the created entity (set on successful save).
  rfqId: integer("rfq_id").references(() => rfqTable.id, { onDelete: "set null" }),
  purchaseOrderId: integer("purchase_order_id").references(() => purchaseOrdersTable.id, {
    onDelete: "set null",
  }),
  customerRfqId: integer("customer_rfq_id").references(() => customerRfqsTable.id, {
    onDelete: "set null",
  }),
  customerPoId: integer("customer_po_id").references(() => customerPosTable.id, {
    onDelete: "set null",
  }),
  abandoned: boolean("abandoned").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DataEntrySession = typeof dataEntrySessionsTable.$inferSelect;

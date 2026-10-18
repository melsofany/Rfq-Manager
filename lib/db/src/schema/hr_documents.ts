import { pgTable, integer, jsonb, timestamp } from "drizzle-orm/pg-core";

/** Per-employee values typed or picked for the HR documents (contract, receipts). One row per employee. */
export const hrEmployeeDocumentFieldsTable = pgTable("hr_employee_document_fields", {
  employeeId: integer("employee_id").primaryKey(),
  fields: jsonb("fields").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

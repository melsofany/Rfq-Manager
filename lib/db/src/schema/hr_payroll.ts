import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/** One payroll run per month (YYYY-MM). Draft can be recalculated or deleted; approved is locked. */
export const hrPayrollRunsTable = pgTable("hr_payroll_runs", {
  id: serial("id").primaryKey(),
  period: text("period").notNull().unique(),
  status: text("status").notNull().default("draft"),
  settingsSnapshot: jsonb("settings_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
});

/** Payslip per employee in a run. Money columns are numeric(12,2). */
export const hrPayslipsTable = pgTable(
  "hr_payslips",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    basicSalary: numeric("basic_salary", { precision: 12, scale: 2 }).notNull(),
    allowances: numeric("allowances", { precision: 12, scale: 2 }).notNull(),
    bonuses: numeric("bonuses", { precision: 12, scale: 2 }).notNull(),
    incentives: numeric("incentives", { precision: 12, scale: 2 }).notNull(),
    deductions: numeric("deductions", { precision: 12, scale: 2 }).notNull(),
    absenceDays: integer("absence_days").notNull(),
    absenceAmount: numeric("absence_amount", { precision: 12, scale: 2 }).notNull(),
    finesApplied: numeric("fines_applied", { precision: 12, scale: 2 }).notNull(),
    finesDeferred: numeric("fines_deferred", { precision: 12, scale: 2 }).notNull(),
    socialEmployee: numeric("social_employee", { precision: 12, scale: 2 }).notNull(),
    healthEmployee: numeric("health_employee", { precision: 12, scale: 2 }).notNull(),
    incomeTax: numeric("income_tax", { precision: 12, scale: 2 }).notNull(),
    gross: numeric("gross", { precision: 12, scale: 2 }).notNull(),
    net: numeric("net", { precision: 12, scale: 2 }).notNull(),
    /**
     * WhatsApp delivery of this payslip to the employee. Kept on the payslip so
     * the payroll screen can show which employees still need a resend — nothing
     * is written to `whatsapp_chats`, which is the shared procurement inbox and
     * must not expose one employee's salary to their colleagues.
     */
    deliveryStatus: text("delivery_status").notNull().default("pending"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveryError: text("delivery_error"),
  },
  (t) => [index("hr_payslips_run_idx").on(t.runId)],
);

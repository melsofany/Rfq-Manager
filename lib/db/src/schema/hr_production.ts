import { pgTable, text, serial, timestamp, integer, numeric, index } from "drizzle-orm/pg-core";

/**
 * Production incentive credits (حافز الإنتاج) — one row per (employee, basis month, payroll run)
 * that paid or clawed back production incentive. `basisPeriod` is the month the customer items
 * were ASSIGNED; `runPeriod` is the payroll month that carried the amount. The sum of
 * `creditedAmount` for a basis month is what that month's incentive has paid so far, so a later
 * delivery is settled by the difference in the payroll month where it happens.
 */
export const hrProductionCreditsTable = pgTable(
  "hr_production_credits",
  {
    id: serial("id").primaryKey(),
    /** hr_employees.id */
    employeeId: integer("employee_id").notNull(),
    basisPeriod: text("basis_period").notNull(),
    runPeriod: text("run_period").notNull(),
    assignedCount: integer("assigned_count").notNull(),
    deliveredCount: integer("delivered_count").notNull(),
    baseAmount: numeric("base_amount", { precision: 12, scale: 2 }).notNull(),
    creditedAmount: numeric("credited_amount", { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("hr_production_credits_emp_basis_idx").on(t.employeeId, t.basisPeriod)],
);

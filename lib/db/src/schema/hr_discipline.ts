import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  numeric,
  date,
  index,
} from "drizzle-orm/pg-core";

/** Disciplinary case: warning → investigation → decision (penalty) → closed. */
export const hrDisciplinaryCasesTable = pgTable(
  "hr_disciplinary_cases",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    incidentDate: date("incident_date", { mode: "string" }).notNull(),
    status: text("status").notNull().default("open"),
    penaltyType: text("penalty_type"),
    penaltyAmount: numeric("penalty_amount", { precision: 12, scale: 2 }),
    decision: text("decision"),
    createdBy: integer("created_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("hr_cases_emp_idx").on(t.employeeId)],
);

/** Investigation log: statements, witnesses, evidence — appended, never edited. */
export const hrCaseNotesTable = pgTable(
  "hr_case_notes",
  {
    id: serial("id").primaryKey(),
    caseId: integer("case_id").notNull(),
    kind: text("kind").notNull().default("note"),
    body: text("body").notNull(),
    byEmployee: integer("by_employee"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("hr_case_notes_case_idx").on(t.caseId)],
);

/** Bonuses, incentives and deductions, applied to a payroll period (YYYY-MM). */
export const hrPayAdjustmentsTable = pgTable(
  "hr_pay_adjustments",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id").notNull(),
    kind: text("kind").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    /** Bonus expressed in days of basic pay (مكافأة بعدد أيام). Null for a fixed amount. */
    days: numeric("days", { precision: 6, scale: 2 }),
    period: text("period").notNull(),
    reason: text("reason"),
    caseId: integer("case_id"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("hr_adj_emp_period_idx").on(t.employeeId, t.period)],
);

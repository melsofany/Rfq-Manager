import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
  date,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/** Final settlement on exit. Draft can be replaced; approving ends the employment and cancels pending leave. */
export const hrSettlementsTable = pgTable(
  "hr_settlements",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id").notNull(),
    exitDate: date("exit_date", { mode: "string" }).notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("draft"),
    total: numeric("total", { precision: 12, scale: 2 }).notNull(),
    details: jsonb("details").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
  },
  (t) => [index("hr_settlements_emp_idx").on(t.employeeId)],
);

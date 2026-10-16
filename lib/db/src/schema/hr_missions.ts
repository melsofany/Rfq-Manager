import { pgTable, text, serial, timestamp, date, integer, index } from "drizzle-orm/pg-core";

/**
 * Missions — مأموريات العمل.
 *
 * An employee sent to the bank or to a customer cannot punch in, so without a
 * record the attendance screen reports them absent. A mission is the record of
 * that instruction; an APPROVED mission excuses the day (full-day) or a time
 * window (timed) from the absence calculation.
 *
 * - `mission_type = full_day` → the employee is out for the whole day, so they
 *   are shown as «في مأمورية» and never as absent.
 * - `mission_type = timed`    → only `start_time`–`end_time` is excused; a punch
 *   outside that window is still expected.
 *
 * Approval is the manager's: a pending mission changes nothing until decided.
 */
export const hrMissionsTable = pgTable(
  "hr_missions",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id").notNull(),
    missionDate: date("mission_date", { mode: "string" }).notNull(),
    missionType: text("mission_type").notNull().default("full_day"),
    /** "HH:MM" — required for `timed`, null for `full_day`. */
    startTime: text("start_time"),
    endTime: text("end_time"),
    destination: text("destination"),
    reason: text("reason"),
    status: text("status").notNull().default("pending"),
    decidedBy: integer("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("hr_missions_emp_date_idx").on(t.employeeId, t.missionDate)],
);

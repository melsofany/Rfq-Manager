import { pgTable, text, serial, timestamp, boolean, integer } from "drizzle-orm/pg-core";

/**
 * Per-employee attendance exceptions — استثناءات الحضور.
 *
 * The company shift (`work_shift` in hr_settings) is the default for everyone,
 * but a specific employee may work to different terms: a driver who starts at
 * 11:00, or someone who is not required to punch at all. Those terms belong to
 * the employee, not to the shift, so they live here — one active policy per
 * employee, so there is never a question of which one applies.
 *
 * A missing row means "the company shift applies", which is the normal case.
 */
export const hrAttendanceExceptionsTable = pgTable("hr_attendance_exceptions", {
  id: serial("id").primaryKey(),
  /** One policy per employee: the attendance screen resolves exactly one row. */
  employeeId: integer("employee_id").notNull().unique(),
  /** Overrides the shift start for lateness. Null = use the company shift. */
  startTime: text("start_time"),
  /** Overrides the shift grace. Null = use the company shift. */
  lateGraceMinutes: integer("late_grace_minutes"),
  /** True = no punch is required; the day counts as normal, not absent. */
  exemptFromPunch: boolean("exempt_from_punch").notNull().default(false),
  note: text("note"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

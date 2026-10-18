import { pgTable, text, serial, timestamp, boolean, date, uniqueIndex } from "drizzle-orm/pg-core";

/** HR employee master record (separate from login `employees`). */
export const hrEmployeesTable = pgTable("hr_employees", {
  id: serial("id").primaryKey(),
  employeeNo: text("employee_no").notNull().unique(),
  fullName: text("full_name").notNull(),
  /** English name, required on hire and edit; null for records created before it was required. */
  fullNameEn: text("full_name_en"),
  jobTitle: text("job_title"),
  department: text("department"),
  hireDate: date("hire_date", { mode: "string" }),
  status: text("status").notNull().default("active"),
  /** PIN enrolled on the fingerprint device; maps punches to this employee. */
  biometricPin: text("biometric_pin").unique(),
  phone: text("phone"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Fingerprint devices that connected to us over ADMS/push. Unknown SNs start inactive. */
export const hrAttendanceDevicesTable = pgTable("hr_attendance_devices", {
  sn: text("sn").primaryKey(),
  name: text("name"),
  location: text("location"),
  isActive: boolean("is_active").notNull().default(false),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Raw punches. Device time is local (Africa/Cairo), stored as a naive timestamp. */
export const hrAttendancePunchesTable = pgTable(
  "hr_attendance_punches",
  {
    id: serial("id").primaryKey(),
    deviceSn: text("device_sn").notNull(),
    pin: text("pin").notNull(),
    punchedAt: timestamp("punched_at", { mode: "string" }).notNull(),
    status: text("status"),
    verify: text("verify"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("hr_punches_uq").on(t.deviceSn, t.pin, t.punchedAt)],
);

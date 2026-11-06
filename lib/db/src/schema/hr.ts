import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  date,
  uniqueIndex,
  integer,
} from "drizzle-orm/pg-core";

/** HR employee master record (separate from login `employees`). */
export const hrEmployeesTable = pgTable("hr_employees", {
  id: serial("id").primaryKey(),
  employeeNo: text("employee_no").notNull().unique(),
  fullName: text("full_name").notNull(),
  /** English name, required on hire and edit; null for records created before it was required. */
  fullNameEn: text("full_name_en"),
  /** Procurement login account (employees.id) whose assigned items drive this employee's production incentive. */
  procurementEmployeeId: integer("procurement_employee_id"),
  /** Exception for employees without a procurement link: keep the fixed contract incentive in payroll. */
  keepFixedIncentive: boolean("keep_fixed_incentive").notNull().default(false),
  jobTitle: text("job_title"),
  department: text("department"),
  hireDate: date("hire_date", { mode: "string" }),
  status: text("status").notNull().default("active"),
  /** PIN enrolled on the fingerprint device; maps punches to this employee. */
  biometricPin: text("biometric_pin").unique(),
  phone: text("phone"),
  notes: text("notes"),
  // ── Field-operations mobile access ────────────────────────────────────────
  // Mobile access is granted per employee WITHOUT deleting the HR record, so
  // revoking app access never touches employment history. The password is
  // bcrypt-hashed; being `active` in HR is NOT by itself permission to use the
  // app — that comes from an active row in `hr_field_assignments`.
  mobileAccessEnabled: boolean("mobile_access_enabled").notNull().default(false),
  mobilePasswordHash: text("mobile_password_hash"),
  mobileLastLoginAt: timestamp("mobile_last_login_at", { withTimezone: true }),
  /** Firebase Cloud Messaging device token; null until push is configured. */
  fcmToken: text("fcm_token"),
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

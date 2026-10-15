import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  date,
  integer,
  numeric,
  index,
} from "drizzle-orm/pg-core";

/** Leave types. Defaults are editable from the HR page; confirm values against company policy. */
export const hrLeaveTypesTable = pgTable("hr_leave_types", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en").notNull(),
  annualDays: integer("annual_days").notNull().default(0),
  paid: boolean("paid").notNull().default(true),
  requiresCertificate: boolean("requires_certificate").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
});

export const hrLeaveRequestsTable = pgTable(
  "hr_leave_requests",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id").notNull(),
    leaveTypeId: integer("leave_type_id").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    days: numeric("days", { precision: 6, scale: 1 }).notNull(),
    status: text("status").notNull().default("pending"),
    reason: text("reason"),
    certificateNote: text("certificate_note"),
    decidedBy: integer("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("hr_leave_requests_emp_idx").on(t.employeeId, t.startDate)],
);

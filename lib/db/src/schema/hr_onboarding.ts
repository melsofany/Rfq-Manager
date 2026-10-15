import {
  pgTable,
  text,
  integer,
  numeric,
  date,
  boolean,
  serial,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/** Personal and statutory details. Sensitive values are stored encrypted; only last-4 is shown in the UI. */
export const hrEmployeeProfilesTable = pgTable("hr_employee_profiles", {
  employeeId: integer("employee_id").primaryKey(),
  nationalIdEnc: text("national_id_enc"),
  nationalIdLast4: text("national_id_last4"),
  dateOfBirth: date("date_of_birth", { mode: "string" }),
  gender: text("gender"),
  address: text("address"),
  emergencyContactName: text("emergency_contact_name"),
  emergencyContactPhone: text("emergency_contact_phone"),
  socialInsuranceNo: text("social_insurance_no"),
  healthInsuranceNo: text("health_insurance_no"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const hrContractsTable = pgTable(
  "hr_contracts",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id").notNull(),
    contractType: text("contract_type").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }),
    probationEndDate: date("probation_end_date", { mode: "string" }),
    basicSalary: numeric("basic_salary", { precision: 12, scale: 2 }).notNull(),
    allowances: numeric("allowances", { precision: 12, scale: 2 }).notNull().default("0"),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("hr_contracts_emp_idx").on(t.employeeId)],
);

export const hrBankAccountsTable = pgTable(
  "hr_bank_accounts",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id").notNull(),
    bankName: text("bank_name").notNull(),
    accountHolder: text("account_holder").notNull(),
    accountNoEnc: text("account_no_enc").notNull(),
    accountLast4: text("account_last4").notNull(),
    ibanEnc: text("iban_enc"),
    ibanLast4: text("iban_last4"),
    isPrimary: boolean("is_primary").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("hr_bank_emp_idx").on(t.employeeId)],
);

/** Employee photo (data stored base64; photos are not encrypted, they are shown in the UI). One per employee. */
export const hrEmployeePhotosTable = pgTable("hr_employee_photos", {
  employeeId: integer("employee_id").primaryKey(),
  mimeType: text("mime_type").notNull(),
  dataB64: text("data_b64").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

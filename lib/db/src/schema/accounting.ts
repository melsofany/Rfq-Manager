import { pgTable, text, serial, timestamp, integer, numeric, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { employeesTable } from "./employees";
import { suppliersTable } from "./suppliers";
import { customersTable } from "./customers";
import { purchaseOrdersTable } from "./purchase_orders";
import { customerPosTable } from "./customer_pos";
import { customerRfqsTable } from "./customer_rfqs";

// ═══════════════════════════════════════════════════════════════════════════
// دليل الحسابات — Chart of Accounts (hierarchical, Egyptian convention)
//
// Account types: asset (1xxx), liability (2xxx), equity (3xxx),
// revenue (4xxx), expense (5xxx). Control/sub-ledger accounts (AP/AR/VAT
// control, bank, cash) are flagged isControl and may NOT receive direct
// journal lines — postings go through their sub-ledger (supplier/customer
// invoice/payment) or a clearing account.
// ═══════════════════════════════════════════════════════════════════════════
export const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const chartOfAccountsTable = pgTable("chart_of_accounts", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(), // e.g. "1100", "2100", "4200"
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en"),
  type: text("type").notNull(), // asset | liability | equity | revenue | expense
  parentId: integer("parent_id"),
  isControl: boolean("is_control").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertChartOfAccountSchema = createInsertSchema(chartOfAccountsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertChartOfAccount = z.infer<typeof insertChartOfAccountSchema>;
export type ChartOfAccount = typeof chartOfAccountsTable.$inferSelect;

// Well-known control-account codes used for auto-posting. These are seeded in
// init-db.ts and referenced by code (not id) so postings survive re-seeds.
export const ACCOUNT_CODES = {
  // Assets (1xxx)
  CASH: "1001", // النقدية بالخزينة
  BANK: "1010", // البنوك
  AR: "1200", // العملاء — المدينون (ذمم العملاء)
  AR_VAT_OUTPUT_RECEIVABLE: "1210", // ض.ق.م. مستحقة على العملاء
  INVENTORY: "1300", // المخزون
  INPUT_VAT: "1401", // ضريبة مدخلات
  WITHHELD_FROM_SUPPLIERS: "1410", // خصم تحت حساب المورد (مسترد)
  ADVANCES_TO_SUPPLIERS: "1500", // دفعات مقدمة للموردين
  // Liabilities (2xxx)
  AP: "2100", // الموردون — الدائنون (ذمم الموردين)
  AP_VAT_INPUT_PAYABLE: "2110", // ض.ق.م. مستحقة للموردين
  OUTPUT_VAT: "2401", // ضريبة مخرجات
  WITHHOLDING_PAYABLE: "2402", // الخصم تحت حساب مستحق للممول
  ACCRUED_EXPENSES: "2500", // مصروفات مستحقة
  // Equity (3xxx)
  CAPITAL: "3100", // رأس المال
  RETAINED_EARNINGS: "3200", // أرباح مرحّلة
  // Revenue (4xxx)
  SALES: "4100", // إيرادات المبيعات
  SALES_RETURN: "4101", // مردود المبيعات
  OTHER_INCOME: "4900", // إيرادات أخرى
  // Expenses (5xxx)
  COGS: "5100", // تكلفة البضاعة المباعة
  PURCHASE_DISCOUNTS: "5110", // خصم مشتريات
  SALARIES_EXPENSE: "5200", // رواتب وأجور
  RENT_EXPENSE: "5300", // إيجارات
  UTILITIES_EXPENSE: "5400", // كهرباء ومياه
  ELECTRICITY_EXPENSE: "5401", // كهرباء
  WATER_EXPENSE: "5402", // مياه
  TELECOM_EXPENSE: "5410", // اتصالات
  INTERNET_EXPENSE: "5412", // انترنت
  MAINTENANCE_EXPENSE: "5500", // صيانة
  ADMIN_EXPENSE: "5600", // مصروفات إدارية
  IT_EXPENSE: "5700", // خدمات تقنية واستضافة
  SUBSCRIPTIONS_EXPENSE: "5750", // اشتراكات ودعم فني
  FREIGHT_CHARGE: "5800", // مصاريف نقل وشحن
  TRANSPORT_EXPENSE: "5805", // نقل وتنقل
  CUSTOMS_CHARGE: "5810", // مصاريف جمارك
  BANK_CHARGES: "5900", // عمولات ومصاريف بنكية
  MISC_EXPENSE: "5990", // نثريات
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// قيود اليومية — Journal Entries (double-entry, draft → posted)
//
// A journal entry is a header (date, description, source, status) with ≥2
// balanced lines (debit/credit per account code). Draft entries are editable;
// posted entries are immutable and update GL balances. Auto-posted entries
// (from invoices/payments) reference their source so the ledger stays in sync.
// ═══════════════════════════════════════════════════════════════════════════
export const JOURNAL_STATUS = {
  draft: "draft",
  posted: "posted",
  void: "void",
} as const;

export const journalEntriesTable = pgTable("journal_entries", {
  id: serial("id").primaryKey(),
  entryNo: text("entry_no").notNull().unique(), // JE-YYYY-NNNNNN
  entryDate: text("entry_date").notNull(), // YYYY-MM-DD (fiscal date)
  description: text("description").notNull(),
  source: text("source"), // manual | supplier_invoice | supplier_payment | sales_invoice | collection | expense | vat_settlement
  sourceRefId: integer("source_ref_id"),
  status: text("status").notNull().default("draft"), // draft | posted | void
  totalDebit: numeric("total_debit", { precision: 18, scale: 4 }).notNull().default("0"),
  totalCredit: numeric("total_credit", { precision: 18, scale: 4 }).notNull().default("0"),
  employeeId: integer("employee_id").references(() => employeesTable.id),
  employeeName: text("employee_name"),
  reviewedBy: integer("reviewed_by").references(() => employeesTable.id),
  reviewedByName: text("reviewed_by_name"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertJournalEntrySchema = createInsertSchema(journalEntriesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertJournalEntry = z.infer<typeof insertJournalEntrySchema>;
export type JournalEntry = typeof journalEntriesTable.$inferSelect;

export const journalLinesTable = pgTable("journal_lines", {
  id: serial("id").primaryKey(),
  entryId: integer("entry_id")
    .notNull()
    .references(() => journalEntriesTable.id, { onDelete: "cascade" }),
  accountCode: text("account_code").notNull(), // FK by code to chart_of_accounts
  lineNo: integer("line_no").notNull().default(1),
  description: text("description"),
  debit: numeric("debit", { precision: 18, scale: 4 }).notNull().default("0"),
  credit: numeric("credit", { precision: 18, scale: 4 }).notNull().default("0"),
  // Optional sub-ledger linkage for drill-down (which customer/supplier/PO).
  partyType: text("party_type"), // customer | supplier | none
  partyId: integer("party_id"),
  partyName: text("party_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertJournalLineSchema = createInsertSchema(journalLinesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertJournalLine = z.infer<typeof insertJournalLineSchema>;
export type JournalLine = typeof journalLinesTable.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// فواتير الموردين — Supplier Invoices (AP)
//
// A supplier invoice records what the supplier billed for a purchase order:
// the net supply value + input VAT (14%) − withholding (خصم تحت حساب المورد).
// Posting a supplier invoice generates the journal entry:
//   Dr  Inventory/COGS        net
//   Dr  Input VAT             vat
//   Cr  AP (supplier)          net + vat
//   Cr  Withholding payable   withholding (if applicable)
// Three-way matching: invoice references a purchase_order (PO) and the goods
// receipts (po_item_receipts). Withholding rate from tax_settings per the
// supplier's invoice type.
// ═══════════════════════════════════════════════════════════════════════════
export const SUPPLIER_INVOICE_STATUS = {
  draft: "draft",
  posted: "posted",
  paid: "paid",
  void: "void",
} as const;

export const supplierInvoicesTable = pgTable("supplier_invoices", {
  id: serial("id").primaryKey(),
  invoiceNo: text("invoice_no").notNull().unique(), // SI-YYYY-NNNNNN (internal)
  supplierInvoiceNo: text("supplier_invoice_no"), // the supplier's own invoice no.
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  supplierName: text("supplier_name").notNull(),
  poId: integer("po_id").references(() => purchaseOrdersTable.id, { onDelete: "set null" }),
  poNo: text("po_no"),
  invoiceDate: text("invoice_date").notNull(),
  dueDate: text("due_date"),
  netAmount: numeric("net_amount", { precision: 15, scale: 4 }).notNull().default("0"),
  // Whether this supplier invoice includes VAT (ض.ق.م.). False for deals from
  // non-VAT suppliers (غير مُسجَّل) — carried NO deductible input VAT, and the
  // full amount becomes cost; drives the VAT-deficit (عجز ض.ق.م.) computation.

  hasVat: boolean("has_vat").notNull().default(true),

  vatAmount: numeric("vat_amount", { precision: 15, scale: 4 }).notNull().default("0"),
  withholdingRate: numeric("withholding_rate", { precision: 6, scale: 4 }).notNull().default("0"),
  withholdingAmount: numeric("withholding_amount", { precision: 15, scale: 4 }).notNull().default("0"),
  grossAmount: numeric("gross_amount", { precision: 15, scale: 4 }).notNull().default("0"),
  paidAmount: numeric("paid_amount", { precision: 15, scale: 4 }).notNull().default("0"),
  balance: numeric("balance", { precision: 15, scale: 4 }).notNull().default("0"),
  status: text("status").notNull().default("draft"), // draft | posted | paid | void
  journalEntryId: integer("journal_entry_id"),
  notes: text("notes"),
  employeeId: integer("employee_id").references(() => employeesTable.id),
  employeeName: text("employee_name"),
  reviewedBy: integer("reviewed_by").references(() => employeesTable.id),
  reviewedByName: text("reviewed_by_name"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertSupplierInvoiceSchema = createInsertSchema(supplierInvoicesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSupplierInvoice = z.infer<typeof insertSupplierInvoiceSchema>;
export type SupplierInvoice = typeof supplierInvoicesTable.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// مدفوعات الموردين — Supplier Payments (cash/bank out)
//
// A payment to a supplier settles one or more supplier invoices (full or
// partial). Posting generates the journal entry:
//   Dr  AP (supplier)         paidAmount
//   Dr  Withheld from suppliers withholding (already withheld at invoice)
//   Cr  Cash/Bank             paidAmount + bankCharges
//   Dr  Bank charges          bankCharges (if any)
// Linked to a supplier + optional PO + one or more supplier_invoices.
// ═══════════════════════════════════════════════════════════════════════════
export const supplierPaymentsTable = pgTable("supplier_payments", {
  id: serial("id").primaryKey(),
  paymentNo: text("payment_no").notNull().unique(), // SP-YYYY-NNNNNN
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  supplierName: text("supplier_name").notNull(),
  poId: integer("po_id").references(() => purchaseOrdersTable.id, { onDelete: "set null" }),
  poNo: text("po_no"),
  paymentDate: text("payment_date").notNull(),
  method: text("method").notNull(), // cash | bank_transfer | cheque | ...
  reference: text("reference"),
  amount: numeric("amount", { precision: 15, scale: 4 }).notNull(),
  bankCharges: numeric("bank_charges", { precision: 15, scale: 4 }).notNull().default("0"),
  cashAccountCode: text("cash_account_code").notNull().default(ACCOUNT_CODES.CASH),
  status: text("status").notNull().default("posted"), // draft | posted | void
  journalEntryId: integer("journal_entry_id"),
  notes: text("notes"),
  employeeId: integer("employee_id").references(() => employeesTable.id),
  employeeName: text("employee_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSupplierPaymentSchema = createInsertSchema(supplierPaymentsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSupplierPayment = z.infer<typeof insertSupplierPaymentSchema>;
export type SupplierPayment = typeof supplierPaymentsTable.$inferSelect;

// Which supplier invoices a payment settles (many-to-many).
export const supplierPaymentApplicationsTable = pgTable("supplier_payment_applications", {
  id: serial("id").primaryKey(),
  paymentId: integer("payment_id")
    .notNull()
    .references(() => supplierPaymentsTable.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id")
    .notNull()
    .references(() => supplierInvoicesTable.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 15, scale: 4 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SupplierPaymentApplication = typeof supplierPaymentApplicationsTable.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// فواتير البيع — Sales Invoices (AR)
//
// A sales invoice bills the customer for a customer PO (or customer RFQ). It
// carries the net sales value + output VAT (14%). Posting generates:
//   Dr  AR (customer)          net + vat
//   Cr  Sales (revenue)        net
//   Cr  Output VAT             vat
// and (perpetual) recognizes COGS for the delivered/accepted cost:
//   Dr  COGS                    realizedCost
//   Cr  Inventory               realizedCost
// A PDF (Arabic, RTL, branded like the PO PDF) can be generated and sent.
// ═══════════════════════════════════════════════════════════════════════════
export const SALES_INVOICE_STATUS = {
  draft: "draft",
  posted: "posted",
  paid: "paid",
  void: "void",
} as const;

export const salesInvoicesTable = pgTable("sales_invoices", {
  id: serial("id").primaryKey(),
  invoiceNo: text("invoice_no").notNull().unique(), // INV-YYYY-NNNNNN
  customerPoId: integer("customer_po_id").references(() => customerPosTable.id, {
    onDelete: "set null",
  }),
  customerPoNo: text("customer_po_no"),
  customerRfqId: integer("customer_rfq_id").references(() => customerRfqsTable.id, {
    onDelete: "set null",
  }),
  customerId: integer("customer_id").references(() => customersTable.id),
  customerName: text("customer_name").notNull(),
  invoiceDate: text("invoice_date").notNull(),
  dueDate: text("due_date"),
  netAmount: numeric("net_amount", { precision: 15, scale: 4 }).notNull().default("0"),
  vatAmount: numeric("vat_amount", { precision: 15, scale: 4 }).notNull().default("0"),
  grossAmount: numeric("gross_amount", { precision: 15, scale: 4 }).notNull().default("0"),
  cogsAmount: numeric("cogs_amount", { precision: 15, scale: 4 }).notNull().default("0"),
  collectedAmount: numeric("collected_amount", { precision: 15, scale: 4 }).notNull().default("0"),
  balance: numeric("balance", { precision: 15, scale: 4 }).notNull().default("0"),
  status: text("status").notNull().default("draft"), // draft | posted | paid | void
  journalEntryId: integer("journal_entry_id"),
  notes: text("notes"),
  employeeId: integer("employee_id").references(() => employeesTable.id),
  employeeName: text("employee_name"),
  reviewedBy: integer("reviewed_by").references(() => employeesTable.id),
  reviewedByName: text("reviewed_by_name"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertSalesInvoiceSchema = createInsertSchema(salesInvoicesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSalesInvoice = z.infer<typeof insertSalesInvoiceSchema>;
export type SalesInvoice = typeof salesInvoicesTable.$inferSelect;

// Sales invoice line items (mirror customer PO items billed on this invoice).
export const salesInvoiceItemsTable = pgTable("sales_invoice_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id")
    .notNull()
    .references(() => salesInvoicesTable.id, { onDelete: "cascade" }),
  customerPoItemId: integer("customer_po_item_id"),
  lineItem: text("line_item"),
  partNo: text("part_no"),
  description: text("description").notNull(),
  uom: text("uom"),
  qty: numeric("qty", { precision: 15, scale: 4 }),
  unitPrice: numeric("unit_price", { precision: 15, scale: 4 }),
  total: numeric("total", { precision: 15, scale: 4 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSalesInvoiceItemSchema = createInsertSchema(salesInvoiceItemsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSalesInvoiceItem = z.infer<typeof insertSalesInvoiceItemSchema>;
export type SalesInvoiceItem = typeof salesInvoiceItemsTable.$inferSelect;

// Monthly closing lock — الإقفال الشهري。
// Once a month (YYYY-MM) is locked, no journal entry may be created
// (or posted/voided/reviewed) with an entry_date in that month； locking
// freezes the ledger for closed periods so financial statements stay stable。
export const accountingClosingsTable = pgTable("accounting_closings", {
  id: serial("id").primaryKey(),
  period: text("period").notNull().unique(), // YYYY-MM
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  closedBy: integer("closed_by"),
  closedByName: text("closed_by_name"),
  notes: text("notes"),
});

export const insertAccountingClosingSchema = createInsertSchema(accountingClosingsTable).omit({
  id: true,
  closedAt: true,
});
export type InsertAccountingClosing = z.infer<typeof insertAccountingClosingSchema>;
export type AccountingClosing = typeof accountingClosingsTable.$inferSelect;

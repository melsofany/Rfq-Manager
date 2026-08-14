import { pgTable, text, serial, timestamp, numeric } from "drizzle-orm/pg-core";

// إعدادات الضرائب المصرية — Egyptian tax compliance settings.
//
// A single row (key = 'default') holds the company's tax identity and the
// statutory rates used throughout the accounts module:
//   vatRate         — ضريبة القيمة المضافة (القانون 67 لسنة 2016)، 14% افتراضيًا.
//   withholdingRate — خصم تحت حساب المورد (نسبة الخصم من المستوردات والتوريدات)،
//                     3% افتراضيًا وتُطبَّق على كل أمر شراء للمورد.
//
// The rates are editable so the accounts team can follow any future amendment
// (e.g. Law No. 6 of 2025) without a redeploy. Defaults are seeded in init-db.ts.
export const taxSettingsTable = pgTable("tax_settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique().default("default"),
  companyName: text("company_name"),
  companyTaxId: text("company_tax_id"),
  companyAddress: text("company_address"),
  companyPhone: text("company_phone"),
  // ضريبة القيمة المضافة — نسبة الموحدة 14% (القانون 67 لسنة 2016).
  vatRate: numeric("vat_rate", { precision: 6, scale: 4 }).notNull().default("14"),
  // خصم تحت حساب المورد — نسبة الخصم من كل أمر شراء/توريد (3% افتراضيًا).
  withholdingRate: numeric("withholding_rate", { precision: 6, scale: 4 })
    .notNull()
    .default("3"),
  // نسبة خصم إضافية على الموردين/المقاولين/مقدمي الخدمة (5% جدول الضرائب).
  withholdingRateServices: numeric("withholding_rate_services", { precision: 6, scale: 4 })
    .notNull()
    .default("5"),
  // الخصم تحت حساب ضريبة الدخل على المشتريات/التوريدات (1%).
  withholdingRatePurchases: numeric("withholding_rate_purchases", {
    precision: 6,
    scale: 4,
  })
    .notNull()
    .default("1"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type TaxSettings = typeof taxSettingsTable.$inferSelect;

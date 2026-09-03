import { pgTable, text, serial, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const suppliersTable = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  supplierId: text("supplier_id"),
  name: text("name").notNull(),
  contactPerson: text("contact_person"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  category: text("category").notNull().default("general"),
  isActive: boolean("is_active").notNull().default(true),
  // Whether the supplier issues VAT invoices (ض.ق.م.). Deals from non-VAT
  // suppliers (غير مُسجَّل‌ين) carry NO deductible input VAT — the full purchase
  // amount becomes cost (or expense), creating a VAT deficit the company must
  // absorb. Defaults true (registered suppliers) so existing rows count as VAT.
  invoiceHasVat: boolean("invoice_has_vat").notNull().default(true),
  // Timestamp of the last manual reactivation (false→true). The auto-deactivate
  // sweep counts unanswered sends since GREATEST(last_offer, reactivated_at),
  // so reactivating a supplier resets its no-reply counter and it takes 10
  // MORE unanswered sends to auto-deactivate again.
  reactivatedAt: timestamp("reactivated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertSupplierSchema = createInsertSchema(suppliersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSupplier = z.infer<typeof insertSupplierSchema>;
export type Supplier = typeof suppliersTable.$inferSelect;

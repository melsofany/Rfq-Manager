import { pgTable, text, serial, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const erpIntegrationsTable = pgTable("erp_integrations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // odoo | sap-b1 | sap-s4hana | oracle | google-sheets
  config: jsonb("config").notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastSyncStatus: text("last_sync_status"), // success | error | partial
  lastSyncError: text("last_sync_error"),
  lastSyncStats: jsonb("last_sync_stats"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertErpIntegrationSchema = createInsertSchema(erpIntegrationsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastSyncAt: true,
  lastSyncStatus: true,
  lastSyncError: true,
  lastSyncStats: true,
});

export type InsertErpIntegration = z.infer<typeof insertErpIntegrationSchema>;
export type ErpIntegration = typeof erpIntegrationsTable.$inferSelect;

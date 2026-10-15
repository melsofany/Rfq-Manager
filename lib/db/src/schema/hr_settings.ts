import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/** HR configuration (insurance rates, tax brackets, absence and fines rules). One row per setting key. Null = not configured yet. */
export const hrSettingsTable = pgTable("hr_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { rfqTable } from "./rfq";
import { suppliersTable } from "./suppliers";
import { employeesTable } from "./employees";

export const sentLogTable = pgTable("sent_log", {
  id: serial("id").primaryKey(),
  rfqId: integer("rfq_id").notNull().references(() => rfqTable.id, { onDelete: "cascade" }),
  supplierId: integer("supplier_id").notNull().references(() => suppliersTable.id),
  employeeId: integer("employee_id").references(() => employeesTable.id),
  token: text("token").notNull().unique(),
  closeDate: text("close_date"),
  linkOpened: boolean("link_opened").notNull().default(false),
  openCount: integer("open_count").notNull().default(0),
  firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }),
  lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
  offerSubmitted: boolean("offer_submitted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSentLogSchema = createInsertSchema(sentLogTable).omit({ id: true, createdAt: true });
export type InsertSentLog = z.infer<typeof insertSentLogSchema>;
export type SentLog = typeof sentLogTable.$inferSelect;

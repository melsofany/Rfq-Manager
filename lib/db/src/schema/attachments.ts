import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { rfqTable } from "./rfq";
import { offersTable } from "./offers";
import { employeesTable } from "./employees";

export const rfqAttachmentsTable = pgTable("rfq_attachments", {
  id: serial("id").primaryKey(),
  rfqId: integer("rfq_id").notNull().references(() => rfqTable.id, { onDelete: "cascade" }),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  content: text("content").notNull(), // base64-encoded file content
  uploadedBy: integer("uploaded_by").references(() => employeesTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const offerAttachmentsTable = pgTable("offer_attachments", {
  id: serial("id").primaryKey(),
  offerId: integer("offer_id").notNull().references(() => offersTable.id, { onDelete: "cascade" }),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  content: text("content").notNull(), // base64-encoded file content
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RfqAttachment = typeof rfqAttachmentsTable.$inferSelect;
export type OfferAttachment = typeof offerAttachmentsTable.$inferSelect;

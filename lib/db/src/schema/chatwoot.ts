import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Chatwoot console bridge — the mapping between a WhatsApp phone number and its
 * Chatwoot contact/conversation.
 *
 * Chatwoot is an agent console, NOT a WhatsApp channel here: our own webhook
 * stays the single gateway to Meta (it drives RFQ/PO sending, the rep bot and the
 * AI assistant). Inbound messages are mirrored INTO Chatwoot and agent replies in
 * Chatwoot are sent back OUT through our existing Meta plumbing. This table is
 * what makes a phone number resolve to the same conversation every time, so a
 * reply lands in the thread the agent is reading instead of a new one.
 */
export const chatwootLinksTable = pgTable("chatwoot_links", {
  phone: text("phone").primaryKey(),
  contactId: integer("contact_id"),
  conversationId: integer("conversation_id"),
  displayName: text("display_name"),
  supplierId: integer("supplier_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ChatwootLink = typeof chatwootLinksTable.$inferSelect;

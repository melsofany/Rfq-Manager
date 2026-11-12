import { pgTable, text, integer, timestamp, uniqueIndex, serial } from "drizzle-orm/pg-core";

/**
 * Chatwoot console bridge — the mapping between a WhatsApp phone number and its
 * Chatwoot contact/conversation.
 *
 * Chatwoot is an agent console, NOT a WhatsApp channel here: our own webhook
 * stays the single gateway to Meta (it drives RFQ/PO sending, the rep bot and the
 * AI assistant). Inbound messages are mirrored INTO Chatwoot and agent replies in
 * Chatwoot are sent back OUT through our existing Meta plumbing.
 *
 * OWNERSHIP is why a link is keyed by (phone, rfqId) rather than by phone alone.
 * One supplier routinely has several open pricing requests at once, each sent by
 * a different employee. Keying only on the phone collapses them into a single
 * thread: the supplier's reply to Ahmed's request and to Abdelrahman's request
 * arrive in the same conversation, and no one can tell which request is being
 * answered. A row per (phone, rfq) keeps each request its own conversation and
 * records the employee who owns it.
 *
 * `rfqId = 0` means "no request context" — a message that could not be tied to
 * any RFQ. It is 0 rather than NULL so it can participate in the unique index.
 */
export const chatwootLinksTable = pgTable(
  "chatwoot_links",
  {
    id: serial("id").primaryKey(),
    phone: text("phone").notNull(),
    rfqId: integer("rfq_id").notNull().default(0),
    contactId: integer("contact_id"),
    conversationId: integer("conversation_id"),
    displayName: text("display_name"),
    supplierId: integer("supplier_id"),
    employeeId: integer("employee_id"),
    employeeName: text("employee_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("chatwoot_links_phone_rfq_uq").on(t.phone, t.rfqId)],
);

export type ChatwootLink = typeof chatwootLinksTable.$inferSelect;

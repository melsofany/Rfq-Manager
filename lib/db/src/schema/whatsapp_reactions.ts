import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

export const whatsappReactionsTable = pgTable(
  "whatsapp_reactions",
  {
    id:           serial("id").primaryKey(),
    waMessageId:  text("wa_message_id").notNull(),
    reactorPhone: text("reactor_phone").notNull(),
    emoji:        text("emoji").notNull(),
    createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqReaction: unique("uniq_wa_reaction").on(t.waMessageId, t.reactorPhone),
  })
);

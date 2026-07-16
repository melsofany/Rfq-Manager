import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
  import { suppliersTable } from "./suppliers";

  export const whatsappChatsTable = pgTable("whatsapp_chats", {
    id: serial("id").primaryKey(),
    waMessageId: text("wa_message_id").unique(),
    direction: text("direction").notNull(), // "inbound" | "outbound"
    phone: text("phone").notNull(),
    supplierId: integer("supplier_id").references(() => suppliersTable.id),
    body: text("body").notNull(),
    mediaId: text("media_id"),       // WhatsApp media ID (for proxy download)
    mediaType: text("media_type"),   // "image" | "document" | "audio" | "video"
    mimeType: text("mime_type"),     // e.g. "image/jpeg"
    filename: text("filename"),      // for documents
    isRead: boolean("is_read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  });

  export type WhatsappChat = typeof whatsappChatsTable.$inferSelect;
  
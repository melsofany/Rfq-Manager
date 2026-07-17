import { pgTable, text, timestamp, customType } from "drizzle-orm/pg-core";

// Drizzle doesn't ship a built-in bytea helper, so we define one.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const whatsappMediaTable = pgTable("whatsapp_media", {
  waMediaId: text("wa_media_id").primaryKey(),
  data: bytea("data").notNull(),
  mimeType: text("mime_type").notNull(),
  filename: text("filename"),
  storedAt: timestamp("stored_at", { withTimezone: true }).notNull().defaultNow(),
});

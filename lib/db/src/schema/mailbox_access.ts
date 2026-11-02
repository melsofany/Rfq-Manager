import { pgTable, text, serial, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { employeesTable } from "./employees";

/**
 * Which employees may READ a company mailbox in the app, in addition to admins.
 * Read-only grant: nothing here allows sending or changing mail.
 */
export const mailboxAccessTable = pgTable(
  "mailbox_access",
  {
    id: serial("id").primaryKey(),
    mailbox: text("mailbox").notNull(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employeesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("mailbox_access_unique").on(t.mailbox, t.employeeId)],
);

export type MailboxAccess = typeof mailboxAccessTable.$inferSelect;

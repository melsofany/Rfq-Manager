/**
 * Who may read which mailbox in the app.
 *
 * Admins may read every mailbox on the domain. Other employees may read only
 * the mailboxes an admin granted them in `mailbox_access`. Access is read-only.
 */
import { and, eq } from "drizzle-orm";
import { db, mailboxAccessTable } from "@workspace/db";

export interface Session {
  employeeId?: number;
  role?: string;
}

export async function canReadMailbox(session: Session, mailbox: string): Promise<boolean> {
  if (!session.employeeId) return false;
  if (session.role === "admin") return true;
  const rows = await db
    .select({ id: mailboxAccessTable.id })
    .from(mailboxAccessTable)
    .where(
      and(
        eq(mailboxAccessTable.mailbox, mailbox.toLowerCase()),
        eq(mailboxAccessTable.employeeId, session.employeeId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function mailboxesGrantedTo(employeeId: number): Promise<string[]> {
  const rows = await db
    .select({ mailbox: mailboxAccessTable.mailbox })
    .from(mailboxAccessTable)
    .where(eq(mailboxAccessTable.employeeId, employeeId));
  return rows.map((r) => r.mailbox);
}

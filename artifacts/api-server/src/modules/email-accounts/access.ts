/**
 * Who may read which mailbox in the app.
 *
 * An employee may read exactly two things: their own company mailbox (the
 * address on their login, when it is on the company domain), and any mailbox an
 * admin granted them in `mailbox_access`. Admins get no extra reach here: the
 * admin can grant and revoke access, but reading mail follows the same rule for
 * everyone. Access is read-only.
 */
import { and, eq } from "drizzle-orm";
import { db, employeesTable, mailboxAccessTable } from "@workspace/db";
import { workspaceDomain } from "./directory";

export interface Session {
  employeeId?: number;
  role?: string;
}

/** The employee's own company address, or null when it is not on the domain. */
async function ownMailbox(employeeId: number): Promise<string | null> {
  const [emp] = await db
    .select({ email: employeesTable.email })
    .from(employeesTable)
    .where(eq(employeesTable.id, employeeId));
  if (!emp) return null;
  const email = emp.email.trim().toLowerCase();
  return email.endsWith(`@${workspaceDomain()}`) ? email : null;
}

export async function canReadMailbox(session: Session, mailbox: string): Promise<boolean> {
  if (!session.employeeId) return false;
  const target = mailbox.toLowerCase();
  if ((await ownMailbox(session.employeeId)) === target) return true;
  const rows = await db
    .select({ id: mailboxAccessTable.id })
    .from(mailboxAccessTable)
    .where(
      and(
        eq(mailboxAccessTable.mailbox, target),
        eq(mailboxAccessTable.employeeId, session.employeeId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Mailboxes an employee may open: their own company address plus grants. */
export async function mailboxesFor(employeeId: number): Promise<string[]> {
  const granted = await db
    .select({ mailbox: mailboxAccessTable.mailbox })
    .from(mailboxAccessTable)
    .where(eq(mailboxAccessTable.employeeId, employeeId));
  const own = await ownMailbox(employeeId);
  return [...new Set([...(own ? [own] : []), ...granted.map((g) => g.mailbox)])];
}

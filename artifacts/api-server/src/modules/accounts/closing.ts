/**
 * Accounts Module — الإقفال الشهري (monthly closing lock)
 *
 * Once a month (period = YYYY-MM) is locked, no journal entry may be
 * created, reviewed, posted, or voided with an entry_date in that month. This
 * freezes the ledger for closed periods so the financial statements stay stable
 * and audits remain consistent month-over-month.
 *
 * Routes (all behind requireAuth):
 *   GET    /accounts/closings        → list closings (most recent first)
 *   POST   /accounts/closings        → lock a month (accountant/manager/admin)
 *   DELETE /accounts/closings/:id    → unlock a month (admin only, audited)
 */
import { Router } from "express";
import {
  db,
  accountingClosingsTable,
  journalEntriesTable,
  auditLogTable,
} from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";

const router = Router();

/** YYYY-MM from a date string (or full ISO). Returns null when unparseable。 */
export function monthOf(date: string | null | undefined): string | null {
  if (!date) return null;
  const s = String(date);
  if (s.length < 7 || s[4] !== "-") return null;
  const y = s.slice(0, 4);
  const mo = s.slice(5, 7);
  if (Number.isNaN(Number(y)) || Number.isNaN(Number(mo))) return null;
  return y + "-" + mo;
}

/** Throws if `period` (YYYY-MM) is currently locked. Call before inserting
 *  journal entries / changing entry status for that month. */
export async function assertMonthOpen(period: string): Promise<void> {
  if (!period) return;
  const [lock] = await db
    .select({ id: accountingClosingsTable.id })
    .from(accountingClosingsTable)
    .where(eq(accountingClosingsTable.period, period))
    .limit(1);
  if (lock) {
    throw new Error(`الشهر ${period} مقفل ولا يمكن تسجيل قيود جديدة فيه`);
  }
}

router.get("/accounts/closings", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(accountingClosingsTable)
    .orderBy(desc(accountingClosingsTable.period));
  res.json(
    rows.map((r) => ({
      id: r.id,
      period: r.period,
      closedAt: r.closedAt?.toISOString() ?? null,
      closedBy: r.closedBy,
      closedByName: r.closedByName,
      notes: r.notes,
    })),
  );
});

router.post("/accounts/closings", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { period?: string; notes?: string | null };
  const period = body.period?.trim() ?? "";
  if (!/^\d\{4}-\d\{2}$/.test(period) || parseInt(period.slice(5, 7), 10) < 1 || parseInt(period.slice(5, 7), 10) > 12) {
    res.status(400).json({ error: "الفترة يجب أن تكون بصيغة YYYY-MM" });
    return;
  }
  const session = req.session as { employeeId?: number; role?: string; employeeName?: string };
  // Reject locking a month that still has UNPOSTED (draft/reviewed) journal entries.

  const openDrafts = await db
    .select({ id: journalEntriesTable.id })
    .from(journalEntriesTable)
    .where(sql`substr(${journalEntriesTable.entryDate}, 1, 7) = ${period} and ${journalEntriesTable.status}} != 'void'`)
    .limit(1);
  if (openDrafts.length) {
    res.status(400).json({ error: `يوجد قيود لم تُرحَّل بعد في شهر ${period} — راجعها ثم أعد المحاولة` });
    return;
  }
  const [existing] = await db
    .select()
    .from(accountingClosingsTable)
    .where(eq(accountingClosingsTable.period, period))
    .limit(1);
  if (existing) {
    res.status(400).json({ error: `شهر ${period} مقفل بالفعل` });
    return;
  }
  const [row] = await db
    .insert(accountingClosingsTable)
    .values({
      period,
      closedBy: session.employeeId ?? null,
      closedByName: session.employeeName ?? null,
      notes: body.notes ?? null,
    })
    .returning();
  await db.insert(auditLogTable).values({
    action: "closing.create",
    entityType: "accounting_closings",
    entityId: row?.id,
    employeeId: session.employeeId,
    description: `قفل شهر ${period}`,
  });
  res.status(201).json({ id: row?.id, period, closed: true });
});

router.delete("/accounts/closings/:id", requireRole("admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [lock] = await db
    .select()
    .from(accountingClosingsTable)
    .where(eq(accountingClosingsTable.id, id));
  if (!lock) {
    res.status(404).json({ error: "القفل غير موجود" });
    return;
  }
  const session = req.session as { employeeId?: number; role?: string; employeeName?: string };
  await db
    .delete(accountingClosingsTable)
    .where(eq(accountingClosingsTable.id, id));
  await db.insert(auditLogTable).values({
    action: "closing.delete",
    entityType: "accounting_closings",
    entityId: id,
    employeeId: session.employeeId,
    description: `فتح شهر ${lock.period} (إلغاء الإقفال)`,
  });
  res.json({ id, closed: false });
});

export default router;
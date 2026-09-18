/**
 * Accounts Module — دفتر الأستاذ ودليل الحسابات والتقارير المالية
 *
 * The accounting backbone: chart of accounts (دليل الحسابات), manual journal
 * entries with a draft → review → post workflow (قيود اليومية), the general
 * ledger (دفتر الأستاذ), the trial balance (ميزان المراجعة), and the financial
 * statements — income statement (قائمة الدخل) + balance sheet (الميزانية).
 *
 * Routes mounted under /accounts/... :
 *   GET    /accounts/coa                         → chart of accounts
 *   POST   /accounts/coa                         → create account (accountant+)
 *   PATCH  /accounts/coa/:id                     → update account (accountant+)
 *   DELETE /accounts/coa/:id                     → deactivate account (accountant+)
 *   GET    /accounts/journal                     → list journal entries
 *   POST   /accounts/journal                     → create draft/manual entry
 *   GET    /accounts/journal/:id                 → entry detail + lines
 *   PATCH  /accounts/journal/:id                 → edit a draft entry
 *   POST   /accounts/journal/:id/review          → mark reviewed (accountant+)
 *   POST   /accounts/journal/:id/post            → post (accountant+/admin) — immutable
 *   POST   /accounts/journal/:id/void            → void (admin)
 *   GET    /accounts/general-ledger              → GL movements per account
 *   GET    /accounts/trial-balance               → trial balance
 *   GET    /accounts/income-statement            → قائمة الدخل (P&L)
 *   GET    /accounts/balance-sheet               → الميزانية العمومية
 *   GET    /accounts/dashboard                   → accountant dashboard summary
 */
import { Router } from "express";
import {
  db,
  chartOfAccountsTable,
  journalEntriesTable,
  journalLinesTable,
  auditLogTable,
  operatingExpensesTable,
  poItemChargesTable,
  customerPoPaymentsTable,
  supplierInvoicesTable,
  salesInvoicesTable,
  ACCOUNT_CODES,
} from "@workspace/db";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { round2 } from "./tax";
import { postJournalEntry, nextEntryNo, accountBalance } from "./posting";
import { monthOf, assertMonthOpen } from "./closing";
import {
  signedFromRaw,
  currentPeriodResult,
  agingBucket,
  emptyBuckets,
  daysBetween,
  AGING_BUCKET_LABELS,
  AGING_BUCKETS,
  type AgingBucket,
} from "./reporting";

const router = Router();

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function formatNum(n: number | null): string | null {
  if (n == null) return null;
  const s = String(Math.round(n * 10000) / 10000);
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

// ───────────────────────────────────────────────────────────────────────────
// Chart of Accounts — دليل الحسابات
// ───────────────────────────────────────────────────────────────────────────
router.get("/accounts/coa", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(chartOfAccountsTable).orderBy(chartOfAccountsTable.code);
  res.json(
    rows.map((r) => ({
      id: r.id,
      code: r.code,
      nameAr: r.nameAr,
      nameEn: r.nameEn,
      type: r.type,
      parentId: r.parentId,
      isControl: r.isControl,
      isActive: r.isActive,
    })),
  );
});

router.post(
  "/accounts/coa",
  requireRole("accountant", "manager", "admin"),
  async (req, res): Promise<void> => {
    const body = (req.body ?? {}) as {
      code: string;
      nameAr: string;
      nameEn?: string | null;
      type: string;
      parentId?: number | null;
      isControl?: boolean;
    };
    if (!body.code || !body.nameAr || !body.type) {
      res.status(400).json({ error: "الكود والاسم والنوع مطلوبة" });
      return;
    }
    const session = req.session as { employeeId?: number; role?: string };
    try {
      const [row] = await db
        .insert(chartOfAccountsTable)
        .values({
          code: body.code,
          nameAr: body.nameAr,
          nameEn: body.nameEn ?? null,
          type: body.type,
          parentId: body.parentId ?? null,
          isControl: !!body.isControl,
        })
        .returning();
      await db.insert(auditLogTable).values({
        action: "coa.create",
        entityType: "chart_of_accounts",
        entityId: row!.id,
        employeeId: session.employeeId,
        description: `إنشاء حساب ${body.code} — ${body.nameAr}`,
      });
      res.json(row);
    } catch {
      res.status(400).json({ error: "كود الحساب مستخدم بالفعل" });
    }
  },
);

router.patch(
  "/accounts/coa/:id",
  requireRole("accountant", "manager", "admin"),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as {
      nameAr?: string;
      nameEn?: string | null;
      type?: string;
      parentId?: number | null;
      isControl?: boolean;
      isActive?: boolean;
    };
    const patch: Record<string, unknown> = {};
    if (body.nameAr != null) patch.nameAr = body.nameAr;
    if (body.nameEn !== undefined) patch.nameEn = body.nameEn;
    if (body.type != null) patch.type = body.type;
    if (body.parentId !== undefined) patch.parentId = body.parentId;
    if (body.isControl != null) patch.isControl = body.isControl;
    if (body.isActive != null) patch.isActive = body.isActive;
    await db.update(chartOfAccountsTable).set(patch).where(eq(chartOfAccountsTable.id, id));
    res.json({ id, ...patch });
  },
);

router.delete(
  "/accounts/coa/:id",
  requireRole("accountant", "manager", "admin"),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    await db
      .update(chartOfAccountsTable)
      .set({ isActive: false })
      .where(eq(chartOfAccountsTable.id, id));
    res.json({ id, deactivated: true });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// Journal Entries — قيود اليومية
// ───────────────────────────────────────────────────────────────────────────
router.get("/accounts/journal", requireAuth, async (req, res): Promise<void> => {
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;
  const status = (req.query.status as string) || undefined;
  const conds = [];
  if (from) conds.push(gte(journalEntriesTable.entryDate, from));
  if (to) conds.push(lte(journalEntriesTable.entryDate, to));
  if (status) conds.push(eq(journalEntriesTable.status, status));
  const rows = await db
    .select()
    .from(journalEntriesTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(journalEntriesTable.entryDate), desc(journalEntriesTable.id));
  res.json(
    rows.map((r) => ({
      id: r.id,
      entryNo: r.entryNo,
      entryDate: r.entryDate,
      description: r.description,
      source: r.source,
      sourceRefId: r.sourceRefId,
      status: r.status,
      totalDebit: formatNum(toNum(r.totalDebit)),
      totalCredit: formatNum(toNum(r.totalCredit)),
      employeeName: r.employeeName,
      reviewedByName: r.reviewedByName,
      reviewedAt: r.reviewedAt,
      postedAt: r.postedAt,
      createdAt: r.createdAt,
    })),
  );
});

router.get("/accounts/journal/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [entry] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, id));
  if (!entry) {
    res.status(404).json({ error: "القيد غير موجود" });
    return;
  }
  const lines = await db
    .select({
      id: journalLinesTable.id,
      accountCode: journalLinesTable.accountCode,
      lineNo: journalLinesTable.lineNo,
      description: journalLinesTable.description,
      debit: journalLinesTable.debit,
      credit: journalLinesTable.credit,
      partyType: journalLinesTable.partyType,
      partyId: journalLinesTable.partyId,
      partyName: journalLinesTable.partyName,
      accountName: chartOfAccountsTable.nameAr,
      accountType: chartOfAccountsTable.type,
    })
    .from(journalLinesTable)
    .leftJoin(chartOfAccountsTable, eq(journalLinesTable.accountCode, chartOfAccountsTable.code))
    .where(eq(journalLinesTable.entryId, id))
    .orderBy(journalLinesTable.lineNo);
  res.json({
    id: entry.id,
    entryNo: entry.entryNo,
    entryDate: entry.entryDate,
    description: entry.description,
    source: entry.source,
    sourceRefId: entry.sourceRefId,
    status: entry.status,
    totalDebit: formatNum(toNum(entry.totalDebit)),
    totalCredit: formatNum(toNum(entry.totalCredit)),
    employeeName: entry.employeeName,
    reviewedByName: entry.reviewedByName,
    reviewedAt: entry.reviewedAt,
    postedAt: entry.postedAt,
    createdAt: entry.createdAt,
    lines: lines.map((l) => ({
      id: l.id,
      accountCode: l.accountCode,
      accountName: l.accountName,
      accountType: l.accountType,
      lineNo: l.lineNo,
      description: l.description,
      debit: formatNum(toNum(l.debit)),
      credit: formatNum(toNum(l.credit)),
      partyType: l.partyType,
      partyId: l.partyId,
      partyName: l.partyName,
    })),
  });
});

// Create a manual journal entry (draft by default; can be posted directly by
// accountant+ role).
router.post(
  "/accounts/journal",
  requireRole("accountant", "manager", "admin"),
  async (req, res): Promise<void> => {
    const body = (req.body ?? {}) as {
      entryDate: string;
      description: string;
      status?: "draft" | "posted";
      lines: Array<{
        accountCode: string;
        description?: string;
        debit?: number | string;
        credit?: number | string;
        partyType?: string;
        partyId?: number;
        partyName?: string;
      }>;
    };
    if (
      !body.entryDate ||
      !body.description ||
      !Array.isArray(body.lines) ||
      body.lines.length < 2
    ) {
      res.status(400).json({ error: "التاريخ والوصف وبندان على الأقل مطلوبة" });
      return;
    }
    const session = req.session as { employeeId?: number; role?: string };
    try {
      const entryId = await postJournalEntry({
        entryDate: body.entryDate,
        description: body.description,
        source: "manual",
        status: body.status ?? "draft",
        employeeId: session.employeeId,
        lines: body.lines.map((l) => ({
          accountCode: l.accountCode,
          description: l.description,
          debit: toNum(l.debit) ?? 0,
          credit: toNum(l.credit) ?? 0,
          partyType: l.partyType as "customer" | "supplier" | "none" | null,
          partyId: l.partyId,
          partyName: l.partyName,
        })),
      });
      await db.insert(auditLogTable).values({
        action: "journal.create",
        entityType: "journal_entries",
        entityId: entryId,
        employeeId: session.employeeId,
        description: `إنشاء قيد يدوي بتاريخ ${body.entryDate}`,
      });
      res.json({ id: entryId });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "فشل إنشاء القيد" });
    }
  },
);

// Edit a DRAFT entry (replace lines). Posted entries are immutable.
router.patch(
  "/accounts/journal/:id",
  requireRole("accountant", "manager", "admin"),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    const [entry] = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.id, id));
    if (!entry) {
      res.status(404).json({ error: "القيد غير موجود" });
      return;
    }
    if (entry.status !== "draft") {
      res.status(400).json({ error: "لا يمكن تعديل قيد مُرّحل — استخدم الإلغاء" });
      return;
    }
    const body = (req.body ?? {}) as {
      entryDate?: string;
      description?: string;
      lines?: Array<{
        accountCode: string;
        description?: string;
        debit?: number | string;
        credit?: number | string;
        partyType?: string;
        partyId?: number;
        partyName?: string;
      }>;
    };
    if (body.entryDate) {
      try {
        await assertMonthOpen(monthOf(body.entryDate)!);
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : "الشهر مقفل" });
        return;
      }
      await db
        .update(journalEntriesTable)
        .set({ entryDate: body.entryDate })
        .where(eq(journalEntriesTable.id, id));
    }
    if (body.description) {
      await db
        .update(journalEntriesTable)
        .set({ description: body.description })
        .where(eq(journalEntriesTable.id, id));
    }
    if (Array.isArray(body.lines)) {
      await db.delete(journalLinesTable).where(eq(journalLinesTable.entryId, id));
      let lineNo = 1;
      const debitTotal = round2(body.lines.reduce((s, l) => s + (toNum(l.debit) ?? 0), 0));
      const creditTotal = round2(body.lines.reduce((s, l) => s + (toNum(l.credit) ?? 0), 0));
      if (debitTotal !== creditTotal) {
        res
          .status(400)
          .json({ error: `القيد غير متوازن: مدين ${debitTotal} ≠ دائن ${creditTotal}` });
        return;
      }
      await db.insert(journalLinesTable).values(
        body.lines.map((l) => ({
          entryId: id,
          accountCode: l.accountCode,
          lineNo: lineNo++,
          description: l.description ?? null,
          debit: String(toNum(l.debit) ?? 0),
          credit: String(toNum(l.credit) ?? 0),
          partyType: l.partyType ?? null,
          partyId: l.partyId ?? null,
          partyName: l.partyName ?? null,
        })),
      );
      await db
        .update(journalEntriesTable)
        .set({ totalDebit: String(debitTotal), totalCredit: String(creditTotal) })
        .where(eq(journalEntriesTable.id, id));
    }
    res.json({ id: id, updated: true });
  },
);

// Review (approve) a draft entry — records reviewer + timestamp.
router.post(
  "/accounts/journal/:id/review",
  requireRole("accountant", "manager", "admin"),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    const session = req.session as { employeeId?: number; role?: string; employeeName?: string };
    const [entry] = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.id, id));
    if (!entry) {
      res.status(404).json({ error: "القيد غير موجود" });
      return;
    }
    try {
      await assertMonthOpen(monthOf(entry.entryDate)!);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "الشهر مقفل" });
      return;
    }
    await db
      .update(journalEntriesTable)
      .set({
        reviewedBy: session.employeeId,
        reviewedByName: session.employeeName ?? null,
        reviewedAt: new Date(),
      })
      .where(eq(journalEntriesTable.id, id));
    res.json({ id, reviewed: true });
  },
);

// Post a reviewed draft entry → immutable, updates GL.
router.post(
  "/accounts/journal/:id/post",
  requireRole("accountant", "manager", "admin"),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    const [entry] = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.id, id));
    if (!entry) {
      res.status(404).json({ error: "القيد غير موجود" });
      return;
    }
    if (entry.status !== "draft") {
      res.status(400).json({ error: "القيد ليس مسودة" });
      return;
    }
    try {
      await assertMonthOpen(monthOf(entry.entryDate)!);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "الشهر مقفل" });
      return;
    }
    const lines = await db
      .select()
      .from(journalLinesTable)
      .where(eq(journalLinesTable.entryId, id));
    const debit = round2(lines.reduce((s, l) => s + (toNum(l.debit) ?? 0), 0));
    const credit = round2(lines.reduce((s, l) => s + (toNum(l.credit) ?? 0), 0));
    if (debit !== credit || debit === 0) {
      res.status(400).json({ error: "القيد غير متوازن أو صفر — لا يمكن الترحيل" });
      return;
    }
    const session = req.session as { employeeId?: number; role?: string; employeeName?: string };
    await db
      .update(journalEntriesTable)
      .set({ status: "posted", postedAt: new Date() })
      .where(eq(journalEntriesTable.id, id));
    await db.insert(auditLogTable).values({
      action: "journal.post",
      entityType: "journal_entries",
      entityId: id,
      employeeId: session.employeeId,
      description: `ترحيل القيد ${entry.entryNo}`,
    });
    res.json({ id, posted: true });
  },
);

// Void a posted entry (creates a reversal-style flag — keeps the original for
// audit, marks it void so it no longer contributes to GL balances).
router.post("/accounts/journal/:id/void", requireRole("admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [entry] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, id));
  if (!entry) {
    res.status(404).json({ error: "القيد غير موجود" });
    return;
  }
  try {
    await assertMonthOpen(monthOf(entry.entryDate)!);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "الشهر مقفل" });
    return;
  }
  const session = req.session as { employeeId?: number; role?: string };
  await db
    .update(journalEntriesTable)
    .set({ status: "void" })
    .where(eq(journalEntriesTable.id, id));
  await db.insert(auditLogTable).values({
    action: "journal.void",
    entityType: "journal_entries",
    entityId: id,
    employeeId: session.employeeId,
    description: `إلغاء القيد ${entry.entryNo}`,
  });
  res.json({ id, voided: true });
});

// ───────────────────────────────────────────────────────────────────────────
// General Ledger — دفتر الأستاذ (movements per account)
// ───────────────────────────────────────────────────────────────────────────
router.get("/accounts/general-ledger", requireAuth, async (req, res): Promise<void> => {
  const code = (req.query.code as string) || undefined;
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;
  const lineConds = [];
  if (code) lineConds.push(eq(journalLinesTable.accountCode, code));
  const rows = await db
    .select({
      entryNo: journalEntriesTable.entryNo,
      entryDate: journalEntriesTable.entryDate,
      status: journalEntriesTable.status,
      entryDesc: journalEntriesTable.description,
      accountCode: journalLinesTable.accountCode,
      accountName: chartOfAccountsTable.nameAr,
      lineDesc: journalLinesTable.description,
      debit: journalLinesTable.debit,
      credit: journalLinesTable.credit,
    })
    .from(journalLinesTable)
    .innerJoin(journalEntriesTable, eq(journalLinesTable.entryId, journalEntriesTable.id))
    .leftJoin(chartOfAccountsTable, eq(journalLinesTable.accountCode, chartOfAccountsTable.code))
    .where(lineConds.length ? and(...lineConds) : undefined)
    .orderBy(journalEntriesTable.entryDate, journalEntriesTable.entryNo, journalLinesTable.lineNo);
  const filtered = rows.filter((r) => {
    if (r.status !== "posted") return false;
    if (from && r.entryDate < from) return false;
    if (to && r.entryDate > to) return false;
    return true;
  });
  let runDebit = 0;
  let runCredit = 0;
  const out = filtered.map((r) => {
    const d = toNum(r.debit) ?? 0;
    const c = toNum(r.credit) ?? 0;
    runDebit += d;
    runCredit += c;
    return {
      entryNo: r.entryNo,
      entryDate: r.entryDate,
      accountCode: r.accountCode,
      accountName: r.accountName,
      description: r.lineDesc ?? r.entryDesc,
      debit: formatNum(d),
      credit: formatNum(c),
    };
  });
  res.json({
    totals: { debit: formatNum(runDebit), credit: formatNum(runCredit) },
    rows: out,
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Trial Balance — ميزان المراجعة
// ───────────────────────────────────────────────────────────────────────────
router.get("/accounts/trial-balance", requireAuth, async (req, res): Promise<void> => {
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;
  const accounts = await db.select().from(chartOfAccountsTable);
  const lines = [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const a of accounts) {
    if (!a.isActive) continue;
    const bal = await accountBalance(a.code, from, to);
    // A trial balance shows each account's balance on the side it actually
    // sits: an account with a raw debit balance belongs in the debit column
    // even when its type is credit-natured (e.g. a contra account such as
    // مردود المبيعات that is running a debit balance). Deriving the column
    // from the raw sign — not from the account type — is what makes the two
    // columns tie out.
    const debit = bal.balance > 0 ? bal.balance : 0;
    const credit = bal.balance < 0 ? Math.abs(bal.balance) : 0;
    if (debit === 0 && credit === 0) continue;
    totalDebit += debit;
    totalCredit += credit;
    lines.push({
      code: a.code,
      nameAr: a.nameAr,
      type: a.type,
      debit: formatNum(round2(debit)),
      credit: formatNum(round2(credit)),
    });
  }
  res.json({
    from: from ?? null,
    to: to ?? null,
    totalDebit: formatNum(round2(totalDebit)),
    totalCredit: formatNum(round2(totalCredit)),
    balanced: round2(totalDebit) === round2(totalCredit),
    lines,
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Financial Statements — القوائم المالية
// ───────────────────────────────────────────────────────────────────────────
// Income statement: revenues − expenses = net profit (over the date range).
//
// Amounts are signed in each account's normal direction, so a contra account
// nets against its section instead of inflating it: مردود المبيعات (revenue
// type, debit balance) reduces revenue, and خصم مشتريات (expense type, credit
// balance) reduces expense.
router.get("/accounts/income-statement", requireAuth, async (req, res): Promise<void> => {
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;
  const accounts = await db.select().from(chartOfAccountsTable);
  const revenue = [];
  const expenses = [];
  let totalRevenue = 0;
  let totalExpense = 0;
  for (const a of accounts) {
    if (!a.isActive) continue;
    const bal = await accountBalance(a.code, from, to);
    if (bal.balance === 0) continue;
    if (a.type !== "revenue" && a.type !== "expense") continue;
    const amount = signedFromRaw(a.type, bal.balance);
    if (amount === 0) continue;
    if (a.type === "revenue") {
      totalRevenue += amount;
      revenue.push({ code: a.code, nameAr: a.nameAr, amount: formatNum(round2(amount)) });
    } else {
      totalExpense += amount;
      expenses.push({ code: a.code, nameAr: a.nameAr, amount: formatNum(round2(amount)) });
    }
  }
  const netProfit = round2(totalRevenue - totalExpense);
  res.json({
    from: from ?? null,
    to: to ?? null,
    revenue,
    expenses,
    totalRevenue: formatNum(round2(totalRevenue)),
    totalExpense: formatNum(round2(totalExpense)),
    netProfit: formatNum(netProfit),
  });
});

// Balance sheet: assets, liabilities, equity (as-of a date).
//
// Assets = Liabilities + Equity only holds once the unclosed period result is
// included in equity. Revenue and expense accounts are not transferred to
// retained earnings until year-end, so without folding (revenue − expenses)
// into equity every profitable company's balance sheet is out by its profit —
// the single most common way a home-grown ledger produces a statement that
// does not balance. The result is reported as its own equity line so the
// accountant can see the figure that will be capitalised at closing.
router.get("/accounts/balance-sheet", requireAuth, async (req, res): Promise<void> => {
  const asOf = (req.query.asOf as string) || undefined;
  const accounts = await db.select().from(chartOfAccountsTable);
  const sections: {
    assets: Array<{ code: string; nameAr: string; amount: string | null }>;
    liabilities: Array<{ code: string; nameAr: string; amount: string | null }>;
    equity: Array<{ code: string; nameAr: string; amount: string | null }>;
  } = {
    assets: [],
    liabilities: [],
    equity: [],
  };
  const totals = { assets: 0, liabilities: 0, equity: 0 };
  let totalRevenue = 0;
  let totalExpense = 0;
  for (const a of accounts) {
    if (!a.isActive) continue;
    const bal = await accountBalance(a.code, undefined, asOf);
    if (bal.balance === 0) continue;
    // Signed in the account's own normal direction, so a contra account nets
    // against its section (e.g. a credit balance sitting in an asset account).
    const amount = signedFromRaw(a.type, bal.balance);
    if (a.type === "asset") {
      totals.assets += amount;
      sections.assets.push({ code: a.code, nameAr: a.nameAr, amount: formatNum(round2(amount)) });
    } else if (a.type === "liability") {
      totals.liabilities += amount;
      sections.liabilities.push({
        code: a.code,
        nameAr: a.nameAr,
        amount: formatNum(round2(amount)),
      });
    } else if (a.type === "equity") {
      totals.equity += amount;
      sections.equity.push({ code: a.code, nameAr: a.nameAr, amount: formatNum(round2(amount)) });
    } else if (a.type === "revenue") {
      totalRevenue += amount;
    } else if (a.type === "expense") {
      totalExpense += amount;
    }
  }
  // Period result carried into equity until it is closed to retained earnings.
  const periodResult = currentPeriodResult(totalRevenue, totalExpense);
  if (periodResult !== 0) {
    totals.equity += periodResult;
    sections.equity.push({
      code: "RESULT",
      nameAr: periodResult >= 0 ? "نتيجة أعمال الفترة (أرباح)" : "نتيجة أعمال الفترة (خسائر)",
      amount: formatNum(periodResult),
    });
  }
  const totalAssets = round2(totals.assets);
  const totalLiabilities = round2(totals.liabilities);
  const totalEquity = round2(totals.equity);
  res.json({
    asOf: asOf ?? null,
    assets: sections.assets,
    liabilities: sections.liabilities,
    equity: sections.equity,
    totalAssets: formatNum(totalAssets),
    totalLiabilities: formatNum(totalLiabilities),
    totalEquity: formatNum(totalEquity),
    periodResult: formatNum(periodResult),
    // A balance sheet must satisfy the accounting equation; surface the check
    // so a drifting ledger is obvious instead of silently trusted.
    balanced: round2(totalAssets - (totalLiabilities + totalEquity)) === 0,
    difference: formatNum(round2(totalAssets - (totalLiabilities + totalEquity))),
  });
});

// ───────────────────────────────────────────────────────────────────────────
// أعمار الديون — Receivable / payable ageing
//
// A trading company is paid after it delivers and pays its suppliers after it
// receives, so the two ageing reports answer the questions that actually matter
// day to day: who owes us and how late, and whom do we owe and how late.
// Balances come from the invoice tables' outstanding `balance` column, bucketed
// by how far past `dueDate` each document is.
// ───────────────────────────────────────────────────────────────────────────
interface AgingRow {
  id: number;
  documentNo: string | null;
  partyName: string | null;
  documentDate: string | null;
  dueDate: string | null;
  total: number;
  balance: number;
  bucket: AgingBucket;
  daysOverdue: number;
}

function summarizeAging(rows: AgingRow[]) {
  const buckets = emptyBuckets();
  for (const r of rows) buckets[r.bucket] += r.balance;
  const total = round2(rows.reduce((s, r) => s + r.balance, 0));
  return {
    buckets: AGING_BUCKETS.map((b) => ({
      bucket: b,
      label: AGING_BUCKET_LABELS[b],
      amount: formatNum(round2(buckets[b])),
    })),
    total: formatNum(total),
    count: rows.length,
    overdue: formatNum(
      round2(rows.filter((r) => r.bucket !== "current").reduce((s, r) => s + r.balance, 0)),
    ),
  };
}

function buildAgingRows(
  rows: Array<{
    id: number;
    documentNo: string | null;
    partyName: string | null;
    documentDate: string | null;
    dueDate: string | null;
    total: unknown;
    balance: unknown;
  }>,
  asOf: string,
): AgingRow[] {
  const out: AgingRow[] = [];
  for (const r of rows) {
    const balance = toNum(r.balance) ?? 0;
    // Fully settled documents are not a receivable/payable any more.
    if (balance <= 0) continue;
    const due = r.dueDate ?? r.documentDate;
    const bucket = agingBucket(due, asOf);
    out.push({
      id: r.id,
      documentNo: r.documentNo,
      partyName: r.partyName,
      documentDate: r.documentDate,
      dueDate: r.dueDate,
      total: toNum(r.total) ?? 0,
      balance,
      bucket,
      daysOverdue: bucket === "current" || !due ? 0 : daysBetween(due, asOf),
    });
  }
  // Oldest debt first — that is the order the accountant chases them in.
  out.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return out;
}

router.get("/accounts/aging/receivables", requireAuth, async (req, res): Promise<void> => {
  const asOf = (req.query.asOf as string) || new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({
      id: salesInvoicesTable.id,
      documentNo: salesInvoicesTable.invoiceNo,
      partyName: salesInvoicesTable.customerName,
      documentDate: salesInvoicesTable.invoiceDate,
      dueDate: salesInvoicesTable.dueDate,
      total: salesInvoicesTable.grossAmount,
      balance: salesInvoicesTable.balance,
    })
    .from(salesInvoicesTable)
    .where(eq(salesInvoicesTable.status, "posted"));
  const items = buildAgingRows(rows, asOf);
  res.json({ asOf, ...summarizeAging(items), rows: items });
});

router.get("/accounts/aging/payables", requireAuth, async (req, res): Promise<void> => {
  const asOf = (req.query.asOf as string) || new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({
      id: supplierInvoicesTable.id,
      documentNo: supplierInvoicesTable.invoiceNo,
      partyName: supplierInvoicesTable.supplierName,
      documentDate: supplierInvoicesTable.invoiceDate,
      dueDate: supplierInvoicesTable.dueDate,
      total: supplierInvoicesTable.grossAmount,
      balance: supplierInvoicesTable.balance,
    })
    .from(supplierInvoicesTable)
    .where(eq(supplierInvoicesTable.status, "posted"));
  const items = buildAgingRows(rows, asOf);
  res.json({ asOf, ...summarizeAging(items), rows: items });
});

// ───────────────────────────────────────────────────────────────────────────
// Accountant dashboard — لوحة المحاسب
// ───────────────────────────────────────────────────────────────────────────
router.get("/accounts/dashboard", requireAuth, async (_req, res): Promise<void> => {
  // AP / AR balances (from supplier/sales invoices balances)
  const apRows = await db
    .select({ balance: supplierInvoicesTable.balance, status: supplierInvoicesTable.status })
    .from(supplierInvoicesTable);
  const arRows = await db
    .select({ balance: salesInvoicesTable.balance, status: salesInvoicesTable.status })
    .from(salesInvoicesTable);
  const totalAP = round2(
    apRows.filter((r) => r.status === "posted").reduce((s, r) => s + (toNum(r.balance) ?? 0), 0),
  );
  const totalAR = round2(
    arRows.filter((r) => r.status === "posted").reduce((s, r) => s + (toNum(r.balance) ?? 0), 0),
  );

  const cashBal = await accountBalance(ACCOUNT_CODES.CASH);
  const bankBal = await accountBalance(ACCOUNT_CODES.BANK);

  // pending (draft) journal entries awaiting review
  const draftEntries = await db
    .select({ id: journalEntriesTable.id })
    .from(journalEntriesTable)
    .where(eq(journalEntriesTable.status, "draft"));

  // recent posted entries
  const recent = await db
    .select({
      id: journalEntriesTable.id,
      entryNo: journalEntriesTable.entryNo,
      entryDate: journalEntriesTable.entryDate,
      description: journalEntriesTable.description,
      totalDebit: journalEntriesTable.totalDebit,
    })
    .from(journalEntriesTable)
    .where(eq(journalEntriesTable.status, "posted"))
    .orderBy(desc(journalEntriesTable.entryDate), desc(journalEntriesTable.id))
    .limit(8);

  res.json({
    totalAP: formatNum(totalAP),
    totalAR: formatNum(totalAR),
    cash: formatNum(cashBal.balance),
    bank: formatNum(bankBal.balance),
    pendingDrafts: draftEntries.length,
    recentEntries: recent.map((r) => ({
      id: r.id,
      entryNo: r.entryNo,
      entryDate: r.entryDate,
      description: r.description,
      totalDebit: formatNum(toNum(r.totalDebit)),
    })),
  });
});

export { nextEntryNo };
export default router;

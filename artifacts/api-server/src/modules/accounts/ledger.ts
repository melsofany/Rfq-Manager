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
  const rows = await db
    .select()
    .from(chartOfAccountsTable)
    .orderBy(chartOfAccountsTable.code);
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

router.post("/accounts/coa", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
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
});

router.patch("/accounts/coa/:id", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
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
});

router.delete("/accounts/coa/:id", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  await db.update(chartOfAccountsTable).set({ isActive: false }).where(eq(chartOfAccountsTable.id, id));
  res.json({ id, deactivated: true });
});

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
  const [entry] = await db
    .select()
    .from(journalEntriesTable)
    .where(eq(journalEntriesTable.id, id));
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
router.post("/accounts/journal", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
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
  if (!body.entryDate || !body.description || !Array.isArray(body.lines) || body.lines.length < 2) {
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
});

// Edit a DRAFT entry (replace lines). Posted entries are immutable.
router.patch("/accounts/journal/:id", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
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
    await db.update(journalEntriesTable).set({ entryDate: body.entryDate }).where(eq(journalEntriesTable.id, id));
  }
  if (body.description) {
    await db.update(journalEntriesTable).set({ description: body.description }).where(eq(journalEntriesTable.id, id));
  }
  if (Array.isArray(body.lines)) {
    await db.delete(journalLinesTable).where(eq(journalLinesTable.entryId, id));
    let lineNo = 1;
    const debitTotal = round2(body.lines.reduce((s, l) => s + (toNum(l.debit) ?? 0), 0));
    const creditTotal = round2(body.lines.reduce((s, l) => s + (toNum(l.credit) ?? 0), 0));
    if (debitTotal !== creditTotal) {
      res.status(400).json({ error: `القيد غير متوازن: مدين ${debitTotal} ≠ دائن ${creditTotal}` });
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
});

// Review (approve) a draft entry — records reviewer + timestamp.
router.post("/accounts/journal/:id/review", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const session = req.session as { employeeId?: number; role?: string; employeeName?: string };
  await db
    .update(journalEntriesTable)
    .set({
      reviewedBy: session.employeeId,
      reviewedByName: session.employeeName ?? null,
      reviewedAt: new Date(),
    })
    .where(eq(journalEntriesTable.id, id));
  res.json({ id, reviewed: true });
});

// Post a reviewed draft entry → immutable, updates GL.
router.post("/accounts/journal/:id/post", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
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
});

// Void a posted entry (creates a reversal-style flag — keeps the original for
// audit, marks it void so it no longer contributes to GL balances).
router.post("/accounts/journal/:id/void", requireRole("admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [entry] = await db
    .select()
    .from(journalEntriesTable)
    .where(eq(journalEntriesTable.id, id));
  if (!entry) {
    res.status(404).json({ error: "القيد غير موجود" });
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
    // Assets/expenses have natural debit balance; liabilities/equity/revenue credit.
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
    if (a.type === "revenue") {
      // revenue has natural credit balance (negative in debit-minus-credit)
      const amount = Math.abs(bal.balance);
      totalRevenue += amount;
      revenue.push({ code: a.code, nameAr: a.nameAr, amount: formatNum(round2(amount)) });
    } else if (a.type === "expense") {
      const amount = bal.balance; // expense natural debit (positive)
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
router.get("/accounts/balance-sheet", requireAuth, async (req, res): Promise<void> => {
  const asOf = (req.query.asOf as string) || undefined;
  const accounts = await db.select().from(chartOfAccountsTable);
  const sections: { assets: Array<{ code: string; nameAr: string; amount: string | null }>; liabilities: Array<{ code: string; nameAr: string; amount: string | null }>; equity: Array<{ code: string; nameAr: string; amount: string | null }> } = {
    assets: [],
    liabilities: [],
    equity: [],
  };
  const totals = { assets: 0, liabilities: 0, equity: 0 };
  for (const a of accounts) {
    if (!a.isActive) continue;
    const bal = await accountBalance(a.code, undefined, asOf);
    if (bal.balance === 0) continue;
    if (a.type === "asset") {
      totals.assets += bal.balance;
      sections.assets.push({ code: a.code, nameAr: a.nameAr, amount: formatNum(round2(bal.balance)) });
    } else if (a.type === "liability") {
      totals.liabilities += Math.abs(bal.balance);
      sections.liabilities.push({ code: a.code, nameAr: a.nameAr, amount: formatNum(round2(Math.abs(bal.balance))) });
    } else if (a.type === "equity") {
      totals.equity += Math.abs(bal.balance);
      sections.equity.push({ code: a.code, nameAr: a.nameAr, amount: formatNum(round2(Math.abs(bal.balance))) });
    }
  }
  res.json({
    asOf: asOf ?? null,
    assets: sections.assets,
    liabilities: sections.liabilities,
    equity: sections.equity,
    totalAssets: formatNum(round2(totals.assets)),
    totalLiabilities: formatNum(round2(totals.liabilities)),
    totalEquity: formatNum(round2(totals.equity)),
  });
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
  const totalAP = round2(apRows.filter((r) => r.status === "posted").reduce((s, r) => s + (toNum(r.balance) ?? 0), 0));
  const totalAR = round2(arRows.filter((r) => r.status === "posted").reduce((s, r) => s + (toNum(r.balance) ?? 0), 0));

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

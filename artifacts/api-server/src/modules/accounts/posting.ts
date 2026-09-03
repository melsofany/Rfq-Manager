/**
 * Accounts Module — مُرحِّل القيود (double-entry posting helper)
 *
 * Central helper that creates a balanced journal entry (header + lines) in one
 * call. Used by the auto-posting flows (supplier invoice, supplier payment,
 * sales invoice) and the manual journal-entry route. Enforces:
 *   • the entry's Σ debit == Σ credit (balanced) before posting;
 *   • every line's account code exists in chart_of_accounts;
 *   • posted entries are immutable (further edits → void + new entry).
 *
 * Numbering: entryNo = `JE-YYYY-NNNNNN` generated from a per-year sequence.
 */
import { db } from "@workspace/db";
import { journalEntriesTable, journalLinesTable, chartOfAccountsTable } from "@workspace/db";
import { eq, sql,and,gte,lte,desc } from "drizzle-orm";
import { round2 } from "./tax";
import { assertMonthOpen } from "./closing";

export interface JournalLineInput {
  accountCode: string;
  description?: string | null;
  debit?: number;
  credit?: number;
  partyType?: "customer" | "supplier" | "none" | null;
  partyId?: number | null;
  partyName?: string | null;
}

export interface PostJournalInput {
  entryDate: string;
  description: string;
  source: string; // manual | supplier_invoice | supplier_payment | sales_invoice | ...
  sourceRefId?: number | null;
  lines: JournalLineInput[];
  employeeId?: number | null;
  employeeName?: string | null;
  status?: "draft" | "posted"; // default posted (auto flows)
}

/** Generate the next entry no for a given prefix + year (e.g. JE-2026-000001). */
export async function nextEntryNo(prefix: string, year: number): Promise<string> {
  const pattern = `${prefix}-${year}-`;
  const rows = await db
    .select({ entryNo: journalEntriesTable.entryNo })
    .from(journalEntriesTable)
    .where(sql`${journalEntriesTable.entryNo} like ${pattern + "%"}`);
  let max = 0;
  for (const r of rows) {
    const n = parseInt(r.entryNo.slice(pattern.length), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return `${pattern}${String(max + 1).padStart(6, "0")}`;
}

/** Ensure every account code in `lines` exists in chart_of_accounts. */
async function assertAccountsExist(codes: string[]): Promise<void> {
  const uniq = Array.from(new Set(codes));
  if (!uniq.length) return;
  const found = await db
    .select({ code: chartOfAccountsTable.code })
    .from(chartOfAccountsTable)
    .where(sql`${chartOfAccountsTable.code} = any(${uniq})`);
  const foundSet = new Set(found.map((r) => r.code));
  const missing = uniq.filter((c) => !foundSet.has(c));
  if (missing.length) {
    throw new Error(`حسابات غير موجودة في دليل الحسابات: ${missing.join(", ")}`);
  }
}

/**
 * Create + (optionally) post a balanced journal entry. Returns the entry id.
 * Throws if lines are empty or unbalanced.
 */
export async function postJournalEntry(input: PostJournalInput): Promise<number> {
  const { lines } = input;
  if (!lines.length) throw new Error("القيد لا يحتوي على بنود");

  const codes = lines.map((l) => l.accountCode);
  await assertAccountsExist(codes);

  const totalDebit = round2(lines.reduce((s, l) => s + (l.debit ?? 0), 0));
  const totalCredit = round2(lines.reduce((s, l) => s + (l.credit ?? 0), 0));
  if (totalDebit !== totalCredit) {
    throw new Error(`القيد غير متوازن: مدين ${totalDebit} ≠ دائن ${totalCredit}`);
  }
  if (totalDebit === 0) throw new Error("القيد صفر — لا قيمة له");
  // Monthly closing lock — refuse posting into a locked (مقفل) period.。
  await assertMonthOpen(input.entryDate.slice(0, 7));

  const year = parseInt(input.entryDate.slice(0, 4), 10) || new Date().getFullYear();
  const entryNo = await nextEntryNo("JE", year);
  const status = input.status ?? "posted";

  const [entry] = await db
    .insert(journalEntriesTable)
    .values({
      entryNo,
      entryDate: input.entryDate,
      description: input.description,
      source: input.source,
      sourceRefId: input.sourceRefId ?? null,
      status,
      totalDebit: String(totalDebit),
      totalCredit: String(totalCredit),
      employeeId: input.employeeId ?? null,
      employeeName: input.employeeName ?? null,
      postedAt: status === "posted" ? new Date() : null,
    })
    .returning({ id: journalEntriesTable.id });

  const entryId = entry!.id;
  let lineNo = 1;
  const lineRows = lines.map((l) => ({
    entryId,
    accountCode: l.accountCode,
    lineNo: lineNo++,
    description: l.description ?? null,
    debit: String(round2(l.debit ?? 0)),
    credit: String(round2(l.credit ?? 0)),
    partyType: l.partyType ?? null,
    partyId: l.partyId ?? null,
    partyName: l.partyName ?? null,
  }));
  await db.insert(journalLinesTable).values(lineRows);
  return entryId;
}

/** GL balance for a single account code over an optional date range. */
export async function accountBalance(
  code: string,
  from?: string,
  to?: string,
): Promise<{ debit: number; credit: number; balance: number }> {
  const conds = [eq(journalLinesTable.accountCode, code)];
  // join to entry to filter by entry_date + status posted
  const rows = await db
    .select({
      debit: journalLinesTable.debit,
      credit: journalLinesTable.credit,
      entryDate: journalEntriesTable.entryDate,
      status: journalEntriesTable.status,
    })
    .from(journalLinesTable)
    .innerJoin(journalEntriesTable, eq(journalLinesTable.entryId, journalEntriesTable.id))
    .where(eq(journalLinesTable.accountCode, code));
  let debit = 0;
  let credit = 0;
  for (const r of rows) {
    if (r.status !== "posted") continue;
    if (from && r.entryDate < from) continue;
    if (to && r.entryDate > to) continue;
    debit += Number(r.debit ?? 0);
    credit += Number(r.credit ?? 0);
  }
  return { debit: round2(debit), credit: round2(credit), balance: round2(debit - credit) };
}

export { eq, and, gte, lte, desc, sql };

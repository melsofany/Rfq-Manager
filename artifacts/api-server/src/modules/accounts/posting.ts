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
 * Numbering: each document series has its own prefix + table (see NUMBER_SERIES).
 */
import { db } from "@workspace/db";
import {
  journalEntriesTable,
  journalLinesTable,
  chartOfAccountsTable,
  salesInvoicesTable,
  supplierInvoicesTable,
  supplierPaymentsTable,
  ACCOUNT_CODES,
} from "@workspace/db";
import { eq, sql, and, gte, lte, desc } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { round2 } from "./tax";
import { assertMonthOpen } from "./closing";
import { isUniqueViolation } from "../../shared/pg-errors";

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

/**
 * Generate the next number for a given prefix + year (e.g. JE-2026-000001).
 *
 * Each prefix is a separate document series living in its own table, so the
 * sequence MUST be read from that table — reading them all from journal_entries
 * restarted every invoice/payment series at 000001 and collided with the
 * existing row's UNIQUE constraint.
 */
const NUMBER_SERIES: Record<string, { table: PgTable; column: AnyPgColumn }> = {
  JE: { table: journalEntriesTable, column: journalEntriesTable.entryNo },
  INV: { table: salesInvoicesTable, column: salesInvoicesTable.invoiceNo },
  SI: { table: supplierInvoicesTable, column: supplierInvoicesTable.invoiceNo },
  SP: { table: supplierPaymentsTable, column: supplierPaymentsTable.paymentNo },
};

export async function nextEntryNo(
  prefix: string,
  year: number,
  handle: DbLike = db,
): Promise<string> {
  const series = NUMBER_SERIES[prefix];
  if (!series) throw new Error(`Unknown document series: ${prefix}`);
  const pattern = `${prefix}-${year}-`;
  const rows = await handle
    .select({ no: series.column })
    .from(series.table)
    .where(sql`${series.column} like ${pattern + "%"}`);
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.no).slice(pattern.length), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return `${pattern}${String(max + 1).padStart(6, "0")}`;
}

/**
 * The slice of the drizzle handle the posting helpers need. Both `db` and the
 * `tx` argument of `db.transaction` satisfy it, so a helper can run either
 * standalone or inside a caller's transaction.
 */
export interface DbLike {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  execute: (...args: any[]) => any;
}

/**
 * Advisory-lock keys that serialize allocation within a document series. Any
 * stable integer works as long as it never collides with another lock in this
 * app (PO numbering holds 7_391_042).
 */
const DOC_NO_LOCK_KEYS: Record<string, number> = {
  JE: 7_391_050,
  INV: 7_391_051,
  SI: 7_391_052,
  SP: 7_391_053,
};

/**
 * Insert a document whose number comes from `nextEntryNo`, serializing the
 * allocation inside a transaction that holds a per-series advisory lock.
 *
 * `nextEntryNo` reads the current maximum and adds one, so without serialization
 * two overlapping requests compute the same number and the loser violates the
 * series' UNIQUE index. That used to surface as a 500 (production: repeated
 * `sales_invoices_invoice_no_key` violations, every attempt generating
 * `INV-2026-000001`).
 *
 * The advisory lock is what actually prevents that: it makes the
 * read-max-then-insert window atomic per series. The retry below is a narrow
 * belt-and-braces for a collision that a lock cannot cover — an insert made
 * outside this helper concurrently. Measured on a real Postgres (PGlite) with 8
 * concurrent inserts: retry alone succeeded 5/8; with the lock, 8/8.
 *
 * `insert` receives the transaction handle so the row and its number commit
 * together (the lock is released at commit).
 */
export async function insertWithDocNo<T>(
  prefix: string,
  dateStr: string,
  insert: (docNo: string, tx: DbLike) => Promise<T>,
): Promise<{ docNo: string; row: T }> {
  const year = parseInt(dateStr.slice(0, 4), 10) || new Date().getFullYear();
  const lockKey = DOC_NO_LOCK_KEYS[prefix];
  const RETRIES = 5;
  let lastErr: unknown;

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        if (lockKey !== undefined) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
        }
        const docNo = await nextEntryNo(prefix, year, tx as unknown as DbLike);
        return { docNo, row: await insert(docNo, tx as unknown as DbLike) };
      });
    } catch (err) {
      // Only a number collision is retryable; anything else is a real failure.
      if (!isUniqueViolation(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error(`تعذّر توليد رقم مستند فريد (${prefix})`);
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
 * Accounts whose balance is derived from a sub-ledger and must therefore stay
 * reconcilable with it:
 *   • ذمم العملاء / ذمم الموردين — from the sales/supplier invoice tables
 *   • ض.ق.م. المدخلات / المخرجات — from those same invoices (the VAT return
 *     has to agree with the GL)
 *   • الخصم تحت حساب المورد — from supplier invoices' withholding amounts
 *
 * A manual entry into one of these silently breaks that reconciliation, so it
 * is rejected. Cash, bank and inventory are deliberately NOT in this list:
 * there is no sub-ledger behind them here, and a manual entry is the normal way
 * to record a cash expense, opening stock or an adjustment.
 */
const SUBLEDGER_CONTROLLED_CODES = new Set<string>([
  ACCOUNT_CODES.AR,
  ACCOUNT_CODES.AP,
  ACCOUNT_CODES.INPUT_VAT,
  ACCOUNT_CODES.OUTPUT_VAT,
  ACCOUNT_CODES.WITHHOLDING_PAYABLE,
]);

/**
 * Reject a manual journal that touches a sub-ledger-controlled account. Only
 * `source === "manual"` is checked — the invoice/payment/collection flows are
 * exactly the paths that keep these accounts and their sub-ledgers in step.
 */
async function assertNoControlAccounts(codes: string[], source: string): Promise<void> {
  if (source !== "manual") return;
  const targets = Array.from(new Set(codes)).filter((c) => SUBLEDGER_CONTROLLED_CODES.has(c));
  if (!targets.length) return;
  const rows = await db
    .select({ code: chartOfAccountsTable.code, nameAr: chartOfAccountsTable.nameAr })
    .from(chartOfAccountsTable)
    .where(sql`${chartOfAccountsTable.code} = any(${targets})`);
  const names = rows.map((r) => `${r.code} ${r.nameAr}`).join("، ") || targets.join("، ");
  throw new Error(
    `لا يمكن تسجيل قيد يدوي على حسابات المراقبة: ${names}. ` +
      `استخدم شاشة الفاتورة أو الدفعة الخاصة بها حتى تظل مطابقة لدفتر الأستاذ المساعد`,
  );
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
  await assertNoControlAccounts(codes, input.source);

  const totalDebit = round2(lines.reduce((s, l) => s + (l.debit ?? 0), 0));
  const totalCredit = round2(lines.reduce((s, l) => s + (l.credit ?? 0), 0));
  if (totalDebit !== totalCredit) {
    throw new Error(`القيد غير متوازن: مدين ${totalDebit} ≠ دائن ${totalCredit}`);
  }
  if (totalDebit === 0) throw new Error("القيد صفر — لا قيمة له");
  // Monthly closing lock — refuse posting into a locked (مقفل) period.。
  await assertMonthOpen(input.entryDate.slice(0, 7));

  const status = input.status ?? "posted";

  // The header and its lines must commit together: an insert that failed
  // between the two used to consume an `entry_no` while leaving an entry with
  // no lines behind.
  const { row: entryId } = await insertWithDocNo("JE", input.entryDate, async (docNo, tx) => {
    const [entry] = await tx
      .insert(journalEntriesTable)
      .values({
        entryNo: docNo,
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

    const id = entry!.id;
    let lineNo = 1;
    await tx.insert(journalLinesTable).values(
      lines.map((l) => ({
        entryId: id,
        accountCode: l.accountCode,
        lineNo: lineNo++,
        description: l.description ?? null,
        debit: String(round2(l.debit ?? 0)),
        credit: String(round2(l.credit ?? 0)),
        partyType: l.partyType ?? null,
        partyId: l.partyId ?? null,
        partyName: l.partyName ?? null,
      })),
    );
    return id;
  });
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

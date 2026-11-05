/**
 * Document numbering — the ONE place a document number is allocated.
 *
 * This module is deliberately a LEAF: it imports only the table handles and the
 * unique-violation check, never the posting helpers. Numbering is used by
 * modules outside accounting (finance issues `PAY-…` payment orders and `STM-…`
 * supplier statements), and `posting.ts` pulls in the accounts router — so
 * importing a number from there would drag the whole accounts module, and its
 * page guard, into every caller.
 */
import { db } from "@workspace/db";
import {
  journalEntriesTable,
  salesInvoicesTable,
  supplierInvoicesTable,
  supplierPaymentsTable,
  financePaymentsTable,
  financeSupplierStatementsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { isUniqueViolation } from "../../shared/pg-errors";

/**
 * Each prefix is a separate document series living in its own table, so the
 * sequence MUST be read from that table — reading them all from journal_entries
 * restarted every invoice/payment series at 000001 and collided with the
 * existing row's UNIQUE constraint.
 */
/**
 * Resolved LAZILY and PER PREFIX, never as one module-level map. Each entry
 * dereferences a `@workspace/db` table binding, so building them all at once
 * would force every caller (and every partially-mocked route test) to provide
 * the whole accounting schema — finance only ever issues `PAY`/`STM`.
 */
function seriesFor(prefix: string): { table: PgTable; column: AnyPgColumn } | undefined {
  switch (prefix) {
    case "JE":
      return { table: journalEntriesTable, column: journalEntriesTable.entryNo };
    case "INV":
      return { table: salesInvoicesTable, column: salesInvoicesTable.invoiceNo };
    case "SI":
      return { table: supplierInvoicesTable, column: supplierInvoicesTable.invoiceNo };
    case "SP":
      return { table: supplierPaymentsTable, column: supplierPaymentsTable.paymentNo };
    case "PAY":
      return { table: financePaymentsTable, column: financePaymentsTable.paymentNo };
    case "STM":
      return {
        table: financeSupplierStatementsTable,
        column: financeSupplierStatementsTable.statementNo,
      };
    default:
      return undefined;
  }
}

/**
 * The slice of the drizzle handle the numbering helpers need. Both `db` and the
 * `tx` argument of `db.transaction` satisfy it, so a helper can run either
 * standalone or inside a caller's transaction.
 */
export interface DbLike {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  execute: (...args: any[]) => any;
}

export async function nextEntryNo(
  prefix: string,
  year: number,
  handle: DbLike = db,
): Promise<string> {
  const series = seriesFor(prefix);
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
 * Advisory-lock keys that serialize allocation within a document series. Any
 * stable integer works as long as it never collides with another lock in this
 * app (PO numbering holds 7_391_042).
 */
const DOC_NO_LOCK_KEYS: Record<string, number> = {
  JE: 7_391_050,
  INV: 7_391_051,
  SI: 7_391_052,
  SP: 7_391_053,
  PAY: 7_391_054,
  STM: 7_391_055,
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

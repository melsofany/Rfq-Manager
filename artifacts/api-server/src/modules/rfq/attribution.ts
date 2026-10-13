/**
 * Attribution / responsibility periods — تثبيت الإنجاز وفترات الإسناد
 *
 * Two rules live here and nowhere else:
 *
 *  1. **Responsibility is time-ranged.** A change of owner closes the current
 *     period (`valid_to = freezeAt`) and opens a new one — history is never
 *     overwritten. Every writer locks the item row first (ascending id order)
 *     so two concurrent writers cannot interleave, and the gist EXCLUDE
 *     constraint is the database-level backstop.
 *
 *  2. **Attribution is frozen at the FIRST customer PO**, even when no employee
 *     is responsible at that instant (`attribution_employee_id` stays null →
 *     "غير محسوم"). A later responsibility change can never re-attribute an
 *     item that was already frozen.
 */
import {
  db,
  customerRfqItemsTable,
  customerRfqItemAssignmentsTable,
  employeesTable,
} from "@workspace/db";
import { eq, and, isNull, sql } from "drizzle-orm";

/** The slice of the drizzle handle these helpers need (db or a tx). */
type DbLike = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

export interface OpenPeriodInput {
  customerRfqItemId: number;
  categoryId: number | null;
  employeeId: number | null;
  source: "auto" | "manual" | "inherited";
  confidence: string | null;
  assignedBy: number | null;
}

/**
 * Lock the given item rows `FOR UPDATE` in ascending id order. Ascending order
 * is what prevents a deadlock when a multi-item PO locks several rows at once.
 */
export async function lockItemRows(tx: DbLike, itemIds: number[]): Promise<void> {
  const ids = [...new Set(itemIds)].sort((a, b) => a - b);
  for (const id of ids) {
    await tx.execute(sql`SELECT id FROM customer_rfq_items WHERE id = ${id} FOR UPDATE`);
  }
}

/**
 * Close the currently-open period of an item (if any) at `at` and open a new
 * one. `at` must be a `clock_timestamp()` taken AFTER the row lock was
 * acquired — never `now()` (transaction start).
 */
export async function closeAndOpenPeriod(
  tx: DbLike,
  input: OpenPeriodInput,
  at: string,
): Promise<void> {
  await tx
    .update(customerRfqItemAssignmentsTable)
    .set({ validTo: sql`${at}::timestamptz` })
    .where(
      and(
        eq(customerRfqItemAssignmentsTable.customerRfqItemId, input.customerRfqItemId),
        isNull(customerRfqItemAssignmentsTable.validTo),
      ),
    );
  await tx.insert(customerRfqItemAssignmentsTable).values({
    customerRfqItemId: input.customerRfqItemId,
    categoryId: input.categoryId,
    employeeId: input.employeeId,
    source: input.source,
    confidence: input.confidence,
    assignedBy: input.assignedBy,
    validFrom: sql`${at}::timestamptz`,
  });
}

/** The single `clock_timestamp()` used for a freeze / period change. */
export async function dbClockTimestamp(tx: DbLike): Promise<string> {
  const r = await tx.execute(sql`SELECT clock_timestamp()::text AS ts`);
  const rows = (r as unknown as { rows?: Array<{ ts: string }> }).rows ?? [];
  return rows[0]?.ts ?? new Date().toISOString();
}

export interface FreezeResult {
  frozen: boolean;
  employeeId: number | null;
  employeeName: string | null;
  freezeAt: string;
}

/**
 * Freeze attribution for one item at its first customer PO. Idempotent: an item
 * whose `attribution_first_po_at` is already set is left untouched (the original
 * owner — possibly null — is preserved forever).
 *
 * MUST be called inside the same transaction as the PO insert, AFTER
 * `lockItemRows`.
 */
export async function freezeAttributionForItem(
  tx: DbLike,
  customerRfqItemId: number,
): Promise<FreezeResult> {
  const existing = await tx
    .select({ firstPoAt: customerRfqItemsTable.attributionFirstPoAt })
    .from(customerRfqItemsTable)
    .where(eq(customerRfqItemsTable.id, customerRfqItemId));
  const alreadyFrozen = existing[0]?.firstPoAt != null;
  if (alreadyFrozen) {
    return {
      frozen: false,
      employeeId: null,
      employeeName: null,
      freezeAt: new Date(existing[0].firstPoAt as unknown as string).toISOString(),
    };
  }

  const freezeAt = await dbClockTimestamp(tx);

  // The period active at freezeAt — the ONLY owner that may be attributed.
  const active = await tx
    .select({
      employeeId: customerRfqItemAssignmentsTable.employeeId,
      employeeName: employeesTable.name,
    })
    .from(customerRfqItemAssignmentsTable)
    .leftJoin(employeesTable, eq(customerRfqItemAssignmentsTable.employeeId, employeesTable.id))
    .where(
      and(
        eq(customerRfqItemAssignmentsTable.customerRfqItemId, customerRfqItemId),
        sql`${customerRfqItemAssignmentsTable.validFrom} <= ${freezeAt}::timestamptz`,
        sql`(${customerRfqItemAssignmentsTable.validTo} IS NULL OR ${freezeAt}::timestamptz < ${customerRfqItemAssignmentsTable.validTo})`,
      ),
    );
  const employeeId = active[0]?.employeeId ?? null;
  const employeeName = employeeId != null ? (active[0]?.employeeName ?? null) : null;

  await tx
    .update(customerRfqItemsTable)
    .set({
      attributionFirstPoAt: sql`${freezeAt}::timestamptz`,
      attributionEmployeeId: employeeId,
      attributionEmployeeName: employeeName,
      attributionEvent: "first_customer_po",
    })
    .where(
      and(
        eq(customerRfqItemsTable.id, customerRfqItemId),
        isNull(customerRfqItemsTable.attributionFirstPoAt),
      ),
    );

  return { frozen: true, employeeId, employeeName, freezeAt };
}

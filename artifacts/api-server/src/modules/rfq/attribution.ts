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
  rfqItemsTable,
  offerItemsTable,
  offersTable,
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

  // ── Attribution source: «مَن أحضر السعر الفائز» ──────────────────────────
  // Credit the employee who obtained the price the customer PO was raised on,
  // resolved in a strict order of certainty:
  //   1. The APPROVED offer's employee (`offer_items.is_approved = true` →
  //      `offers.employee_id`) — the same price the margin check (1.06×) uses.
  //   2. When NO approved price is recorded, the employee who SENT a priced
  //      offer to the supplier (the newest `offers.employee_id` for the item).
  //   3. When no offer carries an employee either, the open responsibility
  //      period owner — a deterministic fallback, never a fabricated claim.
  // The `attributionEvent` records which rung matched, so the KPI can report
  // «بدون سعر» honestly instead of crediting a category owner.
  const offersForItem = await tx
    .select({
      employeeId: offersTable.employeeId,
      isApproved: offerItemsTable.isApproved,
      createdAt: offersTable.createdAt,
    })
    .from(offerItemsTable)
    .innerJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
    .innerJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
    .where(eq(rfqItemsTable.customerRfqItemId, customerRfqItemId));

  const approvedEmployeeId =
    offersForItem.find((o) => o.isApproved && o.employeeId != null)?.employeeId ?? null;
  // Newest priced offer that recorded a sender.
  const sentEmployeeId =
    offersForItem
      .filter((o) => o.employeeId != null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.employeeId ?? null;

  let employeeId: number | null;
  let employeeName: string | null;
  let event: string;

  const chosenEmployeeId = approvedEmployeeId ?? sentEmployeeId;
  if (chosenEmployeeId != null) {
    const [emp] = await tx
      .select({ name: employeesTable.name })
      .from(employeesTable)
      .where(eq(employeesTable.id, chosenEmployeeId));
    employeeId = chosenEmployeeId;
    employeeName = emp?.name ?? null;
    event = approvedEmployeeId != null ? "first_customer_po" : "first_customer_po_sent_price";
  } else {
    // The period active at freezeAt — the fallback owner.
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
    employeeId = active[0]?.employeeId ?? null;
    employeeName = employeeId != null ? (active[0]?.employeeName ?? null) : null;
    event = "first_customer_po_no_approved_price";
  }

  await tx
    .update(customerRfqItemsTable)
    .set({
      attributionFirstPoAt: sql`${freezeAt}::timestamptz`,
      attributionEmployeeId: employeeId,
      attributionEmployeeName: employeeName,
      attributionEvent: event,
    })
    .where(
      and(
        eq(customerRfqItemsTable.id, customerRfqItemId),
        isNull(customerRfqItemsTable.attributionFirstPoAt),
      ),
    );

  return { frozen: true, employeeId, employeeName, freezeAt };
}

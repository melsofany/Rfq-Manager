/**
 * Customer-item assignment engine — إسناد بنود طلبات العملاء
 *
 * `customer_rfq_items` is the SOURCE OF TRUTH for procurement responsibility.
 * The workflow starts when the customer request arrives: its items are
 * classified and each one is assigned to the responsible procurement employee.
 * A supplier RFQ created later for the same item reads that responsibility — it
 * never creates an independent one, so one customer item sent to N suppliers
 * still has exactly ONE owner.
 *
 * An item that cannot be classified (or whose category has no owner) is left
 * UNASSIGNED on purpose — assigning it would fabricate a responsibility nobody
 * owns.
 */
import {
  db,
  customerRfqItemsTable,
  customerRfqItemAssignmentsTable,
  itemAssignmentAuditTable,
  employeesTable,
  itemCategoriesTable,
} from "@workspace/db";
import { eq, and, inArray, asc, isNull } from "drizzle-orm";
import { classifyItem, MIN_CONFIDENCE } from "./classification";
import { buildContext, loadCustomerWorkloads, type AssignContext } from "./assignment";
import { closeAndOpenPeriod, dbClockTimestamp, lockItemRows } from "./attribution";

export interface CustomerAssignOutcome {
  customerRfqItemId: number;
  categoryId: number | null;
  employeeId: number | null;
  confidence: number;
  reason: "assigned" | "unclassified" | "no_owner" | "no_employees" | "kept";
}

/** Pick the owner for a resolved category (primary first, then least loaded). */
function pickOwner(categoryId: number, ctx: AssignContext): number | null {
  const eligible = ctx.owners.get(categoryId) ?? [];
  if (eligible.length === 0) return null;
  const primary = ctx.primary.get(categoryId);
  if (primary != null && eligible.includes(primary)) return primary;
  return [...eligible].sort((a, b) => {
    const la = ctx.load.get(a) ?? 0;
    const lb = ctx.load.get(b) ?? 0;
    return la - lb || a - b;
  })[0];
}

/**
 * Classify + assign the customer items of one RFQ.
 *
 * `newItemIds` — when provided, ONLY those items are processed (used by the
 * edit path to assign newly-added rows without touching unchanged ones). When
 * omitted, every item without an existing assignment is processed (create /
 * ensure path).
 *
 * Existing assignments are NEVER overwritten here, so editing a description or
 * a part number cannot silently move responsibility. A responsibility changes
 * only through the explicit manual path (with an audit row).
 */
export async function ensureCustomerAssignments(
  customerRfqId: number,
  opts: { newItemIds?: number[] } = {},
): Promise<CustomerAssignOutcome[]> {
  const items = await db
    .select({
      id: customerRfqItemsTable.id,
      description: customerRfqItemsTable.description,
      partNo: customerRfqItemsTable.partNo,
      lineItem: customerRfqItemsTable.lineItem,
      categoryId: customerRfqItemsTable.categoryId,
    })
    .from(customerRfqItemsTable)
    .where(eq(customerRfqItemsTable.customerRfqId, customerRfqId))
    .orderBy(asc(customerRfqItemsTable.id));

  if (items.length === 0) return [];

  const targetItems =
    opts.newItemIds && opts.newItemIds.length > 0
      ? items.filter((i) => opts.newItemIds!.includes(i.id))
      : items;

  if (targetItems.length === 0) return [];

  const existing = await db
    .select({ customerRfqItemId: customerRfqItemAssignmentsTable.customerRfqItemId })
    .from(customerRfqItemAssignmentsTable)
    .where(
      inArray(
        customerRfqItemAssignmentsTable.customerRfqItemId,
        targetItems.map((i) => i.id),
      ),
    );
  const alreadyAssigned = new Set(existing.map((e) => e.customerRfqItemId));

  const [ctx, customerLoad] = await Promise.all([buildContext(), loadCustomerWorkloads()]);
  ctx.load = customerLoad;

  const outcomes: CustomerAssignOutcome[] = [];

  for (const item of targetItems) {
    if (alreadyAssigned.has(item.id)) {
      outcomes.push({
        customerRfqItemId: item.id,
        categoryId: item.categoryId ?? null,
        employeeId: null,
        confidence: 100,
        reason: "kept",
      });
      continue;
    }

    let categoryId = item.categoryId ?? null;
    let confidence = 100;
    if (categoryId == null) {
      const result = classifyItem(item, ctx.categories, ctx.vocabulary);
      categoryId = result.categoryId;
      confidence = result.confidence;
      if (categoryId != null && confidence >= MIN_CONFIDENCE) {
        await db
          .update(customerRfqItemsTable)
          .set({ categoryId })
          .where(eq(customerRfqItemsTable.id, item.id));
      } else {
        categoryId = null;
      }
    }

    if (categoryId == null) {
      outcomes.push({
        customerRfqItemId: item.id,
        categoryId: null,
        employeeId: null,
        confidence,
        reason: "unclassified",
      });
      continue;
    }

    const employeeId = pickOwner(categoryId, ctx);
    if (employeeId == null) {
      outcomes.push({
        customerRfqItemId: item.id,
        categoryId,
        employeeId: null,
        confidence,
        reason: ctx.owners.size === 0 ? "no_employees" : "no_owner",
      });
      continue;
    }

    // First assignment for this item ⇒ open its first period. `onConflictDoNothing`
    // absorbs a concurrent writer that opened the period first (the partial
    // unique index on the open period is the arbiter).
    await db
      .insert(customerRfqItemAssignmentsTable)
      .values({
        customerRfqItemId: item.id,
        categoryId,
        employeeId,
        source: "auto",
        confidence: String(confidence),
      })
      .onConflictDoNothing();

    ctx.load.set(employeeId, (ctx.load.get(employeeId) ?? 0) + 1);

    outcomes.push({
      customerRfqItemId: item.id,
      categoryId,
      employeeId,
      confidence,
      reason: "assigned",
    });
  }

  return outcomes;
}

/** Best-effort wrapper for the create/edit flows — never fails the parent. */
export async function ensureCustomerAssignmentsSafe(
  customerRfqId: number,
  opts: { newItemIds?: number[] } = {},
): Promise<void> {
  try {
    await ensureCustomerAssignments(customerRfqId, opts);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("customer assignment failed (non-fatal)", err);
  }
}

/**
 * Manual override / re-assignment of one customer item. Records an audit row
 * with the old and new values, the actor and an optional reason, so a change in
 * responsibility is always explainable after the fact.
 */
export async function assignCustomerItemManually(params: {
  customerRfqItemId: number;
  categoryId: number | null;
  employeeId: number | null;
  assignedBy: number | null;
  reason?: string | null;
}): Promise<void> {
  const { customerRfqItemId, categoryId, employeeId, assignedBy, reason } = params;

  await db.transaction(async (tx) => {
    // Lock the item row FIRST — serializes every writer of this item's periods.
    await lockItemRows(tx, [customerRfqItemId]);

    const [item] = await tx
      .select({
        id: customerRfqItemsTable.id,
        categoryId: customerRfqItemsTable.categoryId,
      })
      .from(customerRfqItemsTable)
      .where(eq(customerRfqItemsTable.id, customerRfqItemId));
    if (!item) throw new Error("customer rfq item not found");

    const [prev] = await tx
      .select({
        categoryId: customerRfqItemAssignmentsTable.categoryId,
        employeeId: customerRfqItemAssignmentsTable.employeeId,
      })
      .from(customerRfqItemAssignmentsTable)
      .where(
        and(
          eq(customerRfqItemAssignmentsTable.customerRfqItemId, customerRfqItemId),
          isNull(customerRfqItemAssignmentsTable.validTo),
        ),
      );

    const categoryChanged = (prev?.categoryId ?? null) !== (categoryId ?? null);
    const employeeChanged = (prev?.employeeId ?? null) !== (employeeId ?? null);

    if (categoryId != null) {
      await tx
        .update(customerRfqItemsTable)
        .set({ categoryId })
        .where(eq(customerRfqItemsTable.id, customerRfqItemId));
    }

    // A no-op re-save does not rewrite history — only a real change closes the
    // current period and opens a new one.
    if (categoryChanged || employeeChanged || !prev) {
      const at = await dbClockTimestamp(tx);
      await closeAndOpenPeriod(
        tx,
        {
          customerRfqItemId,
          categoryId,
          employeeId,
          source: "manual",
          confidence: null,
          assignedBy,
        },
        at,
      );
      await tx.insert(itemAssignmentAuditTable).values({
        scope: "customer",
        customerRfqItemId,
        categoryIdOld: prev?.categoryId ?? item.categoryId ?? null,
        categoryIdNew: categoryId ?? null,
        employeeIdOld: prev?.employeeId ?? null,
        employeeIdNew: employeeId ?? null,
        changedBy: assignedBy,
        reason: reason ?? null,
      });
    }
  });
}

/**
 * Resolve the responsible employee for a supplier RFQ item by reading its
 * originating CUSTOMER item. Returns null when the item has no customer origin
 * (a manually-created supplier RFQ) — such an item keeps its own independent
 * assignment and is NOT counted in the customer-item KPI.
 */
export async function responsibleForRfqItem(customerRfqItemId: number | null): Promise<{
  employeeId: number | null;
  categoryId: number | null;
  employeeName: string | null;
} | null> {
  if (customerRfqItemId == null) return null;
  const [row] = await db
    .select({
      employeeId: customerRfqItemAssignmentsTable.employeeId,
      categoryId: customerRfqItemAssignmentsTable.categoryId,
      employeeName: employeesTable.name,
    })
    .from(customerRfqItemAssignmentsTable)
    .leftJoin(employeesTable, eq(customerRfqItemAssignmentsTable.employeeId, employeesTable.id))
    .where(
      and(
        eq(customerRfqItemAssignmentsTable.customerRfqItemId, customerRfqItemId),
        isNull(customerRfqItemAssignmentsTable.validTo),
      ),
    );
  if (!row) return null;
  return {
    employeeId: row.employeeId ?? null,
    categoryId: row.categoryId ?? null,
    employeeName: row.employeeName ?? null,
  };
}

/**
 * One-time repair of open customer-item responsibilities that break the rules.
 *
 * A responsibility is wrong in two ways:
 *   - the assignment's category is not the item's category;
 *   - the assigned employee does not own the item's category (domain).
 *
 * Rules, applied to OPEN assignments only:
 *   - a MANUAL decision is never changed here; it is reported;
 *   - the owner is the category's primary owner, or its only owner; with several
 *     owners and no primary, nothing is changed and the item is reported;
 *   - an employee who already owns the category keeps the item (only the category
 *     label is corrected), so no workload is moved without need;
 *   - an item whose category has no owner is reported, never assigned to a guess.
 *
 * Mode from the env var ASSIGNMENT_REPAIR:
 *   off   — do nothing
 *   dry   — log the plan at boot, change nothing (default)
 *   apply — log the plan and apply it, one audited transaction per item
 * Applying changes responsibility (and therefore incentives), so it is only enabled
 * deliberately, after the dry-run log has been reviewed.
 */
import {
  db,
  customerRfqItemsTable,
  customerRfqItemAssignmentsTable,
  employeeCategoriesTable,
  itemAssignmentAuditTable,
} from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { loadCategories } from "./assignment";
import { isOwnableAssignment, resolveDomainId, type CategorySeed } from "./classification";
import { closeAndOpenPeriod, dbClockTimestamp, lockItemRows } from "./attribution";
import { logger } from "../../shared/logger";

export interface RepairItem {
  id: number;
  categoryId: number | null;
  cancelled: boolean;
}
export interface RepairAssignment {
  id: number;
  customerRfqItemId: number;
  categoryId: number | null;
  employeeId: number | null;
  source: string;
}
export interface OwnerRow {
  employeeId: number;
  categoryId: number;
  isPrimary: boolean;
}

export interface RepairRow {
  assignmentId: number;
  customerRfqItemId: number;
  reason: "category" | "owner" | "category+owner";
  from: { categoryId: number | null; employeeId: number | null };
  to: { categoryId: number; employeeId: number };
}

export interface RepairPlan {
  repairs: RepairRow[];
  /** Mismatched but manual: a human decided this, so it is reported only. */
  skippedManual: { assignmentId: number; customerRfqItemId: number }[];
  /** Mismatched, but the category has no single owner: reported, not guessed. */
  noOwner: { assignmentId: number; customerRfqItemId: number; categoryId: number | null }[];
  /** The item has no usable functional category. */
  uncategorized: { assignmentId: number; customerRfqItemId: number }[];
}

/** Pure planner: no database access, so the rules can be tested directly. */
export function planAssignmentRepairs(input: {
  items: RepairItem[];
  assignments: RepairAssignment[];
  categories: CategorySeed[];
  owners: OwnerRow[];
}): RepairPlan {
  const itemById = new Map(input.items.map((i) => [i.id, i]));
  const plan: RepairPlan = { repairs: [], skippedManual: [], noOwner: [], uncategorized: [] };

  const primaryOwnerOf = (domainId: number): number | null => {
    const rows = input.owners.filter((o) => o.categoryId === domainId);
    if (rows.length === 0) return null;
    const primary = rows.find((o) => o.isPrimary);
    if (primary) return primary.employeeId;
    return rows.length === 1 ? rows[0].employeeId : null;
  };

  for (const a of input.assignments) {
    const item = itemById.get(a.customerRfqItemId);
    if (!item || item.cancelled) continue;
    const categoryWrong = a.categoryId !== item.categoryId;

    if (item.categoryId == null) {
      if (categoryWrong || a.employeeId != null) {
        plan.uncategorized.push({ assignmentId: a.id, customerRfqItemId: a.customerRfqItemId });
      }
      continue;
    }
    const domainId = resolveDomainId(item.categoryId, input.categories);
    const ownersOfDomain = input.owners.filter((o) => o.categoryId === domainId);
    const currentIsOwner =
      a.employeeId != null && ownersOfDomain.some((o) => o.employeeId === a.employeeId);
    const correctEmployee = currentIsOwner ? a.employeeId : primaryOwnerOf(domainId ?? -1);
    const employeeWrong = !currentIsOwner;

    if (!categoryWrong && !employeeWrong) continue;

    if (a.source === "manual") {
      plan.skippedManual.push({ assignmentId: a.id, customerRfqItemId: a.customerRfqItemId });
      continue;
    }
    if (correctEmployee == null || domainId == null) {
      plan.noOwner.push({
        assignmentId: a.id,
        customerRfqItemId: a.customerRfqItemId,
        categoryId: item.categoryId,
      });
      continue;
    }
    if (!isOwnableAssignment(item.categoryId, correctEmployee, input.categories)) {
      plan.noOwner.push({
        assignmentId: a.id,
        customerRfqItemId: a.customerRfqItemId,
        categoryId: item.categoryId,
      });
      continue;
    }

    plan.repairs.push({
      assignmentId: a.id,
      customerRfqItemId: a.customerRfqItemId,
      reason:
        categoryWrong && employeeWrong ? "category+owner" : categoryWrong ? "category" : "owner",
      from: { categoryId: a.categoryId, employeeId: a.employeeId },
      to: { categoryId: item.categoryId, employeeId: correctEmployee },
    });
  }
  return plan;
}

/** Loads the inputs and builds the plan. Read-only. */
export async function buildAssignmentRepairPlan(): Promise<RepairPlan> {
  const items = await db
    .select({
      id: customerRfqItemsTable.id,
      categoryId: customerRfqItemsTable.categoryId,
      cancelled: customerRfqItemsTable.isCancelled,
    })
    .from(customerRfqItemsTable);
  const assignments = await db
    .select({
      id: customerRfqItemAssignmentsTable.id,
      customerRfqItemId: customerRfqItemAssignmentsTable.customerRfqItemId,
      categoryId: customerRfqItemAssignmentsTable.categoryId,
      employeeId: customerRfqItemAssignmentsTable.employeeId,
      source: customerRfqItemAssignmentsTable.source,
    })
    .from(customerRfqItemAssignmentsTable)
    .where(isNull(customerRfqItemAssignmentsTable.validTo));
  const owners = await db
    .select({
      employeeId: employeeCategoriesTable.employeeId,
      categoryId: employeeCategoriesTable.categoryId,
      isPrimary: employeeCategoriesTable.isPrimary,
    })
    .from(employeeCategoriesTable);
  const categories = await loadCategories();
  return planAssignmentRepairs({ items, assignments, categories, owners });
}

/** Applies one repair: lock, re-check that the open row is still what was planned, then audit. */
export async function applyAssignmentRepairs(plan: RepairPlan): Promise<number> {
  let applied = 0;
  for (const r of plan.repairs) {
    await db.transaction(async (tx) => {
      await lockItemRows(tx, [r.customerRfqItemId]);
      const [open] = await tx
        .select({
          id: customerRfqItemAssignmentsTable.id,
          categoryId: customerRfqItemAssignmentsTable.categoryId,
          employeeId: customerRfqItemAssignmentsTable.employeeId,
        })
        .from(customerRfqItemAssignmentsTable)
        .where(
          and(
            eq(customerRfqItemAssignmentsTable.customerRfqItemId, r.customerRfqItemId),
            isNull(customerRfqItemAssignmentsTable.validTo),
          ),
        );
      // Skip if the row changed since the plan was made.
      if (!open || open.id !== r.assignmentId) return;
      if (open.categoryId !== r.from.categoryId || open.employeeId !== r.from.employeeId) return;

      const at = await dbClockTimestamp(tx);
      await closeAndOpenPeriod(
        tx,
        {
          customerRfqItemId: r.customerRfqItemId,
          categoryId: r.to.categoryId,
          employeeId: r.to.employeeId,
          source: "auto",
          confidence: null,
          assignedBy: null,
        },
        at,
      );
      await tx.insert(itemAssignmentAuditTable).values({
        scope: "customer",
        customerRfqItemId: r.customerRfqItemId,
        categoryIdOld: r.from.categoryId,
        categoryIdNew: r.to.categoryId,
        employeeIdOld: r.from.employeeId,
        employeeIdNew: r.to.employeeId,
        changedBy: null,
        reason: `repair: ${r.reason}`,
      });
      applied += 1;
    });
  }
  return applied;
}

/** Boot hook. Default is dry-run: it logs what would change and writes nothing. */
export async function runAssignmentRepairAtBoot(): Promise<void> {
  const mode = (process.env.ASSIGNMENT_REPAIR ?? "dry").toLowerCase();
  if (mode === "off") return;
  const plan = await buildAssignmentRepairPlan();
  // Items to leave alone even when the plan proposes a change (e.g. a wrong classification
  // that a repair would make permanent). Comma-separated customer item ids.
  const skip = new Set(
    (process.env.ASSIGNMENT_REPAIR_SKIP ?? "")
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
  const skipped = plan.repairs.filter((r) => skip.has(r.customerRfqItemId));
  plan.repairs = plan.repairs.filter((r) => !skip.has(r.customerRfqItemId));
  logger.info(
    { skipped: skipped.map((r) => r.customerRfqItemId) },
    "assignment repair: skipped by ASSIGNMENT_REPAIR_SKIP",
  );
  logger.info(
    {
      mode,
      repairs: plan.repairs.length,
      skippedManual: plan.skippedManual.length,
      noOwner: plan.noOwner.length,
      uncategorized: plan.uncategorized.length,
      sample: plan.repairs.slice(0, 60),
    },
    "assignment repair plan",
  );
  if (mode === "apply") {
    const applied = await applyAssignmentRepairs(plan);
    logger.info({ applied }, "assignment repair applied");
  }
}

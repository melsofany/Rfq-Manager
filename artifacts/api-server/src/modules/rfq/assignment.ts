/**
 * Item assignment engine — إسناد البنود للموظفين
 *
 * Given an RFQ item, decides which procurement employee is responsible:
 *   1. classify the item (deterministic, see classification.ts);
 *   2. if a category was resolved, pick the owner from `employee_categories`
 *      — the primary owner, else the least-loaded eligible employee.
 *
 * An item that cannot be classified (or whose category has no owner) is left
 * UNASSIGNED on purpose. Assigning it to someone would fabricate a
 * responsibility that nobody owns, which is exactly the kind of false claim
 * this codebase has been bitten by before.
 */
import {
  db,
  itemCategoriesTable,
  itemCategoryAliasesTable,
  employeeCategoriesTable,
  employeesTable,
  rfqItemsTable,
  rfqItemAssignmentsTable,
  customerRfqItemAssignmentsTable,
  rfqTable,
} from "@workspace/db";
import { eq, inArray, sql, ne, and, isNull } from "drizzle-orm";
import {
  classifyItem,
  isOwnableAssignment,
  MIN_CONFIDENCE,
  resolveDomainId,
  type CategorySeed,
  type ClassifierVocabulary,
} from "./classification";
import { loadClassifierVocabulary } from "./keywords";
import { logger } from "../../shared/logger";

export interface AssignOutcome {
  rfqItemId: number;
  categoryId: number | null;
  employeeId: number | null;
  confidence: number;
  /** Why an employee was not chosen (for the coverage report / audit). */
  reason: "assigned" | "unclassified" | "no_owner" | "no_employees" | "inherited";
}

interface AssignContext {
  categories: CategorySeed[];
  vocabulary: ClassifierVocabulary;
  /** categoryId → eligible active employeeIds */
  owners: Map<number, number[]>;
  /** categoryId → the primary owner (if any) */
  primary: Map<number, number>;
  /** employeeId → current open assignment count */
  load: Map<number, number>;
}

export type { AssignContext };

export async function loadCategories(): Promise<CategorySeed[]> {
  const rows = await db
    .select({
      id: itemCategoriesTable.id,
      code: itemCategoriesTable.code,
      name: itemCategoriesTable.name,
      kind: itemCategoriesTable.kind,
      parentId: itemCategoriesTable.parentId,
    })
    .from(itemCategoriesTable)
    .where(eq(itemCategoriesTable.isActive, true));

  // Attach each category's aliases so «ELEC» / «Electrical» resolve to the one
  // canonical category both in the classifier and in the manager's editor.
  const aliases = await db
    .select({
      categoryId: itemCategoryAliasesTable.categoryId,
      alias: itemCategoryAliasesTable.alias,
    })
    .from(itemCategoryAliasesTable);
  if (aliases.length === 0) return rows;
  const byCat = new Map<number, string[]>();
  for (const a of aliases) {
    const list = byCat.get(a.categoryId) ?? [];
    list.push(a.alias);
    byCat.set(a.categoryId, list);
  }
  return rows.map((r) => ({ ...r, aliases: byCat.get(r.id) ?? [] }));
}

async function loadOwners(): Promise<{
  owners: Map<number, number[]>;
  primary: Map<number, number>;
}> {
  const rows = await db
    .select({
      categoryId: employeeCategoriesTable.categoryId,
      employeeId: employeeCategoriesTable.employeeId,
      isPrimary: employeeCategoriesTable.isPrimary,
      active: employeesTable.isActive,
    })
    .from(employeeCategoriesTable)
    .innerJoin(employeesTable, eq(employeeCategoriesTable.employeeId, employeesTable.id))
    .where(eq(employeesTable.isActive, true));

  const owners = new Map<number, number[]>();
  const primary = new Map<number, number>();
  for (const r of rows) {
    const arr = owners.get(r.categoryId);
    if (arr) arr.push(r.employeeId);
    else owners.set(r.categoryId, [r.employeeId]);
    if (r.isPrimary) primary.set(r.categoryId, r.employeeId);
  }
  return { owners, primary };
}

// Load = number of open (non-FAILED) RFQ items already assigned to an employee.
// Counting only open work keeps the balance meaningful over time.
async function loadWorkloads(): Promise<Map<number, number>> {
  const rows = await db
    .select({
      employeeId: rfqItemAssignmentsTable.employeeId,
      cnt: sql<number>`count(*)::int`,
    })
    .from(rfqItemAssignmentsTable)
    .innerJoin(rfqItemsTable, eq(rfqItemAssignmentsTable.rfqItemId, rfqItemsTable.id))
    .innerJoin(rfqTable, eq(rfqItemsTable.rfqId, rfqTable.id))
    .where(
      and(ne(rfqTable.status, "FAILED"), sql`${rfqItemAssignmentsTable.employeeId} IS NOT NULL`),
    )
    .groupBy(rfqItemAssignmentsTable.employeeId);

  const load = new Map<number, number>();
  for (const r of rows) {
    if (r.employeeId != null) load.set(r.employeeId, Number(r.cnt) || 0);
  }
  return load;
}

async function buildContext(categories?: CategorySeed[]): Promise<AssignContext> {
  const [cats, vocabulary, { owners, primary }, load] = await Promise.all([
    categories ? Promise.resolve(categories) : loadCategories(),
    loadClassifierVocabulary(),
    loadOwners(),
    loadWorkloads(),
  ]);
  return { categories: cats, vocabulary, owners, primary, load };
}

export { buildContext };

/**
 * Open-workload per employee for the CUSTOMER responsibility model: the number
 * of customer items currently assigned to each employee. Used to balance a
 * single customer RFQ's items across its eligible employees without counting
 * the same customer item once per supplier RFQ it was later sent to.
 */
export async function loadCustomerWorkloads(): Promise<Map<number, number>> {
  const rows = await db
    .select({
      employeeId: customerRfqItemAssignmentsTable.employeeId,
      cnt: sql<number>`count(*)::int`,
    })
    .from(customerRfqItemAssignmentsTable)
    .where(
      sql`${customerRfqItemAssignmentsTable.validTo} IS NULL AND ${customerRfqItemAssignmentsTable.employeeId} IS NOT NULL`,
    )
    .groupBy(customerRfqItemAssignmentsTable.employeeId);

  const load = new Map<number, number>();
  for (const r of rows) {
    if (r.employeeId != null) load.set(r.employeeId, Number(r.cnt) || 0);
  }
  return load;
}

/**
 * Pick the owner for a resolved category (primary first, then least loaded).
 *
 * The category is first resolved to its FUNCTIONAL DOMAIN, so a subcategory
 * (قواطع/PLC/…) never owns an item independently of its domain — and a brand,
 * which resolves to no domain, can never own one.
 */
function pickOwner(categoryId: number, ctx: AssignContext): number | null {
  const resolved = resolveDomainId(categoryId, ctx.categories);
  // A brand resolves to NO domain (null) and must never own an item; only an
  // unknown category id falls back to itself.
  if (resolved == null) return null;
  const domainId = resolved;
  const eligible = ctx.owners.get(domainId) ?? [];
  if (eligible.length === 0) return null;
  const primary = ctx.primary.get(domainId);
  if (primary != null && eligible.includes(primary)) return primary;
  // Least-loaded, deterministic tie-break by id.
  return [...eligible].sort((a, b) => {
    const la = ctx.load.get(a) ?? 0;
    const lb = ctx.load.get(b) ?? 0;
    return la - lb || a - b;
  })[0];
}

/**
 * Classify + assign every item of one RFQ that has no assignment yet, and
 * persist the resolved category onto `rfq_items.category_id`. Idempotent:
 * items already assigned are skipped, so re-running never overwrites a manual
 * override.
 */
export async function ensureAssignmentsForRfq(rfqId: number): Promise<AssignOutcome[]> {
  const items = await db
    .select({
      id: rfqItemsTable.id,
      description: rfqItemsTable.description,
      partNo: rfqItemsTable.partNo,
      lineItem: rfqItemsTable.lineItem,
      categoryId: rfqItemsTable.categoryId,
      customerRfqItemId: rfqItemsTable.customerRfqItemId,
    })
    .from(rfqItemsTable)
    .where(eq(rfqItemsTable.rfqId, rfqId));

  if (items.length === 0) return [];

  const existing = await db
    .select({ rfqItemId: rfqItemAssignmentsTable.rfqItemId })
    .from(rfqItemAssignmentsTable)
    .where(
      inArray(
        rfqItemAssignmentsTable.rfqItemId,
        items.map((i) => i.id),
      ),
    );
  const assigned = new Set(existing.map((e) => e.rfqItemId));

  const ctx = await buildContext();
  const outcomes: AssignOutcome[] = [];

  for (const item of items) {
    if (assigned.has(item.id)) continue;

    // A supplier line that originates from a customer item INHERITS that
    // customer item's responsibility — it never creates an independent one, so
    // one customer item sent to N suppliers still has a single owner.
    if (item.customerRfqItemId != null) {
      const [inherited] = await db
        .select({
          categoryId: customerRfqItemAssignmentsTable.categoryId,
          employeeId: customerRfqItemAssignmentsTable.employeeId,
        })
        .from(customerRfqItemAssignmentsTable)
        .where(
          and(
            eq(customerRfqItemAssignmentsTable.customerRfqItemId, item.customerRfqItemId),
            isNull(customerRfqItemAssignmentsTable.validTo),
          ),
        );
      if (inherited) {
        outcomes.push({
          rfqItemId: item.id,
          categoryId: inherited.categoryId ?? null,
          employeeId: inherited.employeeId ?? null,
          confidence: 100,
          reason: "inherited",
        });
        continue;
      }
    }

    let categoryId = item.categoryId ?? null;
    let confidence = 100;
    if (categoryId == null) {
      const result = classifyItem(item, ctx.categories, ctx.vocabulary);
      categoryId = result.categoryId;
      confidence = result.confidence;
      if (categoryId != null && confidence >= MIN_CONFIDENCE) {
        await db.update(rfqItemsTable).set({ categoryId }).where(eq(rfqItemsTable.id, item.id));
      } else {
        categoryId = null;
      }
    }

    if (categoryId == null) {
      outcomes.push({
        rfqItemId: item.id,
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
        rfqItemId: item.id,
        categoryId,
        employeeId: null,
        confidence,
        reason: ctx.owners.size === 0 ? "no_employees" : "no_owner",
      });
      continue;
    }

    await db
      .insert(rfqItemAssignmentsTable)
      .values({
        rfqItemId: item.id,
        customerRfqItemId: item.customerRfqItemId,
        categoryId,
        employeeId,
        source: "auto",
        confidence: String(confidence),
      })
      .onConflictDoUpdate({
        target: rfqItemAssignmentsTable.rfqItemId,
        set: { categoryId, employeeId, source: "auto", confidence: String(confidence) },
      });

    // Reflect the new load so several items of the SAME RFQ balance across the
    // eligible employees instead of all landing on the first one.
    ctx.load.set(employeeId, (ctx.load.get(employeeId) ?? 0) + 1);

    outcomes.push({
      rfqItemId: item.id,
      categoryId,
      employeeId,
      confidence,
      reason: "assigned",
    });
  }

  return outcomes;
}

/** Manual override / re-assignment of a single item (records the actor). */
export async function assignItemManually(params: {
  rfqItemId: number;
  categoryId: number | null;
  employeeId: number | null;
  assignedBy: number | null;
}): Promise<void> {
  const { rfqItemId, categoryId, employeeId, assignedBy } = params;

  const [item] = await db
    .select({ id: rfqItemsTable.id, customerRfqItemId: rfqItemsTable.customerRfqItemId })
    .from(rfqItemsTable)
    .where(eq(rfqItemsTable.id, rfqItemId));
  if (!item) {
    throw new Error("rfq item not found");
  }

  // «الماركة لا تكون مسؤولًا» — an OWNER may only be recorded for a functional
  // domain. A subcategory/brand category may still be recorded for review, but
  // then no employee is written (the assignment carries a null owner).
  let effectiveEmployeeId = employeeId;
  if (categoryId != null && employeeId != null) {
    const cats = await loadCategories();
    if (!isOwnableAssignment(categoryId, employeeId, cats)) effectiveEmployeeId = null;
  }

  if (categoryId != null) {
    await db.update(rfqItemsTable).set({ categoryId }).where(eq(rfqItemsTable.id, rfqItemId));
  }

  await db
    .insert(rfqItemAssignmentsTable)
    .values({
      rfqItemId,
      customerRfqItemId: item.customerRfqItemId,
      categoryId,
      employeeId: effectiveEmployeeId,
      source: "manual",
      confidence: null,
      assignedBy,
    })
    .onConflictDoUpdate({
      target: rfqItemAssignmentsTable.rfqItemId,
      set: {
        categoryId,
        employeeId: effectiveEmployeeId,
        source: "manual",
        confidence: null,
        assignedBy,
      },
    });
}

/** Best-effort wrapper for the create flows — never fails the parent request. */
export async function ensureAssignmentsForRfqSafe(rfqId: number): Promise<void> {
  try {
    await ensureAssignmentsForRfq(rfqId);
  } catch (err) {
    logger.warn({ err, rfqId }, "assignment: ensureAssignmentsForRfq failed (non-fatal)");
  }
}

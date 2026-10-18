/**
 * One-time cleanup of item categories, guarded by names and by the ITEM_CATEGORY_CLEANUP env var.
 *
 *   off   — nothing
 *   dry   — default: log the plan (merge, retirement, reclassification counts and samples), change nothing
 *   apply — perform the plan
 *
 * Steps:
 *   1. Merge: «إضاءة» becomes a subcategory of «كهرباء»; the duplicate «اضاءة» loses its owner
 *      link and stays inactive (it has no items and no suppliers).
 *   2. Retire «قطع غيار» (generic: car parts, coffee-machine parts, household appliances).
 *      Its items are reclassified with the same deterministic classifier to the remaining
 *      categories. An item with no confident match is left UNCLASSIFIED, never forced.
 *      The category is deactivated, not deleted: old purchase lines still reference its id.
 *
 * Every id is checked against its expected name before anything is changed.
 */
import {
  db,
  itemCategoriesTable,
  employeeCategoriesTable,
  customerRfqItemsTable,
  customerRfqItemAssignmentsTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { loadCategories } from "./assignment";
import { classifyItem, MIN_CONFIDENCE, type CategorySeed } from "./classification";
import { loadClassifierVocabulary } from "./keywords";
import { ensureCustomerAssignmentsSafe } from "./customer-assignment";
import { logger } from "../../shared/logger";

export const MERGE = {
  keepId: 871,
  keepName: "إضاءة",
  parentId: 3,
  parentName: "كهرباء",
  dropId: 38,
  dropName: "اضاءة",
};
export const RETIRE = { id: 2, name: "قطع غيار" };

export interface ReclassRow {
  itemId: number;
  customerRfqId: number | null;
  description: string;
  toCategoryId: number | null;
  toName: string | null;
  confidence: number;
}
export interface CleanupPlan {
  nameChecksOk: boolean;
  reclass: ReclassRow[];
  distribution: Record<string, number>;
  unclassified: number;
}

/** Pure: decides the target of each item of the retired category. */
export function planReclassification(
  items: {
    id: number;
    customerRfqId: number | null;
    description: string | null;
    partNo: string | null;
    lineItem: string | null;
  }[],
  categories: CategorySeed[],
  vocabulary: Parameters<typeof classifyItem>[2],
  retiredId: number,
): ReclassRow[] {
  const targets = categories.filter((c) => c.id !== retiredId);
  const nameOf = new Map(targets.map((c) => [c.id, c.name]));
  return items.map((it) => {
    const r = classifyItem(
      { description: it.description, partNo: it.partNo, lineItem: it.lineItem },
      targets,
      vocabulary,
    );
    const ok = r.categoryId != null && !r.ambiguous && r.confidence >= MIN_CONFIDENCE;
    return {
      itemId: it.id,
      customerRfqId: it.customerRfqId,
      description: (it.description ?? "").slice(0, 80),
      toCategoryId: ok ? r.categoryId : null,
      toName: ok && r.categoryId != null ? (nameOf.get(r.categoryId) ?? null) : null,
      confidence: r.confidence,
    };
  });
}

export async function buildCleanupPlan(): Promise<CleanupPlan> {
  const named = await db
    .select({ id: itemCategoriesTable.id, name: itemCategoriesTable.name })
    .from(itemCategoriesTable)
    .where(
      inArray(itemCategoriesTable.id, [MERGE.keepId, MERGE.parentId, MERGE.dropId, RETIRE.id]),
    );
  const nameById = new Map(named.map((n) => [n.id, n.name]));
  const nameChecksOk =
    nameById.get(MERGE.keepId) === MERGE.keepName &&
    nameById.get(MERGE.parentId) === MERGE.parentName &&
    nameById.get(MERGE.dropId) === MERGE.dropName &&
    nameById.get(RETIRE.id) === RETIRE.name;

  const items = await db
    .select({
      id: customerRfqItemsTable.id,
      customerRfqId: customerRfqItemsTable.customerRfqId,
      description: customerRfqItemsTable.description,
      partNo: customerRfqItemsTable.partNo,
      lineItem: customerRfqItemsTable.lineItem,
    })
    .from(customerRfqItemsTable)
    .where(
      and(
        eq(customerRfqItemsTable.categoryId, RETIRE.id),
        eq(customerRfqItemsTable.isCancelled, false),
      ),
    );

  const categories = await loadCategories();
  const vocabulary = await loadClassifierVocabulary();
  const reclass = planReclassification(items, categories, vocabulary, RETIRE.id);
  const distribution: Record<string, number> = {};
  for (const r of reclass) {
    const key = r.toName ?? "بدون تصنيف";
    distribution[key] = (distribution[key] ?? 0) + 1;
  }
  return {
    nameChecksOk,
    reclass,
    distribution,
    unclassified: reclass.filter((r) => r.toCategoryId == null).length,
  };
}

export async function applyCleanup(
  plan: CleanupPlan,
): Promise<{ reclassified: number; affectedRfqs: number }> {
  if (!plan.nameChecksOk)
    throw new Error("category names do not match the expected ids; nothing applied");
  const affected = new Set<number>();
  await db.transaction(async (tx) => {
    // 1. Merge: إضاءة becomes a subcategory of كهرباء; the duplicate loses its owner link.
    await tx
      .update(itemCategoriesTable)
      .set({ kind: "subcategory", parentId: MERGE.parentId })
      .where(eq(itemCategoriesTable.id, MERGE.keepId));
    await tx
      .delete(employeeCategoriesTable)
      .where(eq(employeeCategoriesTable.categoryId, MERGE.dropId));

    // 2. Reclassify the items of the retired category, one by one, only if still in it.
    for (const r of plan.reclass) {
      const [row] = await tx
        .update(customerRfqItemsTable)
        .set({ categoryId: r.toCategoryId, classifyReason: "cleanup: retired «قطع غيار»" })
        .where(
          and(
            eq(customerRfqItemsTable.id, r.itemId),
            eq(customerRfqItemsTable.categoryId, RETIRE.id),
          ),
        )
        .returning({ id: customerRfqItemsTable.id });
      if (row && r.customerRfqId != null) affected.add(r.customerRfqId);
    }

    // 3. Retire «قطع غيار» from use (kept for history; old purchase lines reference it).
    await tx
      .update(itemCategoriesTable)
      .set({ isActive: false })
      .where(eq(itemCategoriesTable.id, RETIRE.id));
  });

  for (const rfqId of affected) await ensureCustomerAssignmentsSafe(rfqId);
  return {
    reclassified: plan.reclass.filter((r) => r.toCategoryId != null).length,
    affectedRfqs: affected.size,
  };
}

export async function runCategoryCleanupAtBoot(): Promise<void> {
  const mode = (process.env.ITEM_CATEGORY_CLEANUP ?? "dry").toLowerCase();
  if (mode === "off") return;
  const plan = await buildCleanupPlan();
  logger.info(
    {
      mode,
      nameChecksOk: plan.nameChecksOk,
      items: plan.reclass.length,
      unclassified: plan.unclassified,
      distribution: plan.distribution,
      sample: plan.reclass.slice(0, 80),
    },
    "category cleanup plan",
  );
  if (mode === "apply") {
    const result = await applyCleanup(plan);
    logger.info(result, "category cleanup applied");
  }
}

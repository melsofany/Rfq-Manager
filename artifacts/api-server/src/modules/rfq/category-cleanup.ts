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
 *      Each of its items is moved by the SUPPLIERS' classification only:
 *        • every supplier that was sent the item or priced it, and whose supplier categories
 *          map to functional item categories, must agree on ONE category → the item moves there;
 *        • otherwise the item stays UNCLASSIFIED and carries a SUGGESTED category (from the
 *          keyword classifier, or from the suppliers' majority) for review on the categories page.
 *      Keyword matches never move an item by themselves: a generic description is not evidence.
 *      The category is deactivated, not deleted: old purchase lines still reference its id.
 *
 * Every id is checked against its expected name before anything is changed.
 */
import {
  db,
  itemCategoriesTable,
  employeeCategoriesTable,
  customerRfqItemsTable,
  rfqItemsTable,
  sentLogTable,
  offersTable,
  offerItemsTable,
  supplierCategoryLinksTable,
  supplierCategoriesTable,
  itemClassificationIdentityTable,
} from "@workspace/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { loadCategories } from "./assignment";
import { classifyItem, normalizeText, type CategorySeed } from "./classification";
import { loadClassifierVocabulary } from "./keywords";
import { classifyItemsWithAi, type AiClassifyInput } from "./ai-classifier";
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
  /** Set only when the suppliers unambiguously point to one category. */
  toCategoryId: number | null;
  toName: string | null;
  /** Best guess for the reviewer when toCategoryId is null. */
  suggestedCategoryId: number | null;
  suggestedName: string | null;
  /** How toCategoryId was decided: "supplier" or "review" (no move). */
  source: "supplier" | "review";
  /** True when the review suggestion came from the AI classifier. */
  aiSuggested?: boolean;
}
export interface CleanupPlan {
  nameChecksOk: boolean;
  reclass: ReclassRow[];
  distribution: Record<string, number>;
  unclassified: number;
}

/**
 * Pure: for each item, the functional category sets of the suppliers linked to it.
 * A supplier with no functional category match contributes nothing (no evidence).
 */
export function supplierCategorySets(
  itemSuppliers: Map<number, number[]>,
  supplierTradeNames: Map<number, string[]>,
  categories: CategorySeed[],
  retiredId: number,
): Map<number, number[][]> {
  const idByName = new Map<string, number[]>();
  for (const c of categories) {
    if (c.id === retiredId) continue;
    if (c.kind && c.kind !== "functional") continue;
    const key = normalizeText(c.name);
    idByName.set(key, [...(idByName.get(key) ?? []), c.id]);
  }
  const out = new Map<number, number[][]>();
  for (const [itemId, supplierIds] of itemSuppliers) {
    const sets: number[][] = [];
    for (const sid of new Set(supplierIds)) {
      const ids = new Set<number>();
      for (const name of supplierTradeNames.get(sid) ?? []) {
        for (const id of idByName.get(normalizeText(name)) ?? []) ids.add(id);
      }
      if (ids.size > 0) sets.push([...ids]);
    }
    out.set(itemId, sets);
  }
  return out;
}

/** Pure: decides the target (or the review suggestion) of each item of the retired category. */
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
  supplierSets: Map<number, number[][]> = new Map(),
): ReclassRow[] {
  const targets = categories.filter((c) => c.id !== retiredId);
  const nameOf = new Map(targets.map((c) => [c.id, c.name]));
  const countOf = (ids: number[][]) => {
    const votes = new Map<number, number>();
    for (const set of ids) for (const id of set) votes.set(id, (votes.get(id) ?? 0) + 1);
    return [...votes.entries()].sort((a, b) => b[1] - a[1]);
  };

  return items.map((it) => {
    // The retired category is never a target, even if a supplier mapping points at it.
    const sets = (supplierSets.get(it.id) ?? [])
      .map((set) => set.filter((id) => id !== retiredId))
      .filter((set) => set.length > 0);
    const keyword = classifyItem(
      { description: it.description, partNo: it.partNo, lineItem: it.lineItem },
      targets,
      vocabulary,
    );
    const keywordId = keyword.ambiguous ? null : keyword.categoryId;

    let toCategoryId: number | null = null;
    let suggestedCategoryId: number | null = null;
    if (sets.length > 0) {
      // Every supplier that speaks for this item must agree: the intersection is the answer.
      let common = new Set(sets[0]);
      for (const set of sets.slice(1)) common = new Set(set.filter((id) => common.has(id)));
      const candidates = [...common];
      if (candidates.length === 1) {
        toCategoryId = candidates[0];
      } else if (candidates.length > 1) {
        suggestedCategoryId =
          keywordId != null && common.has(keywordId) ? keywordId : candidates[0];
      } else {
        suggestedCategoryId = countOf(sets)[0]?.[0] ?? keywordId;
      }
    } else {
      suggestedCategoryId = keywordId;
    }

    const finalId = toCategoryId ?? suggestedCategoryId;
    return {
      itemId: it.id,
      customerRfqId: it.customerRfqId,
      description: (it.description ?? "").slice(0, 80),
      toCategoryId,
      toName: toCategoryId != null ? (nameOf.get(toCategoryId) ?? null) : null,
      suggestedCategoryId: toCategoryId == null ? suggestedCategoryId : null,
      suggestedName: toCategoryId == null && finalId != null ? (nameOf.get(finalId) ?? null) : null,
      source: toCategoryId != null ? "supplier" : "review",
    };
  });
}

/**
 * Asks the AI classifier for a suggestion on every item left without a supplier answer.
 * It only fills `suggestedCategoryId`; it never moves an item. Best-effort: if the
 * provider is unavailable the keyword suggestion stays.
 */
export async function suggestWithAi(
  reclass: ReclassRow[],
  items: Map<
    number,
    { description: string | null; partNo: string | null; lineItem: string | null }
  >,
  categories: CategorySeed[],
  retiredId: number,
  batchSize = 30,
): Promise<ReclassRow[]> {
  const targets = categories.filter(
    (c) => c.id !== retiredId && (!c.kind || c.kind === "functional"),
  );
  const nameOf = new Map(targets.map((c) => [c.id, c.name]));
  const pending = reclass.filter((r) => r.toCategoryId == null);
  const out = new Map<number, ReclassRow>(reclass.map((r) => [r.itemId, r]));
  for (let i = 0; i < pending.length; i += batchSize) {
    const slice = pending.slice(i, i + batchSize);
    const inputs: AiClassifyInput[] = slice.map((r) => {
      const it = items.get(r.itemId);
      return {
        description: it?.description ?? null,
        partNo: it?.partNo ?? null,
        lineItem: it?.lineItem ?? null,
      };
    });
    const replies = await classifyItemsWithAi(inputs, targets);
    if (!replies) break; // no provider: keep the keyword suggestions
    slice.forEach((r, idx) => {
      const ai = replies[idx];
      if (ai?.categoryId != null && nameOf.has(ai.categoryId)) {
        out.set(r.itemId, {
          ...r,
          suggestedCategoryId: ai.categoryId,
          suggestedName: nameOf.get(ai.categoryId) ?? null,
          aiSuggested: true,
        });
      }
    });
  }
  return reclass.map((r) => out.get(r.itemId) ?? r);
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
  const itemIds = items.map((i) => i.id);

  // Suppliers linked to each item: the suppliers it was sent to, and those that priced it.
  const itemSuppliers = new Map<number, number[]>();
  const addSupplier = (itemId: number, supplierId: number) => {
    itemSuppliers.set(itemId, [...(itemSuppliers.get(itemId) ?? []), supplierId]);
  };
  if (itemIds.length) {
    const sent = await db
      .select({
        itemId: rfqItemsTable.customerRfqItemId,
        supplierId: sentLogTable.supplierId,
      })
      .from(rfqItemsTable)
      .innerJoin(sentLogTable, eq(sentLogTable.rfqId, rfqItemsTable.rfqId))
      .where(inArray(rfqItemsTable.customerRfqItemId, itemIds));
    for (const r of sent) if (r.itemId != null) addSupplier(r.itemId, r.supplierId);

    const priced = await db
      .select({
        itemId: rfqItemsTable.customerRfqItemId,
        supplierId: offersTable.supplierId,
      })
      .from(offerItemsTable)
      .innerJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
      .innerJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
      .where(
        and(inArray(rfqItemsTable.customerRfqItemId, itemIds), isNotNull(offerItemsTable.price)),
      );
    for (const r of priced) if (r.itemId != null) addSupplier(r.itemId, r.supplierId);
  }

  // Trade names of those suppliers (the supplier's own category list).
  const supplierIds = [...new Set([...itemSuppliers.values()].flat())];
  const supplierTradeNames = new Map<number, string[]>();
  if (supplierIds.length) {
    const links = await db
      .select({
        supplierId: supplierCategoryLinksTable.supplierId,
        name: supplierCategoriesTable.name,
      })
      .from(supplierCategoryLinksTable)
      .innerJoin(
        supplierCategoriesTable,
        eq(supplierCategoryLinksTable.categoryId, supplierCategoriesTable.id),
      )
      .where(inArray(supplierCategoryLinksTable.supplierId, supplierIds));
    for (const l of links) {
      supplierTradeNames.set(l.supplierId, [
        ...(supplierTradeNames.get(l.supplierId) ?? []),
        l.name,
      ]);
    }
  }

  const categories = await loadCategories();
  const vocabulary = await loadClassifierVocabulary();
  const supplierSets = supplierCategorySets(
    itemSuppliers,
    supplierTradeNames,
    categories,
    RETIRE.id,
  );
  let reclass = planReclassification(items, categories, vocabulary, RETIRE.id, supplierSets);
  if (process.env.ITEM_CATEGORY_AI === "on") {
    const byId = new Map(items.map((i) => [i.id, i]));
    reclass = await suggestWithAi(reclass, byId, categories, RETIRE.id);
  }
  const distribution: Record<string, number> = {};
  for (const r of reclass) {
    const key = r.toName ?? "للمراجعة";
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
): Promise<{ reclassified: number; forReview: number; affectedRfqs: number }> {
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

    // 2. Move by supplier, or leave for review with a suggestion. Only items still in the retired category.
    for (const r of plan.reclass) {
      const [row] = await tx
        .update(customerRfqItemsTable)
        .set({
          categoryId: r.toCategoryId,
          suggestedCategoryId: r.suggestedCategoryId,
          classifyReason:
            r.toCategoryId != null ? "cleanup: تصنيف المورد" : "cleanup: قطع غيار — للمراجعة",
          classifyConfidence: null,
        })
        .where(
          and(
            eq(customerRfqItemsTable.id, r.itemId),
            eq(customerRfqItemsTable.categoryId, RETIRE.id),
          ),
        )
        .returning({ id: customerRfqItemsTable.id });
      if (row && r.customerRfqId != null) affected.add(r.customerRfqId);
    }

    // 2b. Classification memory: automatic rows that still point at «قطع غيار» would put the
    // items straight back there on the next classification. Clear them (the item then goes
    // through review). Manual decisions are never touched.
    await tx
      .update(itemClassificationIdentityTable)
      .set({ categoryId: null, subcategoryIds: null })
      .where(
        and(
          eq(itemClassificationIdentityTable.categoryId, RETIRE.id),
          eq(itemClassificationIdentityTable.source, "auto"),
        ),
      );

    // 3. Retire «قطع غيار» from use (kept for history; old purchase lines reference it).
    await tx
      .update(itemCategoriesTable)
      .set({ isActive: false })
      .where(eq(itemCategoriesTable.id, RETIRE.id));
  });

  for (const rfqId of affected) await ensureCustomerAssignmentsSafe(rfqId);
  return {
    reclassified: plan.reclass.filter((r) => r.toCategoryId != null).length,
    forReview: plan.reclass.filter((r) => r.toCategoryId == null).length,
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
      forReview: plan.unclassified,
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

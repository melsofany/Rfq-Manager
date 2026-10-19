/**
 * مجموعات المراجعة — البنود اللي ليس لها تصنيف بتتجمع حسب نصها (رقم القطعة + الوصف).
 * القرار اليدوي على المجموعة بيتطبق على كل بنودها مرة واحدة، وبيتسجل في ذاكرة التصنيف كقرار يدوي.
 */
import { db, customerRfqItemsTable, itemCategoriesTable } from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { normalizeText } from "./classification";
import { rememberClassification } from "./classification-memory";
import { ensureCustomerAssignmentsSafe } from "./customer-assignment";

export function reviewGroupKey(partNo: string | null, description: string | null): string {
  return normalizeText(`${partNo ?? ""} ${description ?? ""}`)
    .replace(/\s+/g, " ")
    .trim();
}

export interface ReviewGroupItem {
  id: number;
  partNo: string | null;
  description: string | null;
  suggestedCategoryId: number | null;
}

export interface ReviewGroup {
  key: string;
  sample: string;
  count: number;
  itemIds: number[];
  suggestedCategoryId: number | null;
  suggestedName: string | null;
}

/** Pure: groups unclassified items by their text, biggest group first. */
export function buildReviewGroups(
  items: ReviewGroupItem[],
  nameOf: Map<number, string>,
): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup & { sugg: Map<number, number> }>();
  for (const it of items) {
    const key = reviewGroupKey(it.partNo, it.description);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        sample: `${it.partNo ?? ""} ${it.description ?? ""}`.trim().slice(0, 120),
        count: 0,
        itemIds: [],
        suggestedCategoryId: null,
        suggestedName: null,
        sugg: new Map(),
      };
      groups.set(key, g);
    }
    g.count += 1;
    g.itemIds.push(it.id);
    if (it.suggestedCategoryId != null) {
      g.sugg.set(it.suggestedCategoryId, (g.sugg.get(it.suggestedCategoryId) ?? 0) + 1);
    }
  }
  return [...groups.values()]
    .map(({ sugg, ...g }) => {
      const top = [...sugg.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      return {
        ...g,
        suggestedCategoryId: top,
        suggestedName: top != null ? (nameOf.get(top) ?? null) : null,
      };
    })
    .sort((a, b) => b.count - a.count);
}

export async function listReviewGroups(): Promise<ReviewGroup[]> {
  const rows = await db
    .select({
      id: customerRfqItemsTable.id,
      partNo: customerRfqItemsTable.partNo,
      description: customerRfqItemsTable.description,
      suggestedCategoryId: customerRfqItemsTable.suggestedCategoryId,
    })
    .from(customerRfqItemsTable)
    .where(
      and(isNull(customerRfqItemsTable.categoryId), eq(customerRfqItemsTable.isCancelled, false)),
    );
  const cats = await db
    .select({ id: itemCategoriesTable.id, name: itemCategoriesTable.name })
    .from(itemCategoriesTable);
  return buildReviewGroups(rows, new Map(cats.map((c) => [c.id, c.name])));
}

export async function assignReviewGroup(params: {
  key: string;
  categoryId: number;
  decidedBy: number | null;
}): Promise<{ assigned: number; affectedRfqs: number } | { error: string; status: number }> {
  const [cat] = await db
    .select({
      id: itemCategoriesTable.id,
      kind: itemCategoriesTable.kind,
      isActive: itemCategoriesTable.isActive,
    })
    .from(itemCategoriesTable)
    .where(eq(itemCategoriesTable.id, params.categoryId))
    .limit(1);
  if (!cat || !cat.isActive || (cat.kind ?? "functional") !== "functional") {
    return { error: "اختر تصنيفًا وظيفيًا نشطًا", status: 400 };
  }

  const candidates = await db
    .select({
      id: customerRfqItemsTable.id,
      customerRfqId: customerRfqItemsTable.customerRfqId,
      partNo: customerRfqItemsTable.partNo,
      lineItem: customerRfqItemsTable.lineItem,
      description: customerRfqItemsTable.description,
    })
    .from(customerRfqItemsTable)
    .where(
      and(isNull(customerRfqItemsTable.categoryId), eq(customerRfqItemsTable.isCancelled, false)),
    );
  const ids = candidates
    .filter((c) => reviewGroupKey(c.partNo, c.description) === params.key)
    .map((c) => c.id);
  if (ids.length === 0) return { assigned: 0, affectedRfqs: 0 };

  const affected = new Set<number>();
  const rows = await db
    .update(customerRfqItemsTable)
    .set({
      categoryId: params.categoryId,
      suggestedCategoryId: null,
      classifyReason: "manual: مجموعة مراجعة",
      classifyConfidence: null,
    })
    .where(and(inArray(customerRfqItemsTable.id, ids), isNull(customerRfqItemsTable.categoryId)))
    .returning({
      id: customerRfqItemsTable.id,
      customerRfqId: customerRfqItemsTable.customerRfqId,
      partNo: customerRfqItemsTable.partNo,
      lineItem: customerRfqItemsTable.lineItem,
      description: customerRfqItemsTable.description,
    });

  for (const r of rows) {
    if (r.customerRfqId != null) affected.add(r.customerRfqId);
    // Remember the MANAGER's decision for this text, so the same item is classified the same way later.
    await rememberClassification({
      partNo: r.partNo,
      description: r.description,
      lineItem: r.lineItem,
      categoryId: params.categoryId,
      source: "manual",
      decidedBy: params.decidedBy,
    }).catch(() => null);
  }
  for (const rfqId of affected) await ensureCustomerAssignmentsSafe(rfqId);
  return { assigned: rows.length, affectedRfqs: affected.size };
}

/**
 * Resolves a classification conflict for an explicit set of items: every item gets
 * the chosen functional category at once, so a conflict group is closed with one
 * decision instead of one edit per item. Items already on the category are left as
 * they are; cancelled items are never touched. Same side effects as the group
 * assignment: the manager's decision is remembered and each RFQ's assignments are
 * re-synced.
 */
export async function resolveConflictItems(params: {
  itemIds: number[];
  categoryId: number;
  decidedBy: number | null;
}): Promise<{ assigned: number; affectedRfqs: number } | { error: string; status: number }> {
  const [cat] = await db
    .select({
      id: itemCategoriesTable.id,
      kind: itemCategoriesTable.kind,
      isActive: itemCategoriesTable.isActive,
    })
    .from(itemCategoriesTable)
    .where(eq(itemCategoriesTable.id, params.categoryId))
    .limit(1);
  if (!cat || !cat.isActive || (cat.kind ?? "functional") !== "functional") {
    return { error: "اختر تصنيفًا وظيفيًا نشطًا", status: 400 };
  }
  const ids = [...new Set(params.itemIds)];
  if (ids.length === 0) return { assigned: 0, affectedRfqs: 0 };

  const rows = await db
    .update(customerRfqItemsTable)
    .set({
      categoryId: params.categoryId,
      suggestedCategoryId: null,
      classifyReason: "manual: حل تضارب",
      classifyConfidence: null,
    })
    .where(
      and(inArray(customerRfqItemsTable.id, ids), eq(customerRfqItemsTable.isCancelled, false)),
    )
    .returning({
      id: customerRfqItemsTable.id,
      customerRfqId: customerRfqItemsTable.customerRfqId,
      partNo: customerRfqItemsTable.partNo,
      lineItem: customerRfqItemsTable.lineItem,
      description: customerRfqItemsTable.description,
    });

  const affected = new Set<number>();
  for (const r of rows) {
    if (r.customerRfqId != null) affected.add(r.customerRfqId);
    await rememberClassification({
      partNo: r.partNo,
      description: r.description,
      lineItem: r.lineItem,
      categoryId: params.categoryId,
      source: "manual",
      decidedBy: params.decidedBy,
    }).catch(() => null);
  }
  for (const rfqId of affected) await ensureCustomerAssignmentsSafe(rfqId);
  return { assigned: rows.length, affectedRfqs: affected.size };
}

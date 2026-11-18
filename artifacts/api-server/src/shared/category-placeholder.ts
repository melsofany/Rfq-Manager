/**
 * The «يحتاج للمراجعة» placeholder leaf.
 *
 * A supplier may only be filed under a LEAF. When he is filed under a grouping
 * category alone, nobody knows which leaf his trade belongs to — so instead of
 * guessing (which would file him under a trade he may not have) he is moved to a
 * placeholder leaf under that same grouping category, and the operator re-files
 * him by hand.
 *
 * The placeholder is a WORKING STATE, not a category:
 *   • one per parent — the name is unique WITHIN a branch, so every domain holds
 *     its own;
 *   • deleted as soon as it holds zero suppliers, so it can never linger as a
 *     category nobody created.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogTable,
  db,
  supplierCategoriesTable,
  supplierCategoryLinksTable,
  suppliersTable,
} from "@workspace/db";
import {
  categoryKey,
  nonLeafHolders,
  redundantParentLinks,
  type CategoryNode,
} from "./category-tree";

export const REVIEW_PLACEHOLDER_NAME = "يحتاج للمراجعة";

export function isReviewPlaceholder(name: string | null | undefined): boolean {
  return categoryKey(name) === categoryKey(REVIEW_PLACEHOLDER_NAME);
}

/**
 * The ACTIVE placeholder leaves that hold no supplier. These are the ones that
 * must be removed: the operator finished re-filing their suppliers.
 */
export function emptyReviewPlaceholderIds(
  nodes: CategoryNode[],
  links: Array<{ supplierId: number; categoryId: number }>,
): number[] {
  const held = new Set(links.map((l) => l.categoryId));
  return nodes.filter((n) => isReviewPlaceholder(n.name) && !held.has(n.id)).map((n) => n.id);
}

/**
 * The leaf a grouping category's unresolved suppliers belong in, creating it if
 * it does not exist. Idempotent: the per-parent unique index makes the second
 * call a no-op.
 */
export async function ensureReviewPlaceholder(
  parentId: number,
  handle: { insert: typeof db.insert; select: typeof db.select } = db,
): Promise<number> {
  const [existing] = await handle
    .select({ id: supplierCategoriesTable.id, name: supplierCategoriesTable.name })
    .from(supplierCategoriesTable)
    .where(eq(supplierCategoriesTable.parentId, parentId));
  if (existing && isReviewPlaceholder(existing.name)) return existing.id;

  const [row] = await handle
    .insert(supplierCategoriesTable)
    .values({ name: REVIEW_PLACEHOLDER_NAME, parentId })
    .onConflictDoNothing()
    .returning({ id: supplierCategoriesTable.id });
  if (row) return row.id;

  // The insert lost a race (or the unique index refused a row we could not see);
  // read it back rather than failing the caller.
  const [again] = await handle
    .select({ id: supplierCategoriesTable.id, name: supplierCategoriesTable.name })
    .from(supplierCategoriesTable)
    .where(eq(supplierCategoriesTable.parentId, parentId));
  if (again && isReviewPlaceholder(again.name)) return again.id;
  throw new Error("تعذّر إنشاء تصنيف «يحتاج للمراجعة»");
}

/**
 * Soft-delete every placeholder that holds no supplier. Called after any write
 * that can empty one (a supplier re-filed, a cleanup run) and at startup, so an
 * unused placeholder is never left behind.
 *
 * Soft delete — never a hard DELETE: the row is hidden and restorable, and the
 * operator's rule is that nothing is destroyed.
 */
export async function pruneEmptyReviewPlaceholders(): Promise<number> {
  const nodes = await db
    .select({
      id: supplierCategoriesTable.id,
      name: supplierCategoriesTable.name,
      parentId: supplierCategoriesTable.parentId,
    })
    .from(supplierCategoriesTable)
    .where(eq(supplierCategoriesTable.isActive, true));
  const candidates = nodes.filter((n) => isReviewPlaceholder(n.name));
  if (candidates.length === 0) return 0;

  const links = await db
    .select({ categoryId: supplierCategoryLinksTable.categoryId })
    .from(supplierCategoryLinksTable)
    .where(
      inArray(
        supplierCategoryLinksTable.categoryId,
        candidates.map((c) => c.id),
      ),
    );
  const held = new Set(links.map((l) => l.categoryId));
  const empty = candidates.filter((c) => !held.has(c.id)).map((c) => c.id);
  if (empty.length === 0) return 0;

  await db
    .update(supplierCategoriesTable)
    .set({ isActive: false, deletedAt: new Date() })
    .where(and(inArray(supplierCategoriesTable.id, empty)));
  return empty.length;
}

/**
 * Move every supplier who sits on `parentId` ALONE into its placeholder leaf.
 * Returns the number of suppliers moved. The free-text mirror is rewritten from
 * the surviving links, so the supplier list never shows the grouping category
 * the supplier no longer holds.
 */
export async function moveOrphansToPlaceholder(
  parentId: number,
  parentName: string,
  suppliers: Array<{ id: number; name: string }>,
): Promise<number> {
  if (suppliers.length === 0) return 0;
  const placeholderId = await ensureReviewPlaceholder(parentId);

  for (const s of suppliers) {
    const links = await db
      .select({ categoryId: supplierCategoryLinksTable.categoryId })
      .from(supplierCategoryLinksTable)
      .where(eq(supplierCategoryLinksTable.supplierId, s.id));
    const keptIds = links.map((l) => l.categoryId).filter((id) => id !== parentId);
    const kept = keptIds.length
      ? await db
          .select({ name: supplierCategoriesTable.name })
          .from(supplierCategoriesTable)
          .where(inArray(supplierCategoriesTable.id, keptIds))
      : [];

    await db.transaction(async (tx) => {
      await tx
        .insert(supplierCategoryLinksTable)
        .values({ supplierId: s.id, categoryId: placeholderId })
        .onConflictDoNothing();
      await tx
        .delete(supplierCategoryLinksTable)
        .where(
          and(
            eq(supplierCategoryLinksTable.supplierId, s.id),
            eq(supplierCategoryLinksTable.categoryId, parentId),
          ),
        );
      await tx
        .update(suppliersTable)
        .set({ category: [...kept.map((k) => k.name), REVIEW_PLACEHOLDER_NAME].join(",") })
        .where(eq(suppliersTable.id, s.id));
    });
  }
  return suppliers.length;
}

export interface ReviewSweepResult {
  /** Redundant parent links dropped (a supplier on a parent AND one of its children). */
  removed: number;
  /** Suppliers moved from a bare grouping category into its placeholder. */
  moved: number;
  /** Empty placeholders soft-deleted. */
  pruned: number;
  /** Supplier↔category links that remain after step 1. */
  remaining: number;
}

/**
 * The whole review rule in one place, and idempotent:
 *   1. drop the parent links that add nothing (the supplier also sits on a child);
 *   2. move every supplier still standing ALONE on a grouping category into that
 *      category's «يحتاج للمراجعة» leaf, so no supplier stays on a main category;
 *   3. soft-delete placeholders that now hold nobody.
 *
 * It runs after every supplier create/update and once at boot, so the rule holds
 * without someone pressing a button. A sweep that changes anything writes one
 * audit entry.
 */
export async function sweepReviewQueues(
  actorEmployeeId: number | null = null,
): Promise<ReviewSweepResult> {
  const live = await db
    .select({
      id: supplierCategoriesTable.id,
      name: supplierCategoriesTable.name,
      parentId: supplierCategoriesTable.parentId,
    })
    .from(supplierCategoriesTable)
    .where(eq(supplierCategoriesTable.isActive, true));
  const nodes = live.map((r) => ({ id: r.id, name: r.name, parentId: r.parentId ?? null }));
  const liveIds = new Set(nodes.map((n) => n.id));
  const nameById = new Map(nodes.map((n) => [n.id, n.name]));

  const allLinks = await db
    .select({
      supplierId: supplierCategoryLinksTable.supplierId,
      categoryId: supplierCategoryLinksTable.categoryId,
      supplierName: suppliersTable.name,
    })
    .from(supplierCategoryLinksTable)
    .innerJoin(suppliersTable, eq(suppliersTable.id, supplierCategoryLinksTable.supplierId));
  const links = allLinks.map((l) => ({ supplierId: l.supplierId, categoryId: l.categoryId }));

  // 1) Redundant parent links.
  const redundant = redundantParentLinks(nodes, links);
  if (redundant.length > 0) {
    const removedBySupplier = new Map<number, Set<number>>();
    for (const l of redundant) {
      const set = removedBySupplier.get(l.supplierId) ?? new Set<number>();
      set.add(l.categoryId);
      removedBySupplier.set(l.supplierId, set);
    }
    await db.transaction(async (tx) => {
      for (const l of redundant) {
        await tx
          .delete(supplierCategoryLinksTable)
          .where(
            and(
              eq(supplierCategoryLinksTable.supplierId, l.supplierId),
              eq(supplierCategoryLinksTable.categoryId, l.categoryId),
            ),
          );
      }
      // The free-text mirror must match the SURVIVING links.
      for (const [supplierId, removed] of removedBySupplier) {
        const names = links
          .filter((x) => x.supplierId === supplierId && !removed.has(x.categoryId))
          .map((x) => nameById.get(x.categoryId))
          .filter((n): n is string => Boolean(n));
        await tx
          .update(suppliersTable)
          .set({ category: names.join(",") })
          .where(eq(suppliersTable.id, supplierId));
      }
    });
  }

  // 2) Suppliers still standing alone on a grouping category.
  const removedKeys = new Set(redundant.map((l) => `${l.supplierId}:${l.categoryId}`));
  const holders = new Map<number, Array<{ id: number; name: string }>>();
  for (const l of allLinks) {
    if (removedKeys.has(`${l.supplierId}:${l.categoryId}`)) continue;
    const list = holders.get(l.categoryId) ?? [];
    list.push({ id: l.supplierId, name: l.supplierName });
    holders.set(l.categoryId, list);
  }
  const groups = nonLeafHolders(nodes, holders, liveIds).filter(
    (g) => !isReviewPlaceholder(g.name),
  );
  let moved = 0;
  for (const g of groups) {
    moved += await moveOrphansToPlaceholder(g.id, g.name, g.holders);
  }

  // 3) Placeholders that now hold nobody.
  const pruned = await pruneEmptyReviewPlaceholders();

  const result = {
    removed: redundant.length,
    moved,
    pruned,
    remaining: links.length - redundant.length,
  };
  // One audit entry per kind of change, under the action name each kind has
  // always had, so the history reads the same as before.
  if (result.removed > 0) {
    await db.insert(auditLogTable).values({
      action: "supplier_category.parent_links_cleaned",
      entityType: "supplier_category",
      employeeId: actorEmployeeId,
      description: `Removed ${result.removed} redundant parent-category supplier link(s)`,
    });
  }
  if (result.moved + result.pruned > 0) {
    await db.insert(auditLogTable).values({
      action: "supplier_category.review_swept",
      entityType: "supplier_category",
      employeeId: actorEmployeeId,
      description: `Review sweep: moved ${result.moved} supplier(s) to review, pruned ${result.pruned} empty placeholder(s)`,
    });
  }
  return result;
}

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
  db,
  supplierCategoriesTable,
  supplierCategoryLinksTable,
  suppliersTable,
} from "@workspace/db";
import { categoryKey, type CategoryNode } from "./category-tree";

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

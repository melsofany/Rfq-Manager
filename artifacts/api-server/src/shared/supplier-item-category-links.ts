/**
 * Supplier ↔ ITEM-category links — «المورد ده بيورّد إيه».
 *
 * `supplier_category_links` records a supplier's TRADE categories (the list on
 * /suppliers). That is a different question from what the supplier can actually
 * SUPPLY: an electrical trader supplies breakers, cables and panels, which are
 * ITEM categories. Before this table there was no way to ask «مين يقدر يورّد
 * بند من تصنيف كابلات؟» — the answer had to be guessed from the trade list.
 *
 * The link is stored on the ITEM-category side (`supplier_item_category_links`),
 * one row per (supplier, item category). It is a SOURCE OF TRUTH in its own
 * right: it is not derived from the trade categories and a rename of either
 * side follows by id.
 *
 * Same discipline as `supplier-category-links.ts`: reconcile a set, batch-load
 * a map, never an N+1. Two copies of a link rule drift apart silently.
 */
import { db, supplierItemCategoryLinksTable, itemCategoriesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

export interface SupplierItemCategoryRef {
  id: number;
  name: string;
}

/** Trim + drop empties + de-duplicate (case-insensitive, first spelling wins). */
function uniqueIds(ids: Array<number | null | undefined>): number[] {
  const out = new Set<number>();
  for (const raw of ids) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0) out.add(id);
  }
  return [...out];
}

/**
 * Replace a supplier's ITEM-category links with exactly `categoryIds`.
 * Idempotent — re-saving the same set is a no-op. Unknown ids are dropped by
 * the FK (they simply do not resolve), so a stale id can never create a
 * dangling row.
 */
export async function saveSupplierItemCategoryLinks(
  supplierId: number,
  categoryIds: Array<number | null | undefined> | null | undefined,
): Promise<SupplierItemCategoryRef[]> {
  const wanted = uniqueIds(categoryIds ?? []);
  if (wanted.length === 0) {
    await db
      .delete(supplierItemCategoryLinksTable)
      .where(eq(supplierItemCategoryLinksTable.supplierId, supplierId));
    return [];
  }

  const rows = await db
    .select({ id: itemCategoriesTable.id, name: itemCategoriesTable.name })
    .from(itemCategoriesTable)
    .where(inArray(itemCategoriesTable.id, wanted));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const refs = wanted.map((id) => byId.get(id)).filter(Boolean) as SupplierItemCategoryRef[];
  const wantedIds = refs.map((r) => r.id);

  const existing = await db
    .select({
      id: supplierItemCategoryLinksTable.id,
      categoryId: supplierItemCategoryLinksTable.categoryId,
    })
    .from(supplierItemCategoryLinksTable)
    .where(eq(supplierItemCategoryLinksTable.supplierId, supplierId));

  const existingIds = new Set(existing.map((e) => e.categoryId));
  const toRemove = existing.filter((e) => !wantedIds.includes(e.categoryId));
  const toAdd = wantedIds.filter((id) => !existingIds.has(id));

  if (toRemove.length > 0) {
    await db.delete(supplierItemCategoryLinksTable).where(
      inArray(
        supplierItemCategoryLinksTable.id,
        toRemove.map((r) => r.id),
      ),
    );
  }
  if (toAdd.length > 0) {
    await db
      .insert(supplierItemCategoryLinksTable)
      .values(toAdd.map((categoryId) => ({ supplierId, categoryId })))
      .onConflictDoNothing();
  }
  return refs;
}

/** Load the ITEM categories linked to each given supplier, batched (no N+1). */
export async function loadSupplierItemCategoryMap(
  supplierIds: number[],
): Promise<Map<number, SupplierItemCategoryRef[]>> {
  const out = new Map<number, SupplierItemCategoryRef[]>();
  const ids = [...new Set(supplierIds.filter((id) => Number.isFinite(id)))];
  if (ids.length === 0) return out;

  const rows = await db
    .select({
      supplierId: supplierItemCategoryLinksTable.supplierId,
      id: itemCategoriesTable.id,
      name: itemCategoriesTable.name,
    })
    .from(supplierItemCategoryLinksTable)
    .innerJoin(
      itemCategoriesTable,
      eq(supplierItemCategoryLinksTable.categoryId, itemCategoriesTable.id),
    )
    .where(inArray(supplierItemCategoryLinksTable.supplierId, ids));

  for (const r of rows) {
    const arr = out.get(r.supplierId) ?? [];
    arr.push({ id: r.id, name: r.name });
    out.set(r.supplierId, arr);
  }
  return out;
}

/**
 * Suppliers that can supply a given item category, including its descendants
 * (a supplier linked to «كهرباء» can supply «كابلات»). Batched by the caller's
 * subtree ids.
 */
export async function suppliersForItemCategories(
  categoryIds: number[],
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  const ids = uniqueIds(categoryIds);
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      categoryId: supplierItemCategoryLinksTable.categoryId,
      supplierId: supplierItemCategoryLinksTable.supplierId,
    })
    .from(supplierItemCategoryLinksTable)
    .where(inArray(supplierItemCategoryLinksTable.categoryId, ids));
  for (const r of rows) {
    const arr = out.get(r.categoryId) ?? [];
    arr.push(r.supplierId);
    out.set(r.categoryId, arr);
  }
  return out;
}

/**
 * Supplier ↔ category LINKS — مصدر الحقيقة لتصنيفات المورد
 *
 * `supplier_category_links` is the authoritative relationship between a supplier
 * and its trade categories. `suppliers.category` (free text, comma-separated
 * NAMES, no FK) is kept in step as a backward-compatibility mirror only.
 *
 * Why the link table: with free text, a category rename had to rewrite every
 * supplier row and a category delete left dangling names. With an FK the rename
 * only touches `supplier_categories.name` (the links follow by id) and a delete
 * cascades — so neither operation needs a textual edit.
 */
import { db, supplierCategoryLinksTable, supplierCategoriesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

export interface SupplierCategoryRef {
  id: number;
  name: string;
}

/** Trim + drop empties + de-duplicate (case-insensitive, first spelling wins). */
export function normalizeCategoryNames(names: string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names ?? []) {
    const name = String(raw ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** The legacy comma-joined text for a set of names (write-through mirror). */
export function categoriesToStored(names: string[]): string {
  return normalizeCategoryNames(names).join(",");
}

/**
 * Replace a supplier's category links with exactly `names`.
 *
 * Missing category rows are created first (a supplier may name a category the
 * catalogue does not hold yet), then the supplier's links are reconciled: rows
 * for a removed category are deleted, rows for an added one inserted. Idempotent
 * — re-saving the same set is a no-op. The `suppliers.category` text is NOT
 * touched here; the caller writes it (or the write-through keeps it) so the two
 * representations never diverge within one operation.
 */
export async function saveSupplierCategoryLinks(
  supplierId: number,
  names: string[] | null | undefined,
): Promise<SupplierCategoryRef[]> {
  const wanted = normalizeCategoryNames(names);

  // Ensure every named category exists so the FK can resolve. `ON CONFLICT DO
  // NOTHING` tolerates the concurrent-create race.
  if (wanted.length > 0) {
    await db
      .insert(supplierCategoriesTable)
      .values(wanted.map((name) => ({ name })))
      .onConflictDoNothing();
  }

  const rows = wanted.length
    ? await db
        .select({ id: supplierCategoriesTable.id, name: supplierCategoriesTable.name })
        .from(supplierCategoriesTable)
        .where(inArray(supplierCategoriesTable.name, wanted))
    : [];
  // Preserve the caller's order (the select has no defined order).
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  const refs = wanted
    .map((n) => byName.get(n.toLowerCase()))
    .filter(Boolean) as SupplierCategoryRef[];
  const wantedIds = refs.map((r) => r.id);

  const existing = await db
    .select({
      id: supplierCategoryLinksTable.id,
      categoryId: supplierCategoryLinksTable.categoryId,
    })
    .from(supplierCategoryLinksTable)
    .where(eq(supplierCategoryLinksTable.supplierId, supplierId));

  const existingIds = new Set(existing.map((e) => e.categoryId));
  const toRemove = existing.filter((e) => !wantedIds.includes(e.categoryId));
  const toAdd = wantedIds.filter((id) => !existingIds.has(id));

  if (toRemove.length > 0) {
    await db.delete(supplierCategoryLinksTable).where(
      inArray(
        supplierCategoryLinksTable.id,
        toRemove.map((r) => r.id),
      ),
    );
  }
  if (toAdd.length > 0) {
    await db
      .insert(supplierCategoryLinksTable)
      .values(toAdd.map((categoryId) => ({ supplierId, categoryId })))
      .onConflictDoNothing();
  }

  return refs;
}

/**
 * Load the categories linked to each given supplier, batched (no N+1).
 * A supplier with no links is absent from the map — callers fall back to the
 * legacy text for it.
 */
export async function loadSupplierCategoryMap(
  supplierIds: number[],
): Promise<Map<number, SupplierCategoryRef[]>> {
  const out = new Map<number, SupplierCategoryRef[]>();
  const ids = [...new Set(supplierIds.filter((id) => Number.isFinite(id)))];
  if (ids.length === 0) return out;

  const rows = await db
    .select({
      supplierId: supplierCategoryLinksTable.supplierId,
      id: supplierCategoriesTable.id,
      name: supplierCategoriesTable.name,
    })
    .from(supplierCategoryLinksTable)
    .innerJoin(
      supplierCategoriesTable,
      eq(supplierCategoryLinksTable.categoryId, supplierCategoriesTable.id),
    )
    .where(inArray(supplierCategoryLinksTable.supplierId, ids));

  for (const r of rows) {
    const arr = out.get(r.supplierId) ?? [];
    arr.push({ id: r.id, name: r.name });
    out.set(r.supplierId, arr);
  }
  return out;
}

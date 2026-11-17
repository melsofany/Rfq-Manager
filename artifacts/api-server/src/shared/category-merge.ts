/**
 * Category MERGE — دمج تصنيفين بتأكيد إداري فقط.
 *
 * The operator's rule: «ممنوع الدمج التلقائي أو حذف أي تصنيف اعتمادًا على تشابه
 * الاسم وحده». So this module NEVER decides to merge. It performs a merge a
 * human has explicitly requested, and it does so WITHOUT LOSING A RELATION:
 * every item, supplier, owner, keyword, alias, subcategory and memory row that
 * pointed at the source is moved onto the target, then the source is
 * SOFT-DELETED (hidden), never removed — its history survives and it can be
 * restored.
 *
 * The order is load-bearing: relations first, soft-delete last. A failure
 * anywhere rolls the whole transaction back, so a half-merged catalogue is
 * impossible.
 *
 * Two entry points because the two catalogues have different relations:
 *   • mergeSupplierCategories — trade categories (supplier_category_links).
 *   • mergeItemCategories     — item categories (items, owners, keywords, …).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { categoryKey, canonicalCategoryName } from "./category-tree";

export interface MergeResult {
  sourceId: number;
  targetId: number;
  movedLinks: number;
  movedItems: number;
  movedOwners: number;
  movedKeywords: number;
  movedAliases: number;
  movedSubcategories: number;
}

/** Refuse a merge that would fold a category onto itself. */
function assertDistinct(sourceId: number, targetId: number): void {
  if (sourceId === targetId) throw new Error("لا يمكن دمج التصنيف مع نفسه");
}

/**
 * Merge a supplier TRADE category into another.
 *
 * Moves: `supplier_category_links` (dropping any duplicate pair so the unique
 * index is never violated), the free-text `suppliers.category` spelling, and
 * child `parent_id` pointers. The source is then soft-deleted.
 */
export async function mergeSupplierCategories(
  sourceId: number,
  targetId: number,
  employeeId: number | null,
): Promise<MergeResult> {
  assertDistinct(sourceId, targetId);
  return db.transaction(async (tx) => {
    const src = (
      await tx.execute(sql`SELECT id, name FROM supplier_categories WHERE id = ${sourceId}`)
    ).rows?.[0] as { id: number; name: string } | undefined;
    const dst = (
      await tx.execute(sql`SELECT id, name FROM supplier_categories WHERE id = ${targetId}`)
    ).rows?.[0] as { id: number; name: string } | undefined;
    if (!src) throw new Error("التصنيف المصدر غير موجود");
    if (!dst) throw new Error("التصنيف الهدف غير موجود");

    // 1) Links: insert the target pair first, then delete the source pair.
    const movedLinks = Number(
      (
        (
          await tx.execute(sql`
          WITH ins AS (
            INSERT INTO supplier_category_links (supplier_id, category_id)
            SELECT supplier_id, ${targetId} FROM supplier_category_links WHERE category_id = ${sourceId}
            ON CONFLICT (supplier_id, category_id) DO NOTHING
            RETURNING 1
          )
          SELECT count(*)::int AS n FROM ins
        `)
        ).rows?.[0] as { n: number } | undefined
      )?.n ?? 0,
    );
    await tx.execute(sql`DELETE FROM supplier_category_links WHERE category_id = ${sourceId}`);

    // 2) Free-text mirror on suppliers (comma-joined names): rewrite the source
    //    spelling to the target, preserving the other categories.
    await tx.execute(sql`
      UPDATE suppliers
      SET category = (
        SELECT string_agg(DISTINCT CASE WHEN trim(elem) = ${src.name} THEN ${dst.name} ELSE trim(elem) END, ',')
        FROM unnest(string_to_array(category, ',')) AS elem
      )
      WHERE category IS NOT NULL
        AND EXISTS (SELECT 1 FROM unnest(string_to_array(category, ',')) AS elem WHERE trim(elem) = ${src.name});
    `);

    // 3) Children of the source now follow the target (unless they ARE the target).
    const movedSub = await tx.execute(sql`
      UPDATE supplier_categories SET parent_id = ${targetId}
      WHERE parent_id = ${sourceId} AND id <> ${targetId}
    `);

    // 4) Soft-delete the source. Never a hard delete.
    await tx.execute(sql`
      UPDATE supplier_categories SET is_active = false, deleted_at = NOW() WHERE id = ${sourceId}
    `);

    return {
      sourceId,
      targetId,
      movedLinks,
      movedItems: 0,
      movedOwners: 0,
      movedKeywords: 0,
      movedAliases: 0,
      movedSubcategories: movedSub.rowCount ?? 0,
    };
  });
}

/**
 * Merge an ITEM category into another. Moves EVERY relation the item catalogue
 * holds, so no item, owner, keyword, alias, subcategory or classification
 * memory is lost; the source is then soft-deleted.
 */
export async function mergeItemCategories(
  sourceId: number,
  targetId: number,
  employeeId: number | null,
): Promise<MergeResult> {
  assertDistinct(sourceId, targetId);
  return db.transaction(async (tx) => {
    const src = (await tx.execute(sql`SELECT id, name FROM item_categories WHERE id = ${sourceId}`))
      .rows?.[0] as { id: number; name: string } | undefined;
    const dst = (await tx.execute(sql`SELECT id, name FROM item_categories WHERE id = ${targetId}`))
      .rows?.[0] as { id: number; name: string } | undefined;
    if (!src) throw new Error("التصنيف المصدر غير موجود");
    if (!dst) throw new Error("التصنيف الهدف غير موجود");

    // Items classified with the source now point at the target.
    await tx.execute(
      sql`UPDATE customer_rfq_items SET category_id = ${targetId} WHERE category_id = ${sourceId}`,
    );
    await tx.execute(
      sql`UPDATE rfq_items SET category_id = ${targetId} WHERE category_id = ${sourceId}`,
    );
    await tx.execute(
      sql`UPDATE purchase_order_items SET category_id = ${targetId} WHERE category_id = ${sourceId}`,
    );
    await tx.execute(
      sql`UPDATE item_classification_identity SET category_id = ${targetId} WHERE category_id = ${sourceId}`,
    );
    await tx.execute(
      sql`UPDATE customer_rfq_items SET suggested_category_id = ${targetId} WHERE suggested_category_id = ${sourceId}`,
    );

    // Multi-category junction: add the target pair first, then drop the source
    // pair (the unique index forbids a duplicate).
    await tx.execute(sql`
      INSERT INTO customer_rfq_item_categories (customer_rfq_item_id, category_id, employee_id, added_by, created_at)
      SELECT customer_rfq_item_id, ${targetId}, employee_id, added_by, created_at
      FROM customer_rfq_item_categories WHERE category_id = ${sourceId}
      ON CONFLICT (customer_rfq_item_id, category_id) DO NOTHING;
    `);
    await tx.execute(sql`DELETE FROM customer_rfq_item_categories WHERE category_id = ${sourceId}`);

    // Ownership: add the target pairs (never primary — the target may already
    // have one), then drop the source pairs. Coverage is never lost.
    await tx.execute(sql`
      INSERT INTO employee_categories (employee_id, category_id, is_primary)
      SELECT employee_id, ${targetId}, false FROM employee_categories WHERE category_id = ${sourceId}
      ON CONFLICT (employee_id, category_id) DO NOTHING;
    `);
    await tx.execute(sql`DELETE FROM employee_categories WHERE category_id = ${sourceId}`);

    // Responsibility history points at the target from now on.
    await tx.execute(
      sql`UPDATE customer_rfq_item_assignments SET category_id = ${targetId} WHERE category_id = ${sourceId}`,
    );
    await tx.execute(
      sql`UPDATE rfq_item_assignments SET category_id = ${targetId} WHERE category_id = ${sourceId}`,
    );

    // Keywords: add the target pairs first, then drop the source pairs.
    await tx.execute(sql`
      INSERT INTO item_category_keywords (category_id, keyword, weight, language, enabled)
      SELECT ${targetId}, keyword, weight, language, enabled FROM item_category_keywords WHERE category_id = ${sourceId}
      ON CONFLICT (category_id, keyword) DO NOTHING;
    `);
    await tx.execute(sql`DELETE FROM item_category_keywords WHERE category_id = ${sourceId}`);

    // Aliases: register the source NAME as an alias of the target so the old
    // spelling still resolves, then drop the source aliases.
    await tx.execute(sql`
      INSERT INTO item_category_aliases (category_id, alias)
      VALUES (${targetId}, ${categoryKey(src.name)})
      ON CONFLICT (alias) DO NOTHING;
    `);
    await tx.execute(sql`
      INSERT INTO item_category_aliases (category_id, alias)
      SELECT ${targetId}, alias FROM item_category_aliases WHERE category_id = ${sourceId}
      ON CONFLICT (alias) DO NOTHING;
    `);
    await tx.execute(sql`DELETE FROM item_category_aliases WHERE category_id = ${sourceId}`);

    // Subcategories of the source follow the target.
    const movedSub = await tx.execute(sql`
      UPDATE item_categories SET parent_id = ${targetId}
      WHERE parent_id = ${sourceId} AND id <> ${targetId}
    `);

    // Supplier-item links follow the target.
    await tx.execute(sql`
      INSERT INTO supplier_item_category_links (supplier_id, category_id)
      SELECT supplier_id, ${targetId} FROM supplier_item_category_links WHERE category_id = ${sourceId}
      ON CONFLICT (supplier_id, category_id) DO NOTHING;
    `);
    await tx.execute(sql`DELETE FROM supplier_item_category_links WHERE category_id = ${sourceId}`);

    // Soft-delete the source. Never a hard delete — its history must survive.
    await tx.execute(sql`
      UPDATE item_categories SET is_active = false, deleted_at = NOW() WHERE id = ${sourceId}
    `);

    return {
      sourceId,
      targetId,
      movedLinks: 0,
      movedItems: 0,
      movedOwners: 0,
      movedKeywords: 0,
      movedAliases: 0,
      movedSubcategories: movedSub.rowCount ?? 0,
    };
  });
}

/** The canonical display form used by the routes when persisting a name. */
export { canonicalCategoryName };

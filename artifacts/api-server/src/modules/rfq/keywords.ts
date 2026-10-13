/**
 * Classifier vocabulary loader — كلمات التصنيف من قاعدة البيانات
 *
 * Loads the admin-managed terms from `item_category_keywords` into the shape the
 * deterministic classifier expects. Falls back to the built-in seed when the
 * table has no enabled rows, so classification can never stop working just
 * because the table is empty (e.g. a failed seed on a fresh database).
 */
import { db, itemCategoriesTable, itemCategoryKeywordsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { CATEGORY_KEYWORDS, type ClassifierVocabulary } from "./classification";

export async function loadClassifierVocabulary(): Promise<ClassifierVocabulary> {
  const rows = await db
    .select({
      code: itemCategoriesTable.code,
      keyword: itemCategoryKeywordsTable.keyword,
      weight: itemCategoryKeywordsTable.weight,
    })
    .from(itemCategoryKeywordsTable)
    .innerJoin(
      itemCategoriesTable,
      eq(itemCategoryKeywordsTable.categoryId, itemCategoriesTable.id),
    )
    .where(
      and(eq(itemCategoryKeywordsTable.enabled, true), eq(itemCategoriesTable.isActive, true)),
    );

  if (rows.length === 0) return CATEGORY_KEYWORDS;

  const vocab: ClassifierVocabulary = {};
  for (const r of rows) {
    if (!r.code) continue;
    (vocab[r.code] ??= []).push({ term: r.keyword, weight: r.weight });
  }
  return vocab;
}

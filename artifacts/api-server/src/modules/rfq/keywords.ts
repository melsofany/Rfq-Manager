/**
 * Classifier vocabulary loader — كلمات التصنيف من قاعدة البيانات
 *
 * Loads the admin-managed terms from `item_category_keywords` into the shape the
 * deterministic classifier expects. Falls back to the built-in seed when the
 * table has no enabled rows, so classification can never stop working just
 * because the table is empty (e.g. a failed seed on a fresh database).
 *
 * A category added from the admin UI may have NO `code` (the code is optional).
 * The old loader keyed every term by `code` and skipped a category without one,
 * so such a category could NEVER be reached by the deterministic classifier — a
 * manager could add a category and keywords for it and it would still never be
 * used. Terms are therefore keyed by `code` when present and by the category ID
 * otherwise, and the classifier looks up both.
 */
import { db, itemCategoriesTable, itemCategoryKeywordsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { CATEGORY_KEYWORDS, type ClassifierVocabulary } from "./classification";

/** The vocabulary key for a category — its code, else its id. Mirrored in classification.ts. */
export function vocabularyKey(cat: { code: string | null; id: number }): string {
  return cat.code ? cat.code : `id:${cat.id}`;
}

export async function loadClassifierVocabulary(): Promise<ClassifierVocabulary> {
  const rows = await db
    .select({
      id: itemCategoriesTable.id,
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
    const key = vocabularyKey(r);
    (vocab[key] ??= []).push({ term: r.keyword, weight: r.weight });
  }
  return vocab;
}

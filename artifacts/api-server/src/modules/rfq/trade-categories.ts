/**
 * The ONE definition of «تصنيف مورد» — a trade category.
 *
 * The operator's requirement: the «تصنيفات البنود» tab must never show more or
 * fewer categories than the supplier page. Two pages, two tables, so the rule
 * has to live in exactly one place — a second copy in the UI is a copy that
 * drifts, and drift here reads to the operator as «the numbers don't match».
 *
 * A trade category is an item category that is ALL THREE of:
 *
 *   1. `kind = 'functional'` — a subcategory (قواطع/PLC/كابلات…) or a brand is
 *      a refinement INSIDE a domain. It never owns work (`resolveDomainId`
 *      resolves it upward) and it is not a category a supplier registers under,
 *      so offering one as a top-level category is the drift being removed.
 *   2. `isActive` — a deactivated category is not on offer anywhere.
 *   3. named in `supplier_categories` — the list `/suppliers` renders.
 *
 * Membership is a NAME comparison (`normalizeText`, the catalogue's own rule):
 * `suppliers.category` stores names, not ids, so the name IS the key both pages
 * already share.
 */
import { db } from "@workspace/db";
import { itemCategoriesTable, supplierCategoriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { normalizeText } from "./classification";

export interface TradeCategory {
  id: number;
  name: string;
  code: string | null;
}

/** The minimum an item-category row must expose to be judged. */
export interface TradeCategoryCandidate {
  id: number;
  name: string;
  kind?: string | null;
  isActive?: boolean | null;
  code?: string | null;
}

/**
 * The rule itself, pure — so a caller that has ALREADY loaded the catalogue
 * applies the same decision without a second query, and there is still only one
 * implementation to keep in step.
 */
export function isTradeCategory(
  cat: TradeCategoryCandidate,
  tradeNames: ReadonlySet<string>,
): boolean {
  if (cat.isActive === false) return false;
  if ((cat.kind ?? "functional") !== "functional") return false;
  return tradeNames.has(normalizeText(cat.name));
}

/** The normalised name set of everything `/suppliers` lists. */
export function tradeNameSet(names: Array<{ name: string }>): Set<string> {
  return new Set(names.map((r) => normalizeText(r.name)));
}

/**
 * Every live trade category, in catalogue order.
 *
 * Read the SAME value into both the supplier page's rule and the item tab by
 * calling this — never re-derive membership at a call site.
 */
export async function loadTradeCategories(): Promise<TradeCategory[]> {
  const [supplierRows, itemRows] = await Promise.all([
    db.select({ name: supplierCategoriesTable.name }).from(supplierCategoriesTable),
    db
      .select({
        id: itemCategoriesTable.id,
        name: itemCategoriesTable.name,
        code: itemCategoriesTable.code,
        kind: itemCategoriesTable.kind,
        isActive: itemCategoriesTable.isActive,
      })
      .from(itemCategoriesTable)
      .where(eq(itemCategoriesTable.isActive, true)),
  ]);

  const tradeNames = tradeNameSet(supplierRows);
  return itemRows
    .filter((c) => isTradeCategory(c, tradeNames))
    .map((c) => ({ id: c.id, name: c.name, code: c.code ?? null }));
}

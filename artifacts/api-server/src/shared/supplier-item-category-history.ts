/**
 * تصنيفات البنود المستخلصة من التاريخ — «المورد ده بيورّد إيه فعليًا».
 *
 * The operator's requirement: do not make him tag every supplier by hand. The
 * system already holds the evidence, in two independent places:
 *
 *   1. **مُسعَّر** — the supplier QUOTED a line (`offer_items` → `offers` →
 *      `rfq_items.category_id`). A price on a line is the supplier telling us,
 *      in his own words, that he can supply that item.
 *   2. **أمر شراء** — a purchase order was ISSUED to him for that line
 *      (`purchase_order_items.category_id`, supplier + PO not cancelled). This
 *      is the STRONGER evidence: a quote is an offer, an order is a commitment.
 *
 * The two are merged with the MANUAL links (`supplier_item_category_links`) so
 * the three sources reinforce each other instead of competing: a supplier is
 * shown every category he has evidence for, with the source of each.
 *
 * Nothing here is stored. A category is DERIVED on read — the same discipline
 * as the request/fulfilment statuses — so a new quote immediately adds the
 * category and a cancelled order immediately removes it, with no backfill job
 * to fall behind. The manual link table stays the place a human overrides.
 *
 * Batched by design: one query per source for a whole page of suppliers, never
 * a query per supplier (the N+1 that made the list hang once already).
 */
import {
  db,
  offerItemsTable,
  offersTable,
  rfqItemsTable,
  purchaseOrderItemsTable,
  purchaseOrdersTable,
  itemCategoriesTable,
} from "@workspace/db";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { loadSupplierItemCategoryMap } from "./supplier-item-category-links";

/** Where the evidence for a (supplier, item-category) pair came from. */
export interface SupplierItemCategoryEvidence {
  categoryId: number;
  name: string;
  /** The supplier quoted a line in this category. */
  quoted: boolean;
  /** A purchase order was issued to the supplier for a line in this category. */
  ordered: boolean;
  /** A human linked the pair explicitly — the override, shown as «يدوي». */
  manual: boolean;
}

/** A stable display order: an issued order beats a quote beats a manual tag. */
export function evidenceRank(c: SupplierItemCategoryEvidence): number {
  if (c.ordered) return 0;
  if (c.quoted) return 1;
  return 2;
}

function emptyMap(): Map<number, Map<number, SupplierItemCategoryEvidence>> {
  return new Map();
}

function addEvidence(
  acc: Map<number, Map<number, SupplierItemCategoryEvidence>>,
  supplierId: number,
  categoryId: number,
  name: string,
  patch: Partial<Pick<SupplierItemCategoryEvidence, "quoted" | "ordered" | "manual">>,
): void {
  if (!Number.isFinite(supplierId) || !Number.isFinite(categoryId)) return;
  let byCat = acc.get(supplierId);
  if (!byCat) {
    byCat = new Map();
    acc.set(supplierId, byCat);
  }
  const existing = byCat.get(categoryId);
  if (existing) {
    if (patch.quoted) existing.quoted = true;
    if (patch.ordered) existing.ordered = true;
    if (patch.manual) existing.manual = true;
    if (!existing.name && name) existing.name = name;
    return;
  }
  byCat.set(categoryId, {
    categoryId,
    name,
    quoted: patch.quoted === true,
    ordered: patch.ordered === true,
    manual: patch.manual === true,
  });
}

/** Categories a supplier QUOTED a price for, batched by supplier ids. */
async function loadQuotedCategories(supplierIds: number[]) {
  return db
    .selectDistinct({
      supplierId: offersTable.supplierId,
      categoryId: rfqItemsTable.categoryId,
      name: itemCategoriesTable.name,
    })
    .from(offerItemsTable)
    .innerJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
    .innerJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
    .innerJoin(itemCategoriesTable, eq(rfqItemsTable.categoryId, itemCategoriesTable.id))
    .where(
      and(
        inArray(offersTable.supplierId, supplierIds),
        isNotNull(rfqItemsTable.categoryId),
        eq(itemCategoriesTable.isActive, true),
      ),
    );
}

/**
 * Categories a supplier was ISSUED a live purchase order for, batched.
 *
 * A PO line's OWN `category_id` is often NULL on legacy rows (only 14 of 159
 * carry a link today), so the category is resolved through the documented link
 * ladder: the PO line's own category first, else the category of the offer line
 * it was priced from (`offer_item_id` → `rfq_items.category_id`). A cancelled
 * order is not evidence at all — it never happened.
 */
async function loadOrderedCategories(supplierIds: number[]) {
  const resolvedCategory = sql<
    number | null
  >`coalesce(${purchaseOrderItemsTable.categoryId}, ${rfqItemsTable.categoryId})`;
  return db
    .selectDistinct({
      supplierId: purchaseOrderItemsTable.supplierId,
      categoryId: resolvedCategory,
      name: itemCategoriesTable.name,
    })
    .from(purchaseOrderItemsTable)
    .innerJoin(purchaseOrdersTable, eq(purchaseOrderItemsTable.poId, purchaseOrdersTable.id))
    .leftJoin(offerItemsTable, eq(purchaseOrderItemsTable.offerItemId, offerItemsTable.id))
    .leftJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
    .innerJoin(itemCategoriesTable, eq(itemCategoriesTable.id, resolvedCategory))
    .where(
      and(
        inArray(purchaseOrderItemsTable.supplierId, supplierIds),
        eq(itemCategoriesTable.isActive, true),
        // A cancelled order is not evidence that the supplier supplies this
        // category — it never happened.
        ne(purchaseOrdersTable.status, "cancelled"),
        ne(purchaseOrderItemsTable.lineStatus, "cancelled"),
      ),
    );
}

/**
 * Item categories per supplier, from BOTH history sources plus the manual
 * links, batched for a whole page. A failure of the history read degrades to
 * the manual links alone — enrichment must never fail the supplier list.
 */
export async function loadSupplierItemCategoryEvidenceMap(
  supplierIds: number[],
): Promise<Map<number, SupplierItemCategoryEvidence[]>> {
  const ids = [...new Set(supplierIds.filter((id) => Number.isFinite(id)))];
  const out = new Map<number, SupplierItemCategoryEvidence[]>();
  if (ids.length === 0) return out;

  const [quoted, ordered, manualMap] = await Promise.all([
    loadQuotedCategories(ids).catch(() => [] as Awaited<ReturnType<typeof loadQuotedCategories>>),
    loadOrderedCategories(ids).catch(() => [] as Awaited<ReturnType<typeof loadOrderedCategories>>),
    loadSupplierItemCategoryMap(ids).catch(
      () => new Map<number, Array<{ id: number; name: string }>>(),
    ),
  ]);

  return mergeItemCategoryEvidence(quoted, ordered, manualMap);
}

/**
 * Suppliers whose HISTORY (quote or order) covers any of `categoryIds` — the
 * history half of the «يورّد بنود» filter. Returned as categoryId → supplierId
 * so the caller can union it with the manual links without re-querying.
 */
export async function suppliersWithHistoryForCategories(
  categoryIds: number[],
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  const ids = [...new Set(categoryIds.filter((id) => Number.isFinite(id)))];
  if (ids.length === 0) return out;

  const push = (categoryId: number, supplierId: number) => {
    if (!Number.isFinite(categoryId) || !Number.isFinite(supplierId)) return;
    const arr = out.get(categoryId) ?? [];
    arr.push(supplierId);
    out.set(categoryId, arr);
  };

  const [quoted, ordered] = await Promise.all([
    db
      .selectDistinct({
        supplierId: offersTable.supplierId,
        categoryId: rfqItemsTable.categoryId,
      })
      .from(offerItemsTable)
      .innerJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
      .innerJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
      .where(and(inArray(rfqItemsTable.categoryId, ids), isNotNull(rfqItemsTable.categoryId)))
      .catch(() => [] as Array<{ supplierId: number | null; categoryId: number | null }>),
    db
      .selectDistinct({
        supplierId: purchaseOrderItemsTable.supplierId,
        categoryId: sql<
          number | null
        >`coalesce(${purchaseOrderItemsTable.categoryId}, ${rfqItemsTable.categoryId})`,
      })
      .from(purchaseOrderItemsTable)
      .innerJoin(purchaseOrdersTable, eq(purchaseOrderItemsTable.poId, purchaseOrdersTable.id))
      .leftJoin(offerItemsTable, eq(purchaseOrderItemsTable.offerItemId, offerItemsTable.id))
      .leftJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
      .where(
        and(
          ne(purchaseOrdersTable.status, "cancelled"),
          ne(purchaseOrderItemsTable.lineStatus, "cancelled"),
        ),
      )
      .catch(() => [] as Array<{ supplierId: number | null; categoryId: number | null }>),
  ]);

  for (const r of [...quoted, ...ordered]) {
    if (r.supplierId == null || r.categoryId == null) continue;
    // The category now comes from the link ladder (coalesce), so the subtree
    // filter is applied here rather than in the SQL `where`.
    if (!ids.includes(r.categoryId)) continue;
    push(r.categoryId, r.supplierId);
  }
  return out;
}

/**
 * One supplier's categories for the DETAIL page, with the evidence flags. The
 * manual links are always included so a hand-tagged pair survives even when it
 * has no history yet.
 */
export async function supplierItemCategoryEvidence(
  supplierId: number,
): Promise<SupplierItemCategoryEvidence[]> {
  const map = await loadSupplierItemCategoryEvidenceMap([supplierId]);
  return map.get(supplierId) ?? [];
}

/** True when the supplier has at least one category from any source. */
export function hasAnyEvidence(categories: SupplierItemCategoryEvidence[]): boolean {
  return categories.length > 0;
}

/** A (supplier, category) row as read from one history source. */
export interface EvidenceRow {
  supplierId: number | null;
  categoryId: number | null;
  name?: string | null;
}

/**
 * Merge the three sources into one ordered list per supplier. PURE — no
 * database, so the rule is unit-testable directly: a category is present when
 * ANY source has it, and the flags say which. The manual link is the human
 * override; it is never dropped by a missing history row.
 */
export function mergeItemCategoryEvidence(
  quoted: EvidenceRow[],
  ordered: EvidenceRow[],
  manual: Map<number, Array<{ id: number; name: string }>>,
): Map<number, SupplierItemCategoryEvidence[]> {
  const acc = emptyMap();
  for (const r of quoted) {
    if (r.supplierId == null || r.categoryId == null) continue;
    addEvidence(acc, r.supplierId, r.categoryId, r.name ?? "", { quoted: true });
  }
  for (const r of ordered) {
    if (r.supplierId == null || r.categoryId == null) continue;
    addEvidence(acc, r.supplierId, r.categoryId, r.name ?? "", { ordered: true });
  }
  for (const [supplierId, cats] of manual) {
    for (const c of cats) addEvidence(acc, supplierId, c.id, c.name, { manual: true });
  }
  const out = new Map<number, SupplierItemCategoryEvidence[]>();
  for (const [supplierId, byCat] of acc) {
    out.set(
      supplierId,
      [...byCat.values()].sort(
        (a, b) => evidenceRank(a) - evidenceRank(b) || a.name.localeCompare(b.name),
      ),
    );
  }
  return out;
}

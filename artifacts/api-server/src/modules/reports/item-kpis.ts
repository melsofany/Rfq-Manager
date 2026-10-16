/**
 * Item-level procurement KPIs + category coverage — مؤشرات الأداء على مستوى البند
 *
 * Responsibility lives on the CUSTOMER item (`customer_rfq_item_assignments`),
 * so this is where the KPI is measured: how many CUSTOMER items each employee is
 * responsible for, how many attracted offers, and how many converted to a
 * purchase order — broken down by category.
 *
 * A customer item sent to several suppliers still counts ONCE: the offers and
 * the conversion are gathered from the supplier lines LINKED to the customer
 * item, not from the supplier lines themselves. Manually-created supplier RFQs
 * (no customer origin) keep an independent responsibility in the legacy table
 * and are deliberately EXCLUDED from these customer-item KPIs — they are
 * reported only as an informational total.
 *
 *   GET /analytics/procurement/by-item   — per-employee, per-category item KPIs
 *   GET /analytics/categories/coverage   — categories with no owner + unclassified items
 */
import { Router } from "express";
import {
  db,
  customerRfqItemAssignmentsTable,
  customerRfqItemsTable,
  customerRfqsTable,
  rfqItemAssignmentsTable,
  rfqItemsTable,
  rfqTable,
  offersTable,
  offerItemsTable,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  employeesTable,
  itemCategoriesTable,
  employeeCategoriesTable,
  customerPoItemsTable,
} from "@workspace/db";
import { and, eq, inArray, sql, isNull, isNotNull } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";

const router = Router();

/** Normalise an identifier for cross-table item matching. */
function normKey(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

export interface PoLineRef {
  lineItem: string | null;
  partNo: string | null;
  description: string | null;
  /** purchase_order_items.line_status — "fulfilled" means accepted qty reached the ordered qty (delivered). */
  lineStatus?: string | null;
}

/**
 * Does one of the PO lines belonging to the RFQ's linked POs fulfil this item?
 *
 * There is NO `rfq_item → po_item` foreign key — verified against the schema:
 * `purchase_order_items` carries only `po_id` and `customer_po_item_id`, and the
 * PO↔RFQ relationship is header-level (`purchase_orders.rfq_id`). So the
 * line-level conversion is derived by IDENTITY within the RFQ's OWN linked POs,
 * in order of certainty: `lineItem` → `partNo` → `description`.
 *
 * Matching on the part number ALONE is deliberately not treated as a link: a
 * part number is not an item identity and repeats across unrelated orders, so a
 * single shared part number must not turn a header-only conversion into a
 * per-item one. The header scope is what keeps the match meaningful.
 */
export function matchPoLineForRfqItem(rfqItem: PoLineRef, poLines: PoLineRef[]): boolean {
  const byField = (extract: (l: PoLineRef) => string | null): boolean => {
    const key = normKey(extract(rfqItem));
    if (!key) return false;
    return poLines.some((l) => normKey(extract(l)) === key);
  };
  return byField((l) => l.lineItem) || byField((l) => l.partNo) || byField((l) => l.description);
}

// Batched (no N+1): all customer-item assignments → their customer items → their
// customer RFQs (date) → the supplier lines linked to those items → offers per
// supplier RFQ → offer_items per supplier line → PO-linked RFQs → PO lines.
router.get("/analytics/procurement/by-item", requireAuth, async (req, res): Promise<void> => {
  const fromStr = req.query.from as string | undefined;
  const toStr = req.query.to as string | undefined;
  const fromDate = fromStr ? new Date(fromStr + "T00:00:00Z") : null;
  const toDate = toStr ? new Date(toStr + "T23:59:59Z") : null;

  const assignments = await db
    .select({
      customerRfqItemId: customerRfqItemAssignmentsTable.customerRfqItemId,
      categoryId: customerRfqItemAssignmentsTable.categoryId,
      employeeId: customerRfqItemAssignmentsTable.employeeId,
      source: customerRfqItemAssignmentsTable.source,
    })
    .from(customerRfqItemAssignmentsTable)
    .where(isNull(customerRfqItemAssignmentsTable.validTo));

  const itemIds = assignments.map((a) => a.customerRfqItemId);

  // Unclassified customer items never got an assignment row (the classifier
  // refused to guess), so they are counted from the source table.
  const countUnclassified = async (): Promise<number> => {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(customerRfqItemsTable)
      .where(sql`${customerRfqItemsTable.categoryId} IS NULL`);
    return Number(n) || 0;
  };

  // Independent responsibility: supplier RFQs created manually (no customer
  // origin). Kept OUT of the customer-item KPIs; reported as an informational
  // total so they are not lost.
  const countIndependent = async (): Promise<number> => {
    const rows = await db
      .select({ rfqItemId: rfqItemAssignmentsTable.rfqItemId })
      .from(rfqItemAssignmentsTable)
      .innerJoin(rfqItemsTable, eq(rfqItemAssignmentsTable.rfqItemId, rfqItemsTable.id))
      .where(sql`${rfqItemsTable.customerRfqItemId} IS NULL`);
    return rows.length;
  };

  if (itemIds.length === 0) {
    const n = await countUnclassified();
    const independent = await countIndependent();
    res.json({
      employees: [],
      categories: [],
      unassigned: [],
      totals: {
        ...emptyTotals(),
        unclassifiedItems: n,
        totalItems: n,
        independentSupplierItems: independent,
      },
    });
    return;
  }

  const items = await db
    .select({
      id: customerRfqItemsTable.id,
      customerRfqId: customerRfqItemsTable.customerRfqId,
    })
    .from(customerRfqItemsTable)
    .where(inArray(customerRfqItemsTable.id, itemIds));
  const itemById = new Map(items.map((i) => [i.id, i]));

  const rfqIds = [...new Set(items.map((i) => i.customerRfqId))];
  const rfqs = rfqIds.length
    ? await db
        .select({
          id: customerRfqsTable.id,
          status: customerRfqsTable.status,
          createdAt: customerRfqsTable.createdAt,
        })
        .from(customerRfqsTable)
        .where(inArray(customerRfqsTable.id, rfqIds))
    : [];
  const rfqById = new Map(rfqs.map((r) => [r.id, r]));

  // Supplier lines linked to these customer items (the customer item may be sent
  // to several suppliers — all of them belong to the SAME customer item).
  const linkedSupplierItems = itemIds.length
    ? await db
        .select({
          id: rfqItemsTable.id,
          customerRfqItemId: rfqItemsTable.customerRfqItemId,
          rfqId: rfqItemsTable.rfqId,
          lineItem: rfqItemsTable.lineItem,
          partNo: rfqItemsTable.partNo,
          description: rfqItemsTable.description,
        })
        .from(rfqItemsTable)
        .where(inArray(rfqItemsTable.customerRfqItemId, itemIds))
    : [];
  const supplierItemsByCustomerItem = new Map<number, typeof linkedSupplierItems>();
  for (const si of linkedSupplierItems) {
    if (si.customerRfqItemId == null) continue;
    const arr = supplierItemsByCustomerItem.get(si.customerRfqItemId) ?? [];
    arr.push(si);
    supplierItemsByCustomerItem.set(si.customerRfqItemId, arr);
  }
  const supplierItemIds = linkedSupplierItems.map((s) => s.id);
  const supplierRfqIds = [...new Set(linkedSupplierItems.map((s) => s.rfqId))];

  // The supplier RFQ's OWN status (for the legacy SUCCESS conversion fallback).
  const supplierRfqs = supplierRfqIds.length
    ? await db
        .select({ id: rfqTable.id, status: rfqTable.status })
        .from(rfqTable)
        .where(inArray(rfqTable.id, supplierRfqIds))
    : [];
  const supplierRfqStatus = new Map(supplierRfqs.map((r) => [r.id, r.status]));

  // Offers per supplier RFQ.
  const offers = supplierRfqIds.length
    ? await db
        .select({ id: offersTable.id, rfqId: offersTable.rfqId })
        .from(offersTable)
        .where(inArray(offersTable.rfqId, supplierRfqIds))
    : [];
  const offersByRfq = new Map<number, number>();
  for (const o of offers) offersByRfq.set(o.rfqId, (offersByRfq.get(o.rfqId) ?? 0) + 1);

  // Offer items per supplier line.
  const offerItems = supplierItemIds.length
    ? await db
        .select({ rfqItemId: offerItemsTable.rfqItemId })
        .from(offerItemsTable)
        .where(inArray(offerItemsTable.rfqItemId, supplierItemIds))
    : [];
  const offersBySupplierItem = new Map<number, number>();
  for (const oi of offerItems)
    offersBySupplierItem.set(oi.rfqItemId, (offersBySupplierItem.get(oi.rfqItemId) ?? 0) + 1);

  // POs linked to the supplier RFQs + their lines (for per-item conversion).
  const pos = supplierRfqIds.length
    ? await db
        .select({ id: purchaseOrdersTable.id, rfqId: purchaseOrdersTable.rfqId })
        .from(purchaseOrdersTable)
        .where(inArray(purchaseOrdersTable.rfqId, supplierRfqIds))
    : [];
  const linkedPoIds = pos.map((p) => p.id);
  const poLineRows = linkedPoIds.length
    ? await db
        .select({
          poId: purchaseOrderItemsTable.poId,
          lineItem: purchaseOrderItemsTable.lineItem,
          partNo: purchaseOrderItemsTable.partNo,
          description: purchaseOrderItemsTable.description,
          lineStatus: purchaseOrderItemsTable.lineStatus,
        })
        .from(purchaseOrderItemsTable)
        .where(inArray(purchaseOrderItemsTable.poId, linkedPoIds))
    : [];
  const poIdsByRfq = new Map<number, number[]>();
  for (const p of pos) {
    if (p.rfqId == null) continue;
    poIdsByRfq.set(p.rfqId, [...(poIdsByRfq.get(p.rfqId) ?? []), p.id]);
  }
  const linesByRfq = new Map<number, PoLineRef[]>();
  for (const [rfqId, ids] of poIdsByRfq) {
    const idSet = new Set(ids);
    linesByRfq.set(
      rfqId,
      poLineRows.filter((r) => idSet.has(r.poId)),
    );
  }

  // A supplier line converted when a matching PO line exists within its RFQ's
  // linked POs, or its RFQ carries the SUCCESS status (legacy header-level link).
  const convertedSupplierItemIds = new Set<number>();
  for (const si of linkedSupplierItems) {
    const lines = linesByRfq.get(si.rfqId) ?? [];
    if (lines.length > 0 && matchPoLineForRfqItem(si, lines)) {
      convertedSupplierItemIds.add(si.id);
      continue;
    }
    if (supplierRfqStatus.get(si.rfqId) === "SUCCESS") convertedSupplierItemIds.add(si.id);
  }

  // Category names + active employees.
  const cats = await db
    .select({ id: itemCategoriesTable.id, name: itemCategoriesTable.name })
    .from(itemCategoriesTable);
  const catName = new Map(cats.map((c) => [c.id, c.name]));

  const emps = await db
    .select({ id: employeesTable.id, name: employeesTable.name, role: employeesTable.role })
    .from(employeesTable)
    .where(eq(employeesTable.isActive, true));
  const empName = new Map(emps.map((e) => [e.id, e]));

  const inRange = (d: Date | string | null | undefined): boolean => {
    if (!fromDate && !toDate) return true;
    if (!d) return true;
    const t = new Date(d).getTime();
    if (fromDate && t < fromDate.getTime()) return false;
    if (toDate && t > toDate.getTime()) return false;
    return true;
  };

  // Delivered = a PO line matching the supplier line is FULFILLED (received and accepted
  // in full). Counted per customer item, so a multi-supplier item still counts once.
  const deliveredSupplierItemIds = new Set<number>();
  for (const si of linkedSupplierItems) {
    const fulfilled = (linesByRfq.get(si.rfqId) ?? []).filter((l) => l.lineStatus === "fulfilled");
    if (fulfilled.length > 0 && matchPoLineForRfqItem(si, fulfilled)) {
      deliveredSupplierItemIds.add(si.id);
    }
  }

  // Per-CUSTOMER-item derived facts (counted once regardless of supplier count).
  const itemOffers = new Map<number, number>();
  const itemHasOffers = new Set<number>();
  const itemConverted = new Set<number>();
  const itemDelivered = new Set<number>();
  for (const itemId of itemIds) {
    const linked = supplierItemsByCustomerItem.get(itemId) ?? [];
    let offersSum = 0;
    let converted = false;
    for (const si of linked) {
      const oi = offersBySupplierItem.get(si.id) ?? 0;
      offersSum += oi;
      if (oi > 0) itemHasOffers.add(itemId);
      if (convertedSupplierItemIds.has(si.id)) converted = true;
      if (deliveredSupplierItemIds.has(si.id)) itemDelivered.add(itemId);
    }
    itemOffers.set(itemId, offersSum);
    if (converted) itemConverted.add(itemId);
  }

  type Agg = {
    employeeId: number;
    employeeName: string;
    categoryId: number | null;
    categoryName: string | null;
    items: number;
    itemsWithOffers: number;
    offersReceived: number;
    convertedItems: number;
    deliveredItems: number;
    manualItems: number;
  };

  const map = new Map<string, Agg>();
  const key = (empId: number, catId: number | null) => `${empId}:${catId ?? "none"}`;

  for (const a of assignments) {
    if (a.employeeId == null) continue;
    const item = itemById.get(a.customerRfqItemId);
    if (!item) continue;
    const rfq = rfqById.get(item.customerRfqId);
    if (!inRange(rfq?.createdAt)) continue;

    const k = key(a.employeeId, a.categoryId);
    let agg = map.get(k);
    if (!agg) {
      const e = empName.get(a.employeeId);
      agg = {
        employeeId: a.employeeId,
        employeeName: e?.name ?? `#${a.employeeId}`,
        categoryId: a.categoryId,
        categoryName: a.categoryId != null ? (catName.get(a.categoryId) ?? null) : null,
        items: 0,
        itemsWithOffers: 0,
        offersReceived: 0,
        convertedItems: 0,
        deliveredItems: 0,
        manualItems: 0,
      };
      map.set(k, agg);
    }

    agg.items++;
    if (a.source === "manual") agg.manualItems++;
    agg.offersReceived += itemOffers.get(a.customerRfqItemId) ?? 0;
    if (itemHasOffers.has(a.customerRfqItemId)) agg.itemsWithOffers++;
    if (itemConverted.has(a.customerRfqItemId)) agg.convertedItems++;
    if (itemDelivered.has(a.customerRfqItemId)) agg.deliveredItems++;
  }

  const employees = [...map.values()]
    .map((a) => ({
      ...a,
      conversionRate: a.items ? Math.round((a.convertedItems / a.items) * 1000) / 10 : 0,
      responseRate: a.items ? Math.round((a.itemsWithOffers / a.items) * 1000) / 10 : 0,
      deliveryRate: a.items ? Math.round((a.deliveredItems / a.items) * 1000) / 10 : 0,
    }))
    .sort((x, y) => y.items - x.items);

  // Roll up the same numbers by category only.
  const catMap = new Map<number | null, Agg>();
  for (const a of map.values()) {
    const k = a.categoryId;
    let agg = catMap.get(k);
    if (!agg) {
      agg = {
        employeeId: 0,
        employeeName: "",
        categoryId: a.categoryId,
        categoryName: a.categoryName,
        items: 0,
        itemsWithOffers: 0,
        offersReceived: 0,
        convertedItems: 0,
        deliveredItems: 0,
        manualItems: 0,
      };
      catMap.set(k, agg);
    }
    agg.items += a.items;
    agg.itemsWithOffers += a.itemsWithOffers;
    agg.offersReceived += a.offersReceived;
    agg.convertedItems += a.convertedItems;
    agg.deliveredItems += a.deliveredItems;
    agg.manualItems += a.manualItems;
  }

  const categories = [...catMap.values()]
    .map((a) => ({
      categoryId: a.categoryId,
      categoryName: a.categoryName ?? "غير مصنّف",
      items: a.items,
      itemsWithOffers: a.itemsWithOffers,
      offersReceived: a.offersReceived,
      convertedItems: a.convertedItems,
      deliveredItems: a.deliveredItems,
    }))
    .sort((x, y) => y.items - x.items);

  // Unassigned bucket: CLASSIFIED customer items whose category has no owner
  // (assignment row with a null employee). Kept OUT of the employee rows and
  // reported separately so the table total is never silently short.
  type Bucket = {
    categoryId: number | null;
    categoryName: string | null;
    items: number;
    itemsWithOffers: number;
    offersReceived: number;
    convertedItems: number;
    deliveredItems: number;
  };
  const unassignedByCategory = new Map<number | null, Bucket>();
  for (const a of assignments) {
    if (a.employeeId != null) continue;
    const item = itemById.get(a.customerRfqItemId);
    if (!item) continue;
    const rfq = rfqById.get(item.customerRfqId);
    if (!inRange(rfq?.createdAt)) continue;
    let b = unassignedByCategory.get(a.categoryId);
    if (!b) {
      b = {
        categoryId: a.categoryId,
        categoryName: a.categoryId != null ? (catName.get(a.categoryId) ?? null) : null,
        items: 0,
        itemsWithOffers: 0,
        offersReceived: 0,
        convertedItems: 0,
        deliveredItems: 0,
      };
      unassignedByCategory.set(a.categoryId, b);
    }
    b.items++;
    b.offersReceived += itemOffers.get(a.customerRfqItemId) ?? 0;
    if (itemHasOffers.has(a.customerRfqItemId)) b.itemsWithOffers++;
    if (itemConverted.has(a.customerRfqItemId)) b.convertedItems++;
    if (itemDelivered.has(a.customerRfqItemId)) b.deliveredItems++;
  }
  const unassigned = [...unassignedByCategory.values()].sort((x, y) => y.items - x.items);

  const unclassifiedCount = await countUnclassified();
  const independent = await countIndependent();

  const assignedItems = employees.reduce((s, e) => s + e.items, 0);
  const unassignedItems = unassigned.reduce((s, b) => s + b.items, 0);

  const totals = {
    items: assignedItems,
    itemsWithOffers: employees.reduce((s, e) => s + e.itemsWithOffers, 0),
    offersReceived: employees.reduce((s, e) => s + e.offersReceived, 0),
    convertedItems: employees.reduce((s, e) => s + e.convertedItems, 0),
    deliveredItems: employees.reduce((s, e) => s + e.deliveredItems, 0),
    manualItems: employees.reduce((s, e) => s + e.manualItems, 0),
    // Reconciliation: assigned + unassigned + unclassified = totalItems.
    assignedItems,
    unassignedItems,
    unclassifiedItems: unclassifiedCount,
    totalItems: assignedItems + unassignedItems + unclassifiedCount,
    // Informational: independent supplier-RFQ responsibility (no customer origin).
    independentSupplierItems: independent,
  };

  res.json({ employees, categories, totals, unassigned });
});

// Coverage: which categories have no owner, and how many CUSTOMER items are
// unclassified / unassigned. This is the operator's to-do list, not a metric.
router.get("/analytics/categories/coverage", requireAuth, async (_req, res): Promise<void> => {
  const cats = await db
    .select({
      id: itemCategoriesTable.id,
      name: itemCategoriesTable.name,
      isActive: itemCategoriesTable.isActive,
    })
    .from(itemCategoriesTable);

  const ownerRows = await db
    .select({ categoryId: employeeCategoriesTable.categoryId })
    .from(employeeCategoriesTable);
  const ownerCount = new Map<number, number>();
  for (const r of ownerRows) ownerCount.set(r.categoryId, (ownerCount.get(r.categoryId) ?? 0) + 1);

  const [{ totalItems }] = await db
    .select({ totalItems: sql<number>`count(*)::int` })
    .from(customerRfqItemsTable);

  const [{ unclassifiedItems }] = await db
    .select({ unclassifiedItems: sql<number>`count(*)::int` })
    .from(customerRfqItemsTable)
    .where(sql`${customerRfqItemsTable.categoryId} IS NULL`);

  const [{ unassignedItems }] = await db
    .select({ unassignedItems: sql<number>`count(*)::int` })
    .from(customerRfqItemAssignmentsTable)
    .where(
      sql`${customerRfqItemAssignmentsTable.validTo} IS NULL AND ${customerRfqItemAssignmentsTable.employeeId} IS NULL`,
    );

  const [{ assignedItems }] = await db
    .select({ assignedItems: sql<number>`count(*)::int` })
    .from(customerRfqItemAssignmentsTable)
    .where(
      sql`${customerRfqItemAssignmentsTable.validTo} IS NULL AND ${customerRfqItemAssignmentsTable.employeeId} IS NOT NULL`,
    );

  res.json({
    categories: cats.map((c) => ({
      id: c.id,
      name: c.name,
      isActive: c.isActive,
      owners: ownerCount.get(c.id) ?? 0,
      uncovered: (ownerCount.get(c.id) ?? 0) === 0,
    })),
    totals: {
      totalItems: Number(totalItems) || 0,
      unclassifiedItems: Number(unclassifiedItems) || 0,
      assignedItems: Number(assignedItems) || 0,
      unassignedItems: Number(unassignedItems) || 0,
    },
  });
});

// Migration health report: what the legacy→customer migration moved, what
// conflicted (several supplier lines → one customer item), what is orphaned
// (legacy assignment with no customer origin) and what needs manual review.
// This is the report the operator asked for before deleting the legacy table.
router.get("/analytics/assignment-migration", requireAuth, async (_req, res): Promise<void> => {
  // Migrated: customer assignments carrying the 'inherited' source tag.
  const [{ migrated }] = await db
    .select({ migrated: sql<number>`count(*)::int` })
    .from(customerRfqItemAssignmentsTable)
    .where(
      and(
        eq(customerRfqItemAssignmentsTable.source, "inherited"),
        isNull(customerRfqItemAssignmentsTable.validTo),
      ),
    );

  // Conflicted: legacy supplier lines that share one customer item (the
  // migration keeps exactly one — this counts how many had to be collapsed).
  const conflictRows = await db
    .select({
      customerRfqItemId: rfqItemsTable.customerRfqItemId,
      n: sql<number>`count(*)::int`,
    })
    .from(rfqItemAssignmentsTable)
    .innerJoin(rfqItemsTable, eq(rfqItemAssignmentsTable.rfqItemId, rfqItemsTable.id))
    .where(sql`${rfqItemsTable.customerRfqItemId} IS NOT NULL`)
    .groupBy(rfqItemsTable.customerRfqItemId)
    .having(sql`count(*) > 1`);
  const conflicts = conflictRows.length;

  // Orphans: legacy assignments whose supplier line has no customer origin.
  const orphanRows = await db
    .select({ rfqItemId: rfqItemAssignmentsTable.rfqItemId })
    .from(rfqItemAssignmentsTable)
    .innerJoin(rfqItemsTable, eq(rfqItemAssignmentsTable.rfqItemId, rfqItemsTable.id))
    .where(sql`${rfqItemsTable.customerRfqItemId} IS NULL`);
  const orphans = orphanRows.length;

  // Needs review: assigned to nobody, or auto-classified with low confidence.
  const [{ needsReview }] = await db
    .select({ needsReview: sql<number>`count(*)::int` })
    .from(customerRfqItemAssignmentsTable)
    .where(
      sql`${customerRfqItemAssignmentsTable.validTo} IS NULL AND (${customerRfqItemAssignmentsTable.employeeId} IS NULL OR ${customerRfqItemAssignmentsTable.confidence} < 60)`,
    );

  const [{ totalCustomerAssignments }] = await db
    .select({ totalCustomerAssignments: sql<number>`count(*)::int` })
    .from(customerRfqItemAssignmentsTable);

  res.json({
    migrated: Number(migrated) || 0,
    conflicts,
    orphans,
    needsReview: Number(needsReview) || 0,
    totalCustomerAssignments: Number(totalCustomerAssignments) || 0,
  });
});

// Event-based KPI — «من أحضر السعر الفائز» (event attribution).
//
// No formula: an item counts for exactly ONE employee — the one credited at the
// freeze event (`customer_rfq_items.attribution_employee_id`), i.e. the employee
// who obtained the APPROVED supplier price the customer PO was raised against.
// The `attribution_first_po_at` timestamp is the period boundary, so a date
// filter is exact. Unclassified / unpriced items never froze a winner and are
// reported separately (`attributionEvent = first_customer_po_no_approved_price`).
router.get("/analytics/procurement/attributed", requireAuth, async (req, res): Promise<void> => {
  const fromStr = req.query.from as string | undefined;
  const toStr = req.query.to as string | undefined;
  const fromDate = fromStr ? new Date(fromStr + "T00:00:00Z") : null;
  const toDate = toStr ? new Date(toStr + "T23:59:59Z") : null;

  // Only items that actually froze a winner.
  const rows = await db
    .select({
      customerRfqItemId: customerRfqItemsTable.id,
      employeeId: customerRfqItemsTable.attributionEmployeeId,
      employeeName: customerRfqItemsTable.attributionEmployeeName,
      event: customerRfqItemsTable.attributionEvent,
      frozenAt: customerRfqItemsTable.attributionFirstPoAt,
      categoryId: customerRfqItemsTable.categoryId,
    })
    .from(customerRfqItemsTable)
    .where(isNotNull(customerRfqItemsTable.attributionFirstPoAt));

  // Items that actually reached a LIVE customer-PO line (a credited item whose
  // customer PO line still exists). Used for the achievement ratio: of the items
  // credited to an employee, how many materialised as a customer purchase order.
  const convertedItemIds = new Set<number>();
  if (rows.length) {
    const converted = await db
      .select({ customerRfqItemId: customerPoItemsTable.customerRfqItemId })
      .from(customerPoItemsTable)
      .where(
        inArray(
          customerPoItemsTable.customerRfqItemId,
          rows.map((r) => r.customerRfqItemId),
        ),
      );
    for (const c of converted) {
      if (c.customerRfqItemId != null) convertedItemIds.add(c.customerRfqItemId);
    }
  }

  const catIds = [...new Set(rows.map((r) => r.categoryId).filter((c): c is number => c != null))];
  const cats = catIds.length
    ? await db
        .select({ id: itemCategoriesTable.id, name: itemCategoriesTable.name })
        .from(itemCategoriesTable)
        .where(inArray(itemCategoriesTable.id, catIds))
    : [];
  const catName = new Map(cats.map((c) => [c.id, c.name]));

  // Live employee names (the snapshot may be stale).
  const empIds = [...new Set(rows.map((r) => r.employeeId).filter((e): e is number => e != null))];
  const emps = empIds.length
    ? await db
        .select({ id: employeesTable.id, name: employeesTable.name, role: employeesTable.role })
        .from(employeesTable)
        .where(inArray(employeesTable.id, empIds))
    : [];
  const empById = new Map(emps.map((e) => [e.id, e]));

  const inRange = (d: Date | string | null | undefined): boolean => {
    if (!fromDate && !toDate) return true;
    if (!d) return false; // a frozen item always has a timestamp
    const t = new Date(d).getTime();
    if (fromDate && t < fromDate.getTime()) return false;
    if (toDate && t > toDate.getTime()) return false;
    return true;
  };

  type Row = {
    employeeId: number;
    employeeName: string;
    attributedItems: number;
    convertedItems: number;
    byCategory: Map<number | null, number>;
  };
  const byEmployee = new Map<number, Row>();
  let unattributedItems = 0;
  let frozenItems = 0;

  for (const r of rows) {
    if (!inRange(r.frozenAt)) continue;
    frozenItems++;
    if (r.employeeId == null) {
      // Frozen but no approved price / no owner → not credited to anyone.
      unattributedItems++;
      continue;
    }
    let row = byEmployee.get(r.employeeId);
    if (!row) {
      const e = empById.get(r.employeeId);
      row = {
        employeeId: r.employeeId,
        employeeName: e?.name ?? r.employeeName ?? `#${r.employeeId}`,
        attributedItems: 0,
        convertedItems: 0,
        byCategory: new Map(),
      };
      byEmployee.set(r.employeeId, row);
    }
    row.attributedItems++;
    if (convertedItemIds.has(r.customerRfqItemId)) row.convertedItems++;
    row.byCategory.set(r.categoryId, (row.byCategory.get(r.categoryId) ?? 0) + 1);
  }

  const employees = [...byEmployee.values()]
    .map((r) => ({
      employeeId: r.employeeId,
      employeeName: r.employeeName,
      attributedItems: r.attributedItems,
      convertedItems: r.convertedItems,
      // نسبة الإنجاز من المطلوب — share of the credited items that materialised
      // as a customer purchase order. 0 when nothing was credited (never NaN).
      achievementRate: r.attributedItems
        ? Math.round((r.convertedItems / r.attributedItems) * 1000) / 10
        : 0,
      categories: [...r.byCategory.entries()]
        .map(([categoryId, items]) => ({
          categoryId,
          categoryName: categoryId != null ? (catName.get(categoryId) ?? null) : "غير مصنّف",
          items,
        }))
        .sort((a, b) => b.items - a.items),
    }))
    .sort((a, b) => b.attributedItems - a.attributedItems);

  res.json({
    employees,
    totals: {
      frozenItems,
      attributedItems: employees.reduce((s, e) => s + e.attributedItems, 0),
      convertedItems: employees.reduce((s, e) => s + e.convertedItems, 0),
      unattributedItems,
      employeesCount: employees.length,
    },
  });
});

function emptyTotals() {
  return {
    items: 0,
    itemsWithOffers: 0,
    offersReceived: 0,
    convertedItems: 0,
    deliveredItems: 0,
    manualItems: 0,
    assignedItems: 0,
    unassignedItems: 0,
    unclassifiedItems: 0,
    totalItems: 0,
    independentSupplierItems: 0,
  };
}

export default router;

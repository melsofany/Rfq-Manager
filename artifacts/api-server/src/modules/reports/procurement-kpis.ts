/**
 * Procurement KPIs Module — مؤشرات أداء موظفي المشتريات
 *
 * Measures each procurement employee's productivity across the supplier-RFQ
 * lifecycle: RFQs owned, items, offers received (per RFQ + per item), offers
 * that converted to a purchase order, items that converted, and failed RFQs.
 *
 * The PO↔offer link is at the RFQ header level (purchase_orders.rfqId), so:
 *   - "offer converted to PO" = an offer whose RFQ has at least one linked PO
 *     (or status SUCCESS).
 *   - "item converted to PO"  = an rfq_item whose RFQ has a linked PO.
 *
 * Routes mounted (behind requireAuth):
 *   GET /analytics/procurement → per-employee procurement KPIs
 *        ?from=YYYY-MM-DD&to=YYYY-MM-DD  filters by RFQ createdAt
 */
import { Router } from "express";
import {
  db,
  rfqTable,
  rfqItemsTable,
  offersTable,
  offerItemsTable,
  purchaseOrdersTable,
  employeesTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";

const router = Router();

router.get("/analytics/procurement", requireAuth, async (req, res): Promise<void> => {
  const fromStr = req.query.from as string | undefined;
  const toStr = req.query.to as string | undefined;
  const fromDate = fromStr ? new Date(fromStr + "T00:00:00Z") : null;
  const toDate = toStr ? new Date(toStr + "T23:59:59Z") : null;

  const employees = await db
    .select({ id: employeesTable.id, name: employeesTable.name, role: employeesTable.role })
    .from(employeesTable)
    .where(eq(employeesTable.isActive, true));
  const empById = new Map(employees.map((e) => [e.id, e]));

  // ── Load RFQs (optionally filtered by createdAt range) ──────────────────
  let rfqRows: { id: number; employeeId: number | null; status: string }[];
  if (fromDate && toDate) {
    rfqRows = await db
      .select({ id: rfqTable.id, employeeId: rfqTable.employeeId, status: rfqTable.status })
      .from(rfqTable)
      .where(
        sql`${rfqTable.createdAt} >= ${fromDate.toISOString()}::timestamptz AND ${rfqTable.createdAt} <= ${toDate.toISOString()}::timestamptz`,
      );
  } else {
    rfqRows = await db
      .select({ id: rfqTable.id, employeeId: rfqTable.employeeId, status: rfqTable.status })
      .from(rfqTable);
  }

  const rfqIds = rfqRows.map((r) => r.id);
  const rfqByEmployee = new Map<number, number[]>(); // empId → rfqIds
  for (const r of rfqRows) {
    if (r.employeeId == null) continue;
    const arr = rfqByEmployee.get(r.employeeId);
    if (arr) arr.push(r.id);
    else rfqByEmployee.set(r.employeeId, [r.id]);
  }

  // ── RFQ items ───────────────────────────────────────────────────────────
  const rfqItemRows = rfqIds.length
    ? await db
        .select({ id: rfqItemsTable.id, rfqId: rfqItemsTable.rfqId })
        .from(rfqItemsTable)
        .where(sql`${rfqItemsTable.rfqId} = ANY(ARRAY[${sql.raw(rfqIds.join(",") || "0")}]::int[])`)
    : [];
  const itemsByRfq = new Map<number, number[]>(); // rfqId → itemIds
  const allItemIds: number[] = [];
  for (const it of rfqItemRows) {
    allItemIds.push(it.id);
    const arr = itemsByRfq.get(it.rfqId);
    if (arr) arr.push(it.id);
    else itemsByRfq.set(it.rfqId, [it.id]);
  }

  // ── Offers (per RFQ) ────────────────────────────────────────────────────
  const offerRows = rfqIds.length
    ? await db
        .select({ id: offersTable.id, rfqId: offersTable.rfqId })
        .from(offersTable)
        .where(sql`${offersTable.rfqId} = ANY(ARRAY[${sql.raw(rfqIds.join(",") || "0")}]::int[])`)
    : [];
  const offersByRfq = new Map<number, number>(); // rfqId → offer count
  for (const o of offerRows) {
    offersByRfq.set(o.rfqId, (offersByRfq.get(o.rfqId) ?? 0) + 1);
  }

  // ── Offer items (per RFQ item) ──────────────────────────────────────────
  const offerItemRows = allItemIds.length
    ? await db
        .select({ id: offerItemsTable.id, rfqItemId: offerItemsTable.rfqItemId })
        .from(offerItemsTable)
        .where(
          sql`${offerItemsTable.rfqItemId} = ANY(ARRAY[${sql.raw(allItemIds.join(",") || "0")}]::int[])`,
        )
    : [];
  const offerItemsByRfqItem = new Map<number, number>(); // rfqItemId → offer_item count
  for (const oi of offerItemRows) {
    offerItemsByRfqItem.set(oi.rfqItemId, (offerItemsByRfqItem.get(oi.rfqItemId) ?? 0) + 1);
  }

  // ── Purchase orders linked to these RFQs (which RFQs converted) ─────────
  const poRows = rfqIds.length
    ? await db
        .select({ id: purchaseOrdersTable.id, rfqId: purchaseOrdersTable.rfqId })
        .from(purchaseOrdersTable)
        .where(
          sql`${purchaseOrdersTable.rfqId} = ANY(ARRAY[${sql.raw(rfqIds.join(",") || "0")}]::int[])`,
        )
    : [];
  const rfqsWithPo = new Set<number>(poRows.map((p) => p.rfqId).filter((x): x is number => x != null));

  // An RFQ "converted to PO" if it has a linked PO OR status SUCCESS.
  const converted = (rfqId: number, status: string) => rfqsWithPo.has(rfqId) || status === "SUCCESS";

  // ── Per-employee aggregation ────────────────────────────────────────────
  const rows = employees.map((emp) => {
    const myRfqs = rfqByEmployee.get(emp.id) ?? [];
    let rfqCount = 0;
    let failedRfqs = 0;
    let itemCount = 0;
    let offerCount = 0;
    let offerItemCount = 0;
    let convertedRfqs = 0;
    let convertedItems = 0;
    let itemsWithOffers = 0;

    for (const rfqId of myRfqs) {
      const rfq = rfqRows.find((r) => r.id === rfqId)!;
      rfqCount++;
      if (rfq.status === "FAILED") failedRfqs++;
      const itemIds = itemsByRfq.get(rfqId) ?? [];
      itemCount += itemIds.length;
      offerCount += offersByRfq.get(rfqId) ?? 0;
      let itemOfferTotal = 0;
      for (const itemId of itemIds) {
        const c = offerItemsByRfqItem.get(itemId) ?? 0;
        offerItemCount += c;
        if (c > 0) itemsWithOffers++;
      }
      const conv = converted(rfqId, rfq.status);
      if (conv) {
        convertedRfqs++;
        convertedItems += itemIds.length;
      }
    }

    const avgOffersPerRfq = rfqCount ? offerCount / rfqCount : 0;
    const avgOfferItemsPerItem = itemCount ? offerItemCount / itemCount : 0;
    const conversionRate = rfqCount ? (convertedRfqs / rfqCount) * 100 : 0;

    return {
      employeeId: emp.id,
      employeeName: emp.name,
      role: emp.role,
      rfqCount,
      itemCount,
      offerCount,
      avgOffersPerRfq: Math.round(avgOffersPerRfq * 100) / 100,
      avgOfferItemsPerItem: Math.round(avgOfferItemsPerItem * 100) / 100,
      convertedRfqs,
      convertedItems,
      conversionRate: Math.round(conversionRate * 10) / 10,
      failedRfqs,
      itemsWithOffers,
    };
  });

  // Sort by RFQ count desc (most active first).
  rows.sort((a, b) => b.rfqCount - a.rfqCount);

  const totals = {
    rfqCount: rows.reduce((s, r) => s + r.rfqCount, 0),
    itemCount: rows.reduce((s, r) => s + r.itemCount, 0),
    offerCount: rows.reduce((s, r) => s + r.offerCount, 0),
    convertedRfqs: rows.reduce((s, r) => s + r.convertedRfqs, 0),
    convertedItems: rows.reduce((s, r) => s + r.convertedItems, 0),
    failedRfqs: rows.reduce((s, r) => s + r.failedRfqs, 0),
  };

  res.json({ employees: rows, totals });
});

export default router;

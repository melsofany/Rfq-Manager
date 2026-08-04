import { Router } from "express";
import {
  db,
  rfqTable,
  suppliersTable,
  offersTable,
  sentLogTable,
  employeesTable,
  rfqItemsTable,
  offerItemsTable,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
} from "@workspace/db";
import { eq, count, sql, desc, isNotNull, gte, lte, and } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";

const router = Router();

router.get("/analytics/dashboard", requireAuth, async (req, res): Promise<void> => {
  // ── Core KPIs ──────────────────────────────────────────────────────────────
  const [totalRfqs] = await db.select({ cnt: count() }).from(rfqTable);
  // Open = actively sent to suppliers and awaiting a decision (SENT or QUOTED).
  // DRAFT is excluded — those haven't been sent to any supplier yet.
  const [openRfqs] = await db
    .select({ cnt: count() })
    .from(rfqTable)
    .where(sql`${rfqTable.status} IN ('SENT','QUOTED')`);
  const [totalSuppliers] = await db
    .select({ cnt: count() })
    .from(suppliersTable)
    .where(eq(suppliersTable.isActive, true));
  const [totalOffers] = await db.select({ cnt: count() }).from(offersTable);
  const [totalPos] = await db.select({ cnt: count() }).from(purchaseOrdersTable);

  // ── RFQs by status ─────────────────────────────────────────────────────────
  const rfqsByStatus = await db
    .select({ status: rfqTable.status, count: count() })
    .from(rfqTable)
    .groupBy(rfqTable.status);

  // ── Recent RFQs ────────────────────────────────────────────────────────────
  const recentRfqRows = await db
    .select({ rfq: rfqTable, employeeName: employeesTable.name })
    .from(rfqTable)
    .leftJoin(employeesTable, eq(rfqTable.employeeId, employeesTable.id))
    .orderBy(desc(rfqTable.createdAt))
    .limit(5);

  // Fetch real item counts and offer counts for recent RFQs
  const recentRfqIds = recentRfqRows.map((r) => r.rfq.id);

  const [itemCountRows, offerCountRows] =
    recentRfqIds.length > 0
      ? await Promise.all([
          db
            .select({ rfqId: rfqItemsTable.rfqId, cnt: count() })
            .from(rfqItemsTable)
            .where(
              sql`${rfqItemsTable.rfqId} = ANY(ARRAY[${sql.raw(recentRfqIds.join(","))}]::int[])`,
            )
            .groupBy(rfqItemsTable.rfqId),
          db
            .select({ rfqId: offersTable.rfqId, cnt: count() })
            .from(offersTable)
            .where(
              sql`${offersTable.rfqId} = ANY(ARRAY[${sql.raw(recentRfqIds.join(","))}]::int[])`,
            )
            .groupBy(offersTable.rfqId),
        ])
      : [[], []];

  const recentRfqs = recentRfqRows.map((r) => ({
    id: r.rfq.id,
    internalRfqNo: r.rfq.internalRfqNo,
    customerRfqNo: r.rfq.customerRfqNo,
    customerRfqDate: r.rfq.customerRfqDate,
    requiredResponseDate: r.rfq.requiredResponseDate,
    status: r.rfq.status,
    employeeId: r.rfq.employeeId,
    employeeName: r.employeeName,
    notes: r.rfq.notes,
    itemCount: itemCountRows.find((ic) => ic.rfqId === r.rfq.id)?.cnt ?? 0,
    supplierCount: 0,
    offerCount: offerCountRows.find((oc) => oc.rfqId === r.rfq.id)?.cnt ?? 0,
    createdAt: r.rfq.createdAt.toISOString(),
    updatedAt: r.rfq.updatedAt.toISOString(),
  }));

  // ── Response rate ──────────────────────────────────────────────────────────
  const [totalSent] = await db.select({ cnt: count() }).from(sentLogTable);
  const [totalOffersCnt] = await db.select({ cnt: count() }).from(offersTable);
  const responseRate =
    (totalSent?.cnt ?? 0) > 0 ? ((totalOffersCnt?.cnt ?? 0) / (totalSent?.cnt ?? 1)) * 100 : 0;

  // ── Avg response time (hours between sent and offer received) ──────────────
  const avgResponseTimeResult = await db
    .select({
      avgHours: sql<string | null>`
        avg(
          extract(epoch from (${offersTable.createdAt} - ${sentLogTable.createdAt})) / 3600
        )`,
    })
    .from(offersTable)
    .innerJoin(sentLogTable, eq(offersTable.sentLogId, sentLogTable.id));
  const avgResponseTimeHours = avgResponseTimeResult[0]?.avgHours
    ? Math.round(parseFloat(avgResponseTimeResult[0].avgHours))
    : null;

  // ── Item pricing analytics ─────────────────────────────────────────────────
  // Total items across all RFQs
  const [totalItemsRow] = await db.select({ cnt: count() }).from(rfqItemsTable);
  const totalItems = totalItemsRow?.cnt ?? 0;

  // Items that have at least one offer price (join offer_items)
  const pricedItemsRows = await db
    .selectDistinct({ rfqItemId: offerItemsTable.rfqItemId })
    .from(offerItemsTable);
  const pricedItems = pricedItemsRows.length;
  const unpricedItems = Math.max(0, totalItems - pricedItems);

  // Items that appear in any purchase_order_items (by partNo or itemId matching)
  // We count PO items as unique items awarded
  const [poItemsRow] = await db.select({ cnt: count() }).from(purchaseOrderItemsTable);
  const itemsWithPo = poItemsRow?.cnt ?? 0;

  const pricingRate = totalItems > 0 ? Math.round((pricedItems / totalItems) * 1000) / 10 : 0;
  const poRate = totalItems > 0 ? Math.round((itemsWithPo / totalItems) * 1000) / 10 : 0;

  // ── RFQ → PO conversion ────────────────────────────────────────────────────
  const [rfqsWithPoRow] = await db
    .select({ cnt: count() })
    .from(purchaseOrdersTable)
    .where(isNotNull(purchaseOrdersTable.rfqId));
  const rfqsWithPo = rfqsWithPoRow?.cnt ?? 0;
  const totalRfqsCount = totalRfqs?.cnt ?? 0;
  const rfqToPoRate =
    totalRfqsCount > 0 ? Math.round((rfqsWithPo / totalRfqsCount) * 1000) / 10 : 0;

  // ── Deep supplier analytics ────────────────────────────────────────────────
  const allSuppliers = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.isActive, true));

  const supplierDeepStats = await Promise.all(
    allSuppliers.map(async (s) => {
      // Sent count
      const [sentStats] = await db
        .select({ total: count() })
        .from(sentLogTable)
        .where(eq(sentLogTable.supplierId, s.id));
      const totalSentToSupplier = sentStats?.total ?? 0;

      // Offers submitted
      const [offerCount] = await db
        .select({ cnt: count() })
        .from(offersTable)
        .where(eq(offersTable.supplierId, s.id));
      const totalOffersSubmitted = offerCount?.cnt ?? 0;

      const responseRateSupplier =
        totalSentToSupplier > 0
          ? Math.round((totalOffersSubmitted / totalSentToSupplier) * 1000) / 10
          : 0;

      // Items offered (total offer_items for this supplier)
      const [itemsOfferedRow] = await db
        .select({ cnt: count() })
        .from(offerItemsTable)
        .leftJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
        .where(eq(offersTable.supplierId, s.id));
      const totalItemsOffered = itemsOfferedRow?.cnt ?? 0;

      // Items awarded PO (purchase_order_items linked to this supplier)
      const [poWinRow] = await db
        .select({ cnt: count() })
        .from(purchaseOrderItemsTable)
        .where(eq(purchaseOrderItemsTable.supplierId, s.id));
      const totalPoItems = poWinRow?.cnt ?? 0;

      const poWinRate =
        totalItemsOffered > 0 ? Math.round((totalPoItems / totalItemsOffered) * 1000) / 10 : 0;

      // Avg price from offer_items
      const [avgPriceRow] = await db
        .select({ avg: sql<string | null>`avg(${offerItemsTable.price}::numeric)` })
        .from(offerItemsTable)
        .leftJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
        .where(eq(offersTable.supplierId, s.id));
      const avgPrice = avgPriceRow?.avg ? parseFloat(avgPriceRow.avg) : null;

      // Avg delivery days
      const [avgDeliveryRow] = await db
        .select({ avg: sql<string | null>`avg(${offerItemsTable.deliveryDays})` })
        .from(offerItemsTable)
        .leftJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
        .where(eq(offersTable.supplierId, s.id));
      const avgDeliveryDays = avgDeliveryRow?.avg
        ? Math.round(parseFloat(avgDeliveryRow.avg))
        : null;

      return {
        supplierId: s.id,
        supplierName: s.name,
        category: s.category,
        totalRfqsReceived: totalSentToSupplier,
        totalOffersSubmitted,
        responseRate: responseRateSupplier,
        totalItemsOffered,
        totalPoItems,
        poWinRate,
        avgPrice,
        avgDeliveryDays,
      };
    }),
  );

  // Sort by totalOffersSubmitted desc, take top 10
  const topSuppliersSorted = supplierDeepStats
    .sort((a, b) => b.totalOffersSubmitted - a.totalOffersSubmitted)
    .slice(0, 10);

  // Legacy topSuppliers field (scorecard format)
  const topSuppliers = topSuppliersSorted.map((s) => ({
    supplierId: s.supplierId,
    supplierName: s.supplierName,
    totalScore: Math.round(s.responseRate * 0.4 + s.poWinRate * 0.4 + 20),
    onTimeScore: 80,
    priceScore: 70,
    responseRateScore: Math.round(s.responseRate),
    qualityScore: 75,
    totalRfqsReceived: s.totalRfqsReceived,
    totalOffersSubmitted: s.totalOffersSubmitted,
    responseRate: s.responseRate,
    avgPriceDelta: 0,
  }));

  res.json({
    totalRfqs: totalRfqsCount,
    openRfqs: openRfqs?.cnt ?? 0,
    totalSuppliers: totalSuppliers?.cnt ?? 0,
    totalOffers: totalOffers?.cnt ?? 0,
    rfqsByStatus: rfqsByStatus.map((r) => ({ status: r.status, count: r.count })),
    recentRfqs,
    topSuppliers,
    responseRateThisMonth: Math.round(responseRate),
    avgResponseTimeHours,
    // Item & PO analytics
    totalItems,
    pricedItems,
    unpricedItems,
    itemsWithPo,
    pricingRate,
    poRate,
    totalPos: totalPos?.cnt ?? 0,
    rfqsWithPo,
    rfqToPoRate,
    supplierDeepStats: topSuppliersSorted,
  });
});

router.get("/analytics/employee/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const employeeId = parseInt(raw, 10);

  const [employee] = await db
    .select()
    .from(employeesTable)
    .where(eq(employeesTable.id, employeeId));
  if (!employee) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const [rfqsSent] = await db
    .select({ cnt: count() })
    .from(sentLogTable)
    .where(eq(sentLogTable.employeeId, employeeId));
  const [rfqsCreated] = await db
    .select({ cnt: count() })
    .from(rfqTable)
    .where(eq(rfqTable.employeeId, employeeId));

  const totalSentEmp = rfqsSent?.cnt ?? 0;
  const [offerCount] = await db
    .select({ cnt: count() })
    .from(offersTable)
    .leftJoin(sentLogTable, eq(offersTable.sentLogId, sentLogTable.id))
    .where(eq(sentLogTable.employeeId, employeeId));

  const responseRateEmp = totalSentEmp > 0 ? ((offerCount?.cnt ?? 0) / totalSentEmp) * 100 : 0;

  res.json({
    employee: {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      role: employee.role,
      phone: employee.phone,
      isActive: employee.isActive,
      createdAt: employee.createdAt.toISOString(),
    },
    totalRfqsSent: rfqsCreated?.cnt ?? 0,
    totalOffersReceived: offerCount?.cnt ?? 0,
    responseRate: Math.round(responseRateEmp),
    avgSendTimeHours: 2,
    totalPurchaseValue: 0,
    awardRate: 0,
    rfqsByMonth: [],
  });
});

router.get("/analytics/price-analysis/:rfqId", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.rfqId) ? req.params.rfqId[0] : req.params.rfqId;
  const rfqId = parseInt(raw, 10);
  res.json({ rfqId, itemAnalysis: [] });
});

// NEW: Comprehensive Reports endpoint with date-range filtering
// GET /analytics/reports?from=YYYY-MM-DD&to=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────
router.get("/analytics/reports", requireAuth, async (req, res): Promise<void> => {
  const fromStr = req.query.from as string | undefined;
  const toStr = req.query.to as string | undefined;

  // Build optional date filters
  const fromDate = fromStr ? new Date(fromStr + "T00:00:00Z") : null;
  const toDate = toStr ? new Date(toStr + "T23:59:59Z") : null;

  function rfqDateFilter() {
    if (fromDate && toDate)
      return and(gte(rfqTable.createdAt, fromDate), lte(rfqTable.createdAt, toDate));
    if (fromDate) return gte(rfqTable.createdAt, fromDate);
    if (toDate) return lte(rfqTable.createdAt, toDate);
    return undefined;
  }
  function poDateFilter() {
    if (fromDate && toDate)
      return and(
        gte(purchaseOrdersTable.createdAt, fromDate),
        lte(purchaseOrdersTable.createdAt, toDate),
      );
    if (fromDate) return gte(purchaseOrdersTable.createdAt, fromDate);
    if (toDate) return lte(purchaseOrdersTable.createdAt, toDate);
    return undefined;
  }
  function rfqItemDateFilter() {
    if (fromDate && toDate)
      return and(gte(rfqItemsTable.createdAt, fromDate), lte(rfqItemsTable.createdAt, toDate));
    if (fromDate) return gte(rfqItemsTable.createdAt, fromDate);
    if (toDate) return lte(rfqItemsTable.createdAt, toDate);
    return undefined;
  }

  // ── 1. Employee Performance ────────────────────────────────────
  const allEmployees = await db
    .select()
    .from(employeesTable)
    .where(eq(employeesTable.isActive, true));

  const rfqFilter = rfqDateFilter();
  const rfqsInRange = rfqFilter
    ? await db
        .select({
          id: rfqTable.id,
          employeeId: rfqTable.employeeId,
          status: rfqTable.status,
          createdAt: rfqTable.createdAt,
        })
        .from(rfqTable)
        .where(rfqFilter)
    : await db
        .select({
          id: rfqTable.id,
          employeeId: rfqTable.employeeId,
          status: rfqTable.status,
          createdAt: rfqTable.createdAt,
        })
        .from(rfqTable);

  // Get RFQ ids in range for joining offers / PO
  const rfqIdsInRange = rfqsInRange.map((r) => r.id);

  // Count offers per RFQ
  const offersAll =
    rfqIdsInRange.length > 0
      ? await db
          .select({ rfqId: offersTable.rfqId, employeeId: offersTable.employeeId })
          .from(offersTable)
          .where(
            sql`${offersTable.rfqId} = ANY(ARRAY[${sql.raw(rfqIdsInRange.join(",") || "0")}]::int[])`,
          )
      : [];

  // POs in range — include createdAt for monthly trend calculation
  const poFilter = poDateFilter();
  const posInRange = poFilter
    ? await db
        .select({
          id: purchaseOrdersTable.id,
          rfqId: purchaseOrdersTable.rfqId,
          employeeId: purchaseOrdersTable.employeeId,
          createdAt: purchaseOrdersTable.createdAt,
        })
        .from(purchaseOrdersTable)
        .where(poFilter)
    : await db
        .select({
          id: purchaseOrdersTable.id,
          rfqId: purchaseOrdersTable.rfqId,
          employeeId: purchaseOrdersTable.employeeId,
          createdAt: purchaseOrdersTable.createdAt,
        })
        .from(purchaseOrdersTable);

  const employeeStats = allEmployees
    .map((emp) => {
      const myRfqs = rfqsInRange.filter((r) => r.employeeId === emp.id);
      const myOffers = offersAll.filter(
        (o) => o.employeeId === emp.id || myRfqs.some((r) => r.id === o.rfqId && !o.employeeId),
      );
      const myPos = posInRange.filter(
        (p) => p.employeeId === emp.id || myRfqs.some((r) => r.id === p.rfqId),
      );
      const successRfqs = myRfqs.filter((r) => r.status === "SUCCESS" || r.status === "QUOTED");
      return {
        employeeId: emp.id,
        employeeName: emp.name,
        role: emp.role,
        totalRfqs: myRfqs.length,
        totalOffers: myOffers.length,
        totalPos: myPos.length,
        successRfqs: successRfqs.length,
        conversionRate: myRfqs.length > 0 ? Math.round((myPos.length / myRfqs.length) * 100) : 0,
      };
    })
    .filter((e) => e.totalRfqs > 0 || e.totalOffers > 0);

  // ── 2. Most Requested Items (from PO items in range) ──────────
  const poIdsInRange = posInRange.map((p) => p.id);
  const poItemsAll =
    poIdsInRange.length > 0
      ? await db
          .select({
            description: purchaseOrderItemsTable.description,
            partNo: purchaseOrderItemsTable.partNo,
            lineItem: purchaseOrderItemsTable.lineItem,
            qty: purchaseOrderItemsTable.qty,
          })
          .from(purchaseOrderItemsTable)
          .where(
            sql`${purchaseOrderItemsTable.poId} = ANY(ARRAY[${sql.raw(poIdsInRange.join(",") || "0")}]::int[])`,
          )
      : [];

  // Aggregate by description (normalize)
  const itemMap = new Map<
    string,
    {
      description: string;
      partNo: string | null;
      lineItem: string | null;
      count: number;
      totalQty: number;
    }
  >();
  for (const item of poItemsAll) {
    const key = (item.description ?? "").trim().toLowerCase();
    if (!key) continue;
    const existing = itemMap.get(key);
    const qty = parseFloat(item.qty ?? "0") || 0;
    if (existing) {
      existing.count += 1;
      existing.totalQty += qty;
    } else {
      itemMap.set(key, {
        description: item.description,
        partNo: item.partNo,
        lineItem: item.lineItem,
        count: 1,
        totalQty: qty,
      });
    }
  }
  const topItems = Array.from(itemMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // ── 3. Line Item Statistics (from rfq_items in range) ─────────
  const rfqItemFilter = rfqItemDateFilter();
  const rfqItemsInRange = rfqItemFilter
    ? await db
        .select({
          lineItem: rfqItemsTable.lineItem,
          description: rfqItemsTable.description,
          rfqId: rfqItemsTable.rfqId,
        })
        .from(rfqItemsTable)
        .where(rfqItemFilter)
    : await db
        .select({
          lineItem: rfqItemsTable.lineItem,
          description: rfqItemsTable.description,
          rfqId: rfqItemsTable.rfqId,
        })
        .from(rfqItemsTable);

  // Group by lineItem
  const lineItemMap = new Map<
    string,
    { lineItem: string; count: number; distinctRfqs: Set<number> }
  >();
  for (const item of rfqItemsInRange) {
    const key = (item.lineItem ?? "—").trim();
    const existing = lineItemMap.get(key);
    if (existing) {
      existing.count += 1;
      existing.distinctRfqs.add(item.rfqId);
    } else {
      lineItemMap.set(key, { lineItem: key, count: 1, distinctRfqs: new Set([item.rfqId]) });
    }
  }
  const lineItemStats = Array.from(lineItemMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map((i) => ({ lineItem: i.lineItem, count: i.count, distinctRfqs: i.distinctRfqs.size }));

  // ── 4. Monthly Trends ─────────────────────────────────────────
  const rfqByMonth = rfqsInRange.reduce<Record<string, number>>((acc, r) => {
    const month = r.createdAt.toISOString().substring(0, 7);
    acc[month] = (acc[month] ?? 0) + 1;
    return acc;
  }, {});

  // Now posInRange includes createdAt — calculate PO counts per month
  const poByMonth = posInRange.reduce<Record<string, number>>((acc, p) => {
    const month = p.createdAt.toISOString().substring(0, 7);
    acc[month] = (acc[month] ?? 0) + 1;
    return acc;
  }, {});

  // Merge all months from both RFQs and POs
  const allMonths = Array.from(
    new Set([...Object.keys(rfqByMonth), ...Object.keys(poByMonth)]),
  ).sort();

  const monthlyTrend = allMonths.map((month) => ({
    month,
    rfqs: rfqByMonth[month] ?? 0,
    pos: poByMonth[month] ?? 0,
  }));

  // ── 5. Status Funnel ─────────────────────────────────────────
  const statusFunnel = rfqsInRange.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  // ── 6. Total Summary ─────────────────────────────────────────
  const totalRfqsInPeriod = rfqsInRange.length;
  const totalPosInPeriod = posInRange.length;
  const totalItemsInPeriod = rfqItemsInRange.length;
  const conversionRate =
    totalRfqsInPeriod > 0 ? Math.round((totalPosInPeriod / totalRfqsInPeriod) * 100) : 0;

  res.json({
    period: { from: fromStr ?? null, to: toStr ?? null },
    summary: {
      totalRfqs: totalRfqsInPeriod,
      totalPos: totalPosInPeriod,
      totalItems: totalItemsInPeriod,
      conversionRate,
    },
    employeeStats,
    topItems,
    lineItemStats,
    monthlyTrend,
    statusFunnel: Object.entries(statusFunnel).map(([status, count]) => ({ status, count })),
  });
});
export default router;

import { Router } from "express";
import { db, rfqTable, suppliersTable, offersTable, sentLogTable, employeesTable, rfqItemsTable, offerItemsTable, purchaseOrdersTable, purchaseOrderItemsTable } from "@workspace/db";
import { eq, count, sql, desc, isNotNull } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.get("/analytics/dashboard", requireAuth, async (req, res): Promise<void> => {
  // ── Core KPIs ──────────────────────────────────────────────────────────────
  const [totalRfqs] = await db.select({ cnt: count() }).from(rfqTable);
  const [openRfqs] = await db.select({ cnt: count() }).from(rfqTable).where(sql`${rfqTable.status} IN ('DRAFT','SENT','QUOTED')`);
  const [totalSuppliers] = await db.select({ cnt: count() }).from(suppliersTable).where(eq(suppliersTable.isActive, true));
  const [totalOffers] = await db.select({ cnt: count() }).from(offersTable);
  const [totalPos] = await db.select({ cnt: count() }).from(purchaseOrdersTable);

  // ── RFQs by status ─────────────────────────────────────────────────────────
  const rfqsByStatus = await db.select({ status: rfqTable.status, count: count() })
    .from(rfqTable).groupBy(rfqTable.status);

  // ── Recent RFQs ────────────────────────────────────────────────────────────
  const recentRfqRows = await db.select({ rfq: rfqTable, employeeName: employeesTable.name })
    .from(rfqTable)
    .leftJoin(employeesTable, eq(rfqTable.employeeId, employeesTable.id))
    .orderBy(desc(rfqTable.createdAt))
    .limit(5);

  const recentRfqs = recentRfqRows.map(r => ({
    id: r.rfq.id, internalRfqNo: r.rfq.internalRfqNo, customerRfqNo: r.rfq.customerRfqNo,
    customerRfqDate: r.rfq.customerRfqDate, requiredResponseDate: r.rfq.requiredResponseDate,
    status: r.rfq.status, employeeId: r.rfq.employeeId, employeeName: r.employeeName,
    notes: r.rfq.notes, itemCount: 0, supplierCount: 0, offerCount: 0,
    createdAt: r.rfq.createdAt.toISOString(), updatedAt: r.rfq.updatedAt.toISOString(),
  }));

  // ── Response rate ──────────────────────────────────────────────────────────
  const [totalSent] = await db.select({ cnt: count() }).from(sentLogTable);
  const [totalOffersCnt] = await db.select({ cnt: count() }).from(offersTable);
  const responseRate = (totalSent?.cnt ?? 0) > 0
    ? ((totalOffersCnt?.cnt ?? 0) / (totalSent?.cnt ?? 1)) * 100 : 0;

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
  const rfqToPoRate = totalRfqsCount > 0
    ? Math.round((rfqsWithPo / totalRfqsCount) * 1000) / 10 : 0;

  // ── Deep supplier analytics ────────────────────────────────────────────────
  const allSuppliers = await db.select().from(suppliersTable).where(eq(suppliersTable.isActive, true));

  const supplierDeepStats = await Promise.all(allSuppliers.map(async (s) => {
    // Sent count
    const [sentStats] = await db.select({ total: count() })
      .from(sentLogTable).where(eq(sentLogTable.supplierId, s.id));
    const totalSentToSupplier = sentStats?.total ?? 0;

    // Offers submitted
    const [offerCount] = await db.select({ cnt: count() })
      .from(offersTable).where(eq(offersTable.supplierId, s.id));
    const totalOffersSubmitted = offerCount?.cnt ?? 0;

    const responseRateSupplier = totalSentToSupplier > 0
      ? Math.round((totalOffersSubmitted / totalSentToSupplier) * 1000) / 10 : 0;

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

    const poWinRate = totalItemsOffered > 0
      ? Math.round((totalPoItems / totalItemsOffered) * 1000) / 10 : 0;

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
    const avgDeliveryDays = avgDeliveryRow?.avg ? Math.round(parseFloat(avgDeliveryRow.avg)) : null;

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
  }));

  // Sort by totalOffersSubmitted desc, take top 10
  const topSuppliersSorted = supplierDeepStats
    .sort((a, b) => b.totalOffersSubmitted - a.totalOffersSubmitted)
    .slice(0, 10);

  // Legacy topSuppliers field (scorecard format)
  const topSuppliers = topSuppliersSorted.map(s => ({
    supplierId: s.supplierId,
    supplierName: s.supplierName,
    totalScore: Math.round((s.responseRate * 0.4) + (s.poWinRate * 0.4) + 20),
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
    rfqsByStatus: rfqsByStatus.map(r => ({ status: r.status, count: r.count })),
    recentRfqs,
    topSuppliers,
    responseRateThisMonth: Math.round(responseRate),
    avgResponseTimeHours: 24,
    // New fields
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

  const [employee] = await db.select().from(employeesTable).where(eq(employeesTable.id, employeeId));
  if (!employee) { res.status(404).json({ error: "Not found" }); return; }

  const [rfqsSent] = await db.select({ cnt: count() }).from(sentLogTable).where(eq(sentLogTable.employeeId, employeeId));
  const [rfqsCreated] = await db.select({ cnt: count() }).from(rfqTable).where(eq(rfqTable.employeeId, employeeId));

  const totalSentEmp = rfqsSent?.cnt ?? 0;
  const [offerCount] = await db.select({ cnt: count() }).from(offersTable)
    .leftJoin(sentLogTable, eq(offersTable.sentLogId, sentLogTable.id))
    .where(eq(sentLogTable.employeeId, employeeId));

  const responseRateEmp = totalSentEmp > 0 ? ((offerCount?.cnt ?? 0) / totalSentEmp) * 100 : 0;

  res.json({
    employee: {
      id: employee.id, name: employee.name, email: employee.email,
      role: employee.role, phone: employee.phone, isActive: employee.isActive,
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

export default router;

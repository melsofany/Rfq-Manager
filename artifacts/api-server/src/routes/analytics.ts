import { Router } from "express";
import { db, rfqTable, suppliersTable, offersTable, sentLogTable, employeesTable, rfqItemsTable } from "@workspace/db";
import { eq, count, sql, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.get("/analytics/dashboard", requireAuth, async (req, res): Promise<void> => {
  const [totalRfqs] = await db.select({ cnt: count() }).from(rfqTable);
  const [openRfqs] = await db.select({ cnt: count() }).from(rfqTable).where(sql`${rfqTable.status} IN ('DRAFT','SENT','QUOTED')`);
  const [totalSuppliers] = await db.select({ cnt: count() }).from(suppliersTable).where(eq(suppliersTable.isActive, true));
  const [totalOffers] = await db.select({ cnt: count() }).from(offersTable);

  const rfqsByStatus = await db.select({ status: rfqTable.status, count: count() })
    .from(rfqTable).groupBy(rfqTable.status);

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

  // Top suppliers by offer count
  const supplierOfferCounts = await db.select({
    supplierId: offersTable.supplierId,
    offerCount: count(),
  }).from(offersTable).groupBy(offersTable.supplierId).orderBy(desc(count())).limit(5);

  const topSuppliers = await Promise.all(supplierOfferCounts.map(async sc => {
    const [s] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, sc.supplierId));
    const [sentStats] = await db.select({ total: count() }).from(sentLogTable).where(eq(sentLogTable.supplierId, sc.supplierId));
    const totalSent = sentStats?.total ?? 0;
    const responseRate = totalSent > 0 ? (sc.offerCount / totalSent) * 100 : 0;
    return {
      supplierId: sc.supplierId,
      supplierName: s?.name || "",
      totalScore: 75,
      onTimeScore: 80,
      priceScore: 70,
      responseRateScore: Math.round(responseRate),
      qualityScore: 75,
      totalRfqsReceived: totalSent,
      totalOffersSubmitted: sc.offerCount,
      responseRate: Math.round(responseRate * 10) / 10,
      avgPriceDelta: 0,
    };
  }));

  const [totalSent] = await db.select({ cnt: count() }).from(sentLogTable);
  const [totalOffersCnt] = await db.select({ cnt: count() }).from(offersTable);
  const responseRate = (totalSent?.cnt ?? 0) > 0
    ? ((totalOffersCnt?.cnt ?? 0) / (totalSent?.cnt ?? 1)) * 100 : 0;

  res.json({
    totalRfqs: totalRfqs?.cnt ?? 0,
    openRfqs: openRfqs?.cnt ?? 0,
    totalSuppliers: totalSuppliers?.cnt ?? 0,
    totalOffers: totalOffers?.cnt ?? 0,
    rfqsByStatus: rfqsByStatus.map(r => ({ status: r.status, count: r.count })),
    recentRfqs,
    topSuppliers,
    responseRateThisMonth: Math.round(responseRate),
    avgResponseTimeHours: 24,
  });
});

router.get("/analytics/employee/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const employeeId = parseInt(raw, 10);

  const [employee] = await db.select().from(employeesTable).where(eq(employeesTable.id, employeeId));
  if (!employee) { res.status(404).json({ error: "Not found" }); return; }

  const [rfqsSent] = await db.select({ cnt: count() }).from(sentLogTable).where(eq(sentLogTable.employeeId, employeeId));
  const [rfqsCreated] = await db.select({ cnt: count() }).from(rfqTable).where(eq(rfqTable.employeeId, employeeId));

  const totalSent = rfqsSent?.cnt ?? 0;
  const [offerCount] = await db.select({ cnt: count() }).from(offersTable)
    .leftJoin(sentLogTable, eq(offersTable.sentLogId, sentLogTable.id))
    .where(eq(sentLogTable.employeeId, employeeId));

  const responseRate = totalSent > 0 ? ((offerCount?.cnt ?? 0) / totalSent) * 100 : 0;

  res.json({
    employee: {
      id: employee.id, name: employee.name, email: employee.email,
      role: employee.role, phone: employee.phone, isActive: employee.isActive,
      createdAt: employee.createdAt.toISOString(),
    },
    totalRfqsSent: rfqsCreated?.cnt ?? 0,
    totalOffersReceived: offerCount?.cnt ?? 0,
    responseRate: Math.round(responseRate),
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

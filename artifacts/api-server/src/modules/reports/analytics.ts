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
  customerRfqsTable,
  customerRfqItemsTable,
  customerPosTable,
  customerPoItemsTable,
  customersTable,
  representativesTable,
  whatsappChatsTable,
  auditLogTable,
  operatingExpensesTable,
  customerPoPaymentsTable,
  supplierInvoicesTable,
  salesInvoicesTable,
  journalEntriesTable,
  chartOfAccountsTable,
  taxSettingsTable,
  poItemReceiptsTable,
  customerPoItemDeliveriesTable,
  workOrderAssignmentsTable,
  ACCOUNT_CODES,
} from "@workspace/db";
import {
  eq,
  ne,
  count,
  countDistinct,
  sql,
  desc,
  isNotNull,
  gte,
  lte,
  and,
  or,
  inArray,
} from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { round2, rateOf } from "../accounts/tax";
import { accountBalance } from "../accounts/posting";

const router = Router();

async function loadTaxSettings() {
  const rows = await db.select().from(taxSettingsTable).limit(1);
  const row = rows[0];
  return {
    vatRate: rateOf(row?.vatRate, 14),
    withholdingRate: rateOf(row?.withholdingRate, 3),
  };
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return isFinite(n) ? n : null;
}

function fmt(n: number | null): number | null {
  return n == null ? null : round2(n);
}

function parsePricingDeadline(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  // close_date is stored as a date string. Treat that date as open through
  // the end of the day, matching the supplier pricing endpoint behavior.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    parsed.setUTCHours(23, 59, 59, 999);
  }
  return parsed;
}

router.get("/analytics/dashboard", requireAuth, async (req, res): Promise<void> => {
  // ── Core KPIs ──────────────────────────────────────────────────────────────
  const [totalRfqs] = await db.select({ cnt: count() }).from(rfqTable);

  // An RFQ is open only while its pricing deadline has not passed. The latest
  // supplier close date is the effective deadline when suppliers have different
  // deadlines; expires_at / required_response_date are fallbacks for RFQs that
  // do not yet have a sent-log row.
  const dashboardNow = new Date();
  const openCandidates = await db
    .select({
      id: rfqTable.id,
      status: rfqTable.status,
      expiresAt: rfqTable.expiresAt,
      requiredResponseDate: rfqTable.requiredResponseDate,
    })
    .from(rfqTable)
    .where(sql`${rfqTable.status} IN ('SENT','QUOTED')`);
  const closeDates = await db
    .select({ rfqId: sentLogTable.rfqId, closeDate: sentLogTable.closeDate })
    .from(sentLogTable);
  const latestCloseByRfq = new Map<number, Date>();
  for (const row of closeDates) {
    const deadline = parsePricingDeadline(row.closeDate);
    if (!deadline) continue;
    const previous = latestCloseByRfq.get(row.rfqId);
    if (!previous || deadline > previous) latestCloseByRfq.set(row.rfqId, deadline);
  }
  const openRfqsCount = openCandidates.filter((rfq) => {
    const sentDeadline = latestCloseByRfq.get(rfq.id);
    const deadline =
      sentDeadline ??
      parsePricingDeadline(rfq.expiresAt) ??
      parsePricingDeadline(rfq.requiredResponseDate);
    return deadline !== null && deadline >= dashboardNow;
  }).length;
  const openRfqs = { cnt: openRfqsCount };
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

  let itemCountRows: Array<{ rfqId: number; cnt: number }> = [];
  let supplierCountRows: Array<{ rfqId: number; cnt: number }> = [];
  let offerCountRows: Array<{ rfqId: number; cnt: number }> = [];
  if (recentRfqIds.length > 0) {
    [itemCountRows, supplierCountRows, offerCountRows] = await Promise.all([
      db
        .select({ rfqId: rfqItemsTable.rfqId, cnt: count() })
        .from(rfqItemsTable)
        .where(sql`${rfqItemsTable.rfqId} = ANY(ARRAY[${sql.raw(recentRfqIds.join(","))}]::int[])`)
        .groupBy(rfqItemsTable.rfqId),
      db
        .select({ rfqId: sentLogTable.rfqId, cnt: countDistinct(sentLogTable.supplierId) })
        .from(sentLogTable)
        .where(sql`${sentLogTable.rfqId} = ANY(ARRAY[${sql.raw(recentRfqIds.join(","))}]::int[])`)
        .groupBy(sentLogTable.rfqId),
      db
        .select({ rfqId: offersTable.rfqId, cnt: count() })
        .from(offersTable)
        .where(sql`${offersTable.rfqId} = ANY(ARRAY[${sql.raw(recentRfqIds.join(","))}]::int[])`)
        .groupBy(offersTable.rfqId),
    ]);
  }

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
    supplierCount: supplierCountRows.find((sc) => sc.rfqId === r.rfq.id)?.cnt ?? 0,
    offerCount: offerCountRows.find((oc) => oc.rfqId === r.rfq.id)?.cnt ?? 0,
    createdAt: r.rfq.createdAt.toISOString(),
    updatedAt: r.rfq.updatedAt.toISOString(),
  }));

  // ── Response rate this month ────────────────────────────────────────────────
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [totalSent] = await db
    .select({ cnt: count() })
    .from(sentLogTable)
    .where(gte(sentLogTable.createdAt, monthStart));
  const [respondedSent] = await db
    .select({ cnt: countDistinct(offersTable.sentLogId) })
    .from(offersTable)
    .innerJoin(sentLogTable, eq(offersTable.sentLogId, sentLogTable.id))
    .where(and(gte(sentLogTable.createdAt, monthStart), isNotNull(offersTable.sentLogId)));
  const responseRate =
    (totalSent?.cnt ?? 0) > 0 ? ((respondedSent?.cnt ?? 0) / (totalSent?.cnt ?? 1)) * 100 : 0;

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

  // Match PO rows back to RFQ items using the identifiers carried through the
  // PO flow. Count distinct RFQ items, not PO rows, so repeated awards or
  // multiple POs cannot inflate the coverage rate.
  const [poItemsRow] = await db
    .select({ cnt: countDistinct(rfqItemsTable.id) })
    .from(rfqItemsTable)
    .innerJoin(
      purchaseOrderItemsTable,
      or(
        and(
          isNotNull(rfqItemsTable.itemId),
          isNotNull(purchaseOrderItemsTable.itemId),
          eq(rfqItemsTable.itemId, purchaseOrderItemsTable.itemId),
        ),
        and(
          isNotNull(rfqItemsTable.partNo),
          isNotNull(purchaseOrderItemsTable.partNo),
          eq(rfqItemsTable.partNo, purchaseOrderItemsTable.partNo),
        ),
        and(
          isNotNull(rfqItemsTable.lineItem),
          isNotNull(purchaseOrderItemsTable.lineItem),
          eq(rfqItemsTable.lineItem, purchaseOrderItemsTable.lineItem),
        ),
      ),
    );
  const itemsWithPo = poItemsRow?.cnt ?? 0;

  const pricingRate = totalItems > 0 ? Math.round((pricedItems / totalItems) * 1000) / 10 : 0;
  const poRate = totalItems > 0 ? Math.round((itemsWithPo / totalItems) * 1000) / 10 : 0;

  // ── RFQ → PO conversion ────────────────────────────────────────────────────
  const [rfqsWithPoRow] = await db
    .select({ cnt: countDistinct(purchaseOrdersTable.rfqId) })
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
        .select({ cnt: countDistinct(offersTable.sentLogId) })
        .from(offersTable)
        .where(and(eq(offersTable.supplierId, s.id), isNotNull(offersTable.sentLogId)));
      const totalOffersSubmitted = offerCount?.cnt ?? 0;

      const [respondedSentToSupplier] = await db
        .select({ cnt: countDistinct(offersTable.sentLogId) })
        .from(offersTable)
        .innerJoin(sentLogTable, eq(offersTable.sentLogId, sentLogTable.id))
        .where(and(eq(offersTable.supplierId, s.id), isNotNull(offersTable.sentLogId)));
      const responseRateSupplier =
        totalSentToSupplier > 0
          ? Math.round(((respondedSentToSupplier?.cnt ?? 0) / totalSentToSupplier) * 1000) / 10
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

  // Legacy topSuppliers field (scorecard format) — only metrics with real data;
  // unavailable ones are null instead of the old hardcoded 70/75/80/20-offset.
  const topSuppliers = topSuppliersSorted.map((s) => {
    const parts = [
      { score: s.responseRate != null ? Math.min(100, s.responseRate) : null, w: 0.4 },
      { score: s.poWinRate != null ? s.poWinRate : null, w: 0.4 },
    ];
    const avail = parts.filter((p) => p.score !== null) as { score: number; w: number }[];
    const wSum = avail.reduce((a, p) => a + p.w, 0);
    const totalScore =
      wSum > 0 ? Math.round(avail.reduce((a, p) => a + p.score * p.w, 0) / wSum) : null;
    return {
      supplierId: s.supplierId,
      supplierName: s.supplierName,
      totalScore,
      onTimeScore: null,
      priceScore: null,
      responseRateScore: s.responseRate != null ? Math.round(s.responseRate) : null,
      qualityScore: s.poWinRate != null ? Math.round(s.poWinRate) : null,
      totalRfqsReceived: s.totalRfqsReceived,
      totalOffersSubmitted: s.totalOffersSubmitted,
      responseRate: s.responseRate,
      avgPriceDelta: null,
    };
  });

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

// ═══════════════════════════════════════════════════════════════════════════
// GET /analytics/overview — comprehensive project-wide snapshot
//
// A single aggregated response powering the full analytics dashboard. Covers
// every module: counts, rates, status distributions, financials (margins/VAT/
// withholding/AP-AR/cash-bank), operating expenses, collections alerts, monthly
// trend, top suppliers, and recent activity (audit log). Computed on each call
// (never stored) so the dashboard always reflects live data.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/analytics/overview", requireAuth, async (_req, res): Promise<void> => {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // ── Entity counts (batched) ──────────────────────────────────────────────
  const [
    totalRfqsRows,
    totalSuppliersRows,
    totalOffersRows,
    totalPosRows,
    totalItemsRows,
    totalCustomerRfqsRows,
    totalCustomerPosRows,
    totalCustomersRows,
    totalRepsRows,
    totalEmployeesRows,
    totalWhatsappChatsRows,
    totalAuditRows,
    totalJournalRows,
    totalSupplierInvoicesRows,
    totalSalesInvoicesRows,
  ] = await Promise.all([
    db.select({ cnt: count() }).from(rfqTable),
    db.select({ cnt: count() }).from(suppliersTable).where(eq(suppliersTable.isActive, true)),
    db.select({ cnt: count() }).from(offersTable),
    db.select({ cnt: count() }).from(purchaseOrdersTable),
    db.select({ cnt: count() }).from(rfqItemsTable),
    db.select({ cnt: count() }).from(customerRfqsTable),
    db.select({ cnt: count() }).from(customerPosTable),
    db.select({ cnt: count() }).from(customersTable).where(eq(customersTable.isActive, true)),
    db.select({ cnt: count() }).from(representativesTable).where(eq(representativesTable.isActive, true)),
    db.select({ cnt: count() }).from(employeesTable).where(eq(employeesTable.isActive, true)),
    db.select({ cnt: countDistinct(whatsappChatsTable.phone) }).from(whatsappChatsTable),
    db.select({ cnt: count() }).from(auditLogTable),
    db.select({ cnt: count() }).from(journalEntriesTable),
    db.select({ cnt: count() }).from(supplierInvoicesTable),
    db.select({ cnt: count() }).from(salesInvoicesTable),
  ]);

  // ── Open RFQs (pricing deadline not passed) ──────────────────────────────
  const openCandidates = await db
    .select({ id: rfqTable.id, status: rfqTable.status, expiresAt: rfqTable.expiresAt, requiredResponseDate: rfqTable.requiredResponseDate })
    .from(rfqTable)
    .where(sql`${rfqTable.status} IN ('SENT','QUOTED')`);
  const closeDates = await db.select({ rfqId: sentLogTable.rfqId, closeDate: sentLogTable.closeDate }).from(sentLogTable);
  const latestCloseByRfq = new Map<number, Date>();
  for (const row of closeDates) {
    const deadline = parsePricingDeadline(row.closeDate);
    if (!deadline) continue;
    const previous = latestCloseByRfq.get(row.rfqId);
    if (!previous || deadline > previous) latestCloseByRfq.set(row.rfqId, deadline);
  }
  const openRfqsCount = openCandidates.filter((rfq) => {
    const sentDeadline = latestCloseByRfq.get(rfq.id);
    const deadline = sentDeadline ?? parsePricingDeadline(rfq.expiresAt) ?? parsePricingDeadline(rfq.requiredResponseDate);
    return deadline !== null && deadline >= now;
  }).length;

  // ── Item pricing analytics ───────────────────────────────────────────────
  const pricedItemsRows = await db.selectDistinct({ rfqItemId: offerItemsTable.rfqItemId }).from(offerItemsTable);
  const pricedItems = pricedItemsRows.length;
  const totalItems = totalItemsRows[0]?.cnt ?? 0;
  const unpricedItems = Math.max(0, totalItems - pricedItems);
  const [poItemsRow] = await db
    .select({ cnt: countDistinct(rfqItemsTable.id) })
    .from(rfqItemsTable)
    .innerJoin(purchaseOrderItemsTable, or(
      and(isNotNull(rfqItemsTable.itemId), isNotNull(purchaseOrderItemsTable.itemId), eq(rfqItemsTable.itemId, purchaseOrderItemsTable.itemId)),
      and(isNotNull(rfqItemsTable.partNo), isNotNull(purchaseOrderItemsTable.partNo), eq(rfqItemsTable.partNo, purchaseOrderItemsTable.partNo)),
      and(isNotNull(rfqItemsTable.lineItem), isNotNull(purchaseOrderItemsTable.lineItem), eq(rfqItemsTable.lineItem, purchaseOrderItemsTable.lineItem)),
    ));
  const itemsWithPo = poItemsRow?.cnt ?? 0;
  const pricingRate = totalItems > 0 ? Math.round((pricedItems / totalItems) * 1000) / 10 : 0;
  const poRate = totalItems > 0 ? Math.round((itemsWithPo / totalItems) * 1000) / 10 : 0;

  // ── RFQ → PO conversion ──────────────────────────────────────────────────
  const [rfqsWithPoRow] = await db.select({ cnt: countDistinct(purchaseOrdersTable.rfqId) }).from(purchaseOrdersTable).where(isNotNull(purchaseOrdersTable.rfqId));
  const totalRfqsCount = totalRfqsRows[0]?.cnt ?? 0;
  const rfqsWithPo = rfqsWithPoRow?.cnt ?? 0;
  const rfqToPoRate = totalRfqsCount > 0 ? Math.round((rfqsWithPo / totalRfqsCount) * 1000) / 10 : 0;

  // ── Response rate this month ─────────────────────────────────────────────
  const [totalSentMonth] = await db.select({ cnt: count() }).from(sentLogTable).where(gte(sentLogTable.createdAt, monthStart));
  const [respondedSentMonth] = await db.select({ cnt: countDistinct(offersTable.sentLogId) }).from(offersTable).innerJoin(sentLogTable, eq(offersTable.sentLogId, sentLogTable.id)).where(and(gte(sentLogTable.createdAt, monthStart), isNotNull(offersTable.sentLogId)));
  const responseRateThisMonth = (totalSentMonth?.cnt ?? 0) > 0 ? Math.round(((respondedSentMonth?.cnt ?? 0) / (totalSentMonth?.cnt ?? 1)) * 100) : 0;

  // ── Avg response time ────────────────────────────────────────────────────
  const avgResponseTimeResult = await db.select({ avgHours: sql<string | null>`avg(extract(epoch from (${offersTable.createdAt} - ${sentLogTable.createdAt})) / 3600)` }).from(offersTable).innerJoin(sentLogTable, eq(offersTable.sentLogId, sentLogTable.id));
  const avgResponseTimeHours = avgResponseTimeResult[0]?.avgHours ? Math.round(parseFloat(avgResponseTimeResult[0].avgHours)) : null;

  // ── Status distributions ─────────────────────────────────────────────────
  const rfqsByStatus = await db.select({ status: rfqTable.status, count: count() }).from(rfqTable).groupBy(rfqTable.status);
  const customerRfqsByStatus = await db.select({ status: customerRfqsTable.status, count: count() }).from(customerRfqsTable).groupBy(customerRfqsTable.status);
  const customerPosByStatus = await db.select({ status: customerPosTable.status, count: count() }).from(customerPosTable).groupBy(customerPosTable.status);
  const posByStatus = await db.select({ status: purchaseOrdersTable.status, count: count() }).from(purchaseOrdersTable).groupBy(purchaseOrdersTable.status);

  // ── PO receipt progress (batched) ────────────────────────────────────────
  // Cancelled POs are excluded — their lines were reset to "pending" on cancel
  // and should not count toward the company's receipt progress.
  const poProgressRows = await db
    .select({ poId: purchaseOrderItemsTable.poId, lineStatus: purchaseOrderItemsTable.lineStatus })
    .from(purchaseOrderItemsTable)
    .innerJoin(purchaseOrdersTable, eq(purchaseOrderItemsTable.poId, purchaseOrdersTable.id))
    .where(ne(purchaseOrdersTable.status, "cancelled"));
  const poProgressMap = new Map<number, { total: number; received: number; rejected: number }>();
  for (const r of poProgressRows) {
    const e = poProgressMap.get(r.poId) ?? { total: 0, received: 0, rejected: 0 };
    // Cancelled supplier lines are excluded — they're neither pending nor a
    // receipt outcome and must not inflate the company totals.
    if (r.lineStatus === "cancelled") continue;
    e.total++;
    if (r.lineStatus === "fulfilled") e.received++;
    else if (r.lineStatus === "rejected") e.rejected++;
    poProgressMap.set(r.poId, e);
  }
  const poReceiptTotals = Array.from(poProgressMap.values()).reduce(
    (acc, v) => ({ total: acc.total + v.total, received: acc.received + v.received, rejected: acc.rejected + v.rejected }),
    { total: 0, received: 0, rejected: 0 },
  );

  // ── Customer PO delivery progress ────────────────────────────────────────
  const cpoDeliveryRows = await db.select({ deliveryStatus: customerPoItemsTable.deliveryStatus }).from(customerPoItemsTable);
  const cpoDeliverySummary = { total: cpoDeliveryRows.length, delivered: 0, rejected: 0, pending: 0 };
  for (const r of cpoDeliveryRows) {
    if (r.deliveryStatus === "delivered") cpoDeliverySummary.delivered++;
    else if (r.deliveryStatus === "rejected") cpoDeliverySummary.rejected++;
    else cpoDeliverySummary.pending++;
  }

  // ── Margins summary ──────────────────────────────────────────────────────
  const marginRows = await db
    .select({ sellQty: customerPoItemsTable.qty, sellUnitPrice: customerPoItemsTable.unitPrice, acceptedQty: purchaseOrderItemsTable.totalAcceptedQty, finalActualCost: purchaseOrderItemsTable.finalActualCost })
    .from(customerPoItemsTable)
    .innerJoin(customerPosTable, eq(customerPoItemsTable.customerPoId, customerPosTable.id))
    .leftJoin(purchaseOrderItemsTable, eq(purchaseOrderItemsTable.customerPoItemId, customerPoItemsTable.id));
  let totalRevenue = 0, totalCost = 0, lossLines = 0, marginLineCount = 0, pricedLines = 0;
  for (const r of marginRows) {
    const sellQty = toNum(r.sellQty);
    const sellUnit = toNum(r.sellUnitPrice);
    const accepted = toNum(r.acceptedQty);
    const actualCost = toNum(r.finalActualCost);
    const revenue = sellQty != null && sellUnit != null ? sellQty * sellUnit : 0;
    const cost = accepted != null && actualCost != null ? accepted * actualCost : 0;
    if (cost > 0) pricedLines++;
    totalRevenue += revenue;
    totalCost += cost;
    if (revenue > 0 && cost > 0 && revenue - cost < 0) lossLines++;
    marginLineCount++;
  }
  const totalMargin = totalRevenue - totalCost;
  const marginPct = totalRevenue !== 0 ? (totalMargin / totalRevenue) * 100 : 0;

  // ── VAT (from posted invoices) ───────────────────────────────────────────
  const settings = await loadTaxSettings();
  const sellInvoices = await db.select({ netAmount: salesInvoicesTable.netAmount, vatAmount: salesInvoicesTable.vatAmount, status: salesInvoicesTable.status }).from(salesInvoicesTable).where(eq(salesInvoicesTable.status, "posted"));
  const buyInvoices = await db.select({ netAmount: supplierInvoicesTable.netAmount, vatAmount: supplierInvoicesTable.vatAmount, status: supplierInvoicesTable.status }).from(supplierInvoicesTable).where(eq(supplierInvoicesTable.status, "posted"));
  let outputVat = 0, inputVat = 0, outputNet = 0, inputNet = 0;
  for (const r of sellInvoices) { outputNet += toNum(r.netAmount) ?? 0; outputVat += toNum(r.vatAmount) ?? 0; }
  for (const r of buyInvoices) { inputNet += toNum(r.netAmount) ?? 0; inputVat += toNum(r.vatAmount) ?? 0; }
  const netVat = round2(outputVat - inputVat);

  // ── Withholding (from posted supplier invoices) ──────────────────────────
  const whInvoices = await db.select({ netAmount: supplierInvoicesTable.netAmount, withholdingAmount: supplierInvoicesTable.withholdingAmount }).from(supplierInvoicesTable).where(eq(supplierInvoicesTable.status, "posted"));
  let totalWithholdingNet = 0, totalWithholding = 0;
  for (const r of whInvoices) { totalWithholdingNet += toNum(r.netAmount) ?? 0; totalWithholding += toNum(r.withholdingAmount) ?? 0; }

  // ── Accounts dashboard (AP/AR/cash/bank) ─────────────────────────────────
  const apRows = await db.select({ balance: supplierInvoicesTable.balance, status: supplierInvoicesTable.status }).from(supplierInvoicesTable);
  const arRows = await db.select({ balance: salesInvoicesTable.balance, status: salesInvoicesTable.status }).from(salesInvoicesTable);
  const totalAP = apRows.filter((r) => r.status === "posted").reduce((s, r) => s + (toNum(r.balance) ?? 0), 0);
  const totalAR = arRows.filter((r) => r.status === "posted").reduce((s, r) => s + (toNum(r.balance) ?? 0), 0);
  const [cashBal, bankBal] = await Promise.all([accountBalance(ACCOUNT_CODES.CASH), accountBalance(ACCOUNT_CODES.BANK)]);
  const draftEntries = await db.select({ id: journalEntriesTable.id }).from(journalEntriesTable).where(eq(journalEntriesTable.status, "draft"));

  // ── Operating expenses summary ───────────────────────────────────────────
  const expenseRows = await db.select({ category: operatingExpensesTable.category, total: sql<number>`sum(${operatingExpensesTable.amount})`, cnt: sql<number>`count(*)` }).from(operatingExpensesTable).groupBy(operatingExpensesTable.category);
  const expensesByCategory = expenseRows.map((r) => ({ category: r.category, total: fmt(toNum(r.total)) ?? 0, count: Number(r.cnt) }));
  const expensesGrandTotal = expensesByCategory.reduce((s, c) => s + (c.total ?? 0), 0);

  // ── Collections alerts ───────────────────────────────────────────────────
  const collectionsRows = await db
    .select({ id: customerPosTable.id, customerName: customerPosTable.customerName, storedName: customersTable.name })
    .from(customerPosTable)
    .leftJoin(customersTable, eq(customerPosTable.customerId, customersTable.id))
    .orderBy(desc(customerPosTable.createdAt));
  // receivable per PO = Σ customer_po_items.qty × unitPrice
  const cpoItemRows = await db.select({ customerPoId: customerPoItemsTable.customerPoId, qty: customerPoItemsTable.qty, unitPrice: customerPoItemsTable.unitPrice }).from(customerPoItemsTable);
  const receivableByPo = new Map<number, number>();
  for (const r of cpoItemRows) {
    if (r.customerPoId == null) continue; // detached (removed) row — no receivable
    const q = toNum(r.qty) ?? 0;
    const p = toNum(r.unitPrice) ?? 0;
    receivableByPo.set(r.customerPoId, (receivableByPo.get(r.customerPoId) ?? 0) + q * p);
  }
  const paymentRows = await db.select({ customerPoId: customerPoPaymentsTable.customerPoId, amount: customerPoPaymentsTable.amount }).from(customerPoPaymentsTable);
  const collectedByPo = new Map<number, number>();
  for (const r of paymentRows) collectedByPo.set(r.customerPoId, (collectedByPo.get(r.customerPoId) ?? 0) + (toNum(r.amount) ?? 0));
  let totalReceivable = 0, totalCollected = 0, dueSoonCount = 0, overdueCount = 0;
  for (const p of collectionsRows) {
    const receivable = receivableByPo.get(p.id) ?? 0;
    const collected = collectedByPo.get(p.id) ?? 0;
    totalReceivable += receivable;
    totalCollected += collected;
    if (receivable > 0 && collected < receivable) {
      // Without terms/dueDate here we can't precisely classify due-soon/overdue;
      // approximate: uncollected receivable > 0 counts as outstanding.
      dueSoonCount++;
    }
  }

  // ── Monthly trend (last 12 months) ───────────────────────────────────────
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(now.getMonth() - 12);
  const rfqTrendRows = await db.select({ createdAt: rfqTable.createdAt }).from(rfqTable).where(gte(rfqTable.createdAt, twelveMonthsAgo));
  const poTrendRows = await db.select({ createdAt: purchaseOrdersTable.createdAt }).from(purchaseOrdersTable).where(gte(purchaseOrdersTable.createdAt, twelveMonthsAgo));
  const cRfqTrendRows = await db.select({ createdAt: customerRfqsTable.createdAt }).from(customerRfqsTable).where(gte(customerRfqsTable.createdAt, twelveMonthsAgo));
  const monthlyMap = new Map<string, { rfqs: number; pos: number; customerRfqs: number }>();
  const addMonth = (map: Map<string, { rfqs: number; pos: number; customerRfqs: number }>, date: Date, key: "rfqs" | "pos" | "customerRfqs") => {
    const m = date.toISOString().substring(0, 7);
    const e = map.get(m) ?? { rfqs: 0, pos: 0, customerRfqs: 0 };
    e[key]++;
    map.set(m, e);
  };
  for (const r of rfqTrendRows) addMonth(monthlyMap, r.createdAt, "rfqs");
  for (const r of poTrendRows) addMonth(monthlyMap, r.createdAt, "pos");
  for (const r of cRfqTrendRows) addMonth(monthlyMap, r.createdAt, "customerRfqs");
  const monthlyTrend = Array.from(monthlyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, ...v }));

  // ── Top suppliers (deep stats, top 8) ────────────────────────────────────
  const allSuppliers = await db.select().from(suppliersTable).where(eq(suppliersTable.isActive, true));
  const supplierDeepStats = await Promise.all(
    allSuppliers.map(async (s) => {
      const [sentStats] = await db.select({ total: count() }).from(sentLogTable).where(eq(sentLogTable.supplierId, s.id));
      const totalSentToSupplier = sentStats?.total ?? 0;
      const [offerCount] = await db.select({ cnt: countDistinct(offersTable.sentLogId) }).from(offersTable).where(and(eq(offersTable.supplierId, s.id), isNotNull(offersTable.sentLogId)));
      const totalOffersSubmitted = offerCount?.cnt ?? 0;
      const [poWinRow] = await db.select({ cnt: count() }).from(purchaseOrderItemsTable).where(eq(purchaseOrderItemsTable.supplierId, s.id));
      const totalPoItems = poWinRow?.cnt ?? 0;
      const [avgPriceRow] = await db.select({ avg: sql<string | null>`avg(${offerItemsTable.price}::numeric)` }).from(offerItemsTable).leftJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id)).where(eq(offersTable.supplierId, s.id));
      const avgPrice = avgPriceRow?.avg ? parseFloat(avgPriceRow.avg) : null;
      const responseRate = totalSentToSupplier > 0 ? Math.round((totalOffersSubmitted / totalSentToSupplier) * 1000) / 10 : 0;
      return { supplierId: s.id, supplierName: s.name, category: s.category, totalRfqsReceived: totalSentToSupplier, totalOffersSubmitted, responseRate, totalPoItems, avgPrice };
    }),
  );
  const topSuppliers = supplierDeepStats.sort((a, b) => b.totalOffersSubmitted - a.totalOffersSubmitted).slice(0, 8);

  // ── Recent activity (audit log, last 10) ─────────────────────────────────
  const recentAudit = await db
    .select({ log: auditLogTable, employeeName: employeesTable.name })
    .from(auditLogTable)
    .leftJoin(employeesTable, eq(auditLogTable.employeeId, employeesTable.id))
    .orderBy(desc(auditLogTable.createdAt))
    .limit(10);

  // ── Financial statements snapshot ────────────────────────────────────────
  const coaRows = await db.select().from(chartOfAccountsTable);
  let netProfit = 0, totalAssets = 0, totalLiabilities = 0, totalEquity = 0;
  for (const a of coaRows) {
    if (!a.isActive) continue;
    const bal = await accountBalance(a.code);
    if (a.type === "revenue") netProfit += Math.abs(bal.balance);
    else if (a.type === "expense") netProfit -= bal.balance;
    else if (a.type === "asset") totalAssets += bal.balance;
    else if (a.type === "liability") totalLiabilities += Math.abs(bal.balance);
    else if (a.type === "equity") totalEquity += Math.abs(bal.balance);
  }

  res.json({
    counts: {
      rfqs: totalRfqsCount,
      openRfqs: openRfqsCount,
      suppliers: totalSuppliersRows[0]?.cnt ?? 0,
      offers: totalOffersRows[0]?.cnt ?? 0,
      pos: totalPosRows[0]?.cnt ?? 0,
      items: totalItems,
      customers: totalCustomersRows[0]?.cnt ?? 0,
      customerRfqs: totalCustomerRfqsRows[0]?.cnt ?? 0,
      customerPos: totalCustomerPosRows[0]?.cnt ?? 0,
      representatives: totalRepsRows[0]?.cnt ?? 0,
      employees: totalEmployeesRows[0]?.cnt ?? 0,
      whatsappChats: totalWhatsappChatsRows[0]?.cnt ?? 0,
      auditEntries: totalAuditRows[0]?.cnt ?? 0,
      journalEntries: totalJournalRows[0]?.cnt ?? 0,
      supplierInvoices: totalSupplierInvoicesRows[0]?.cnt ?? 0,
      salesInvoices: totalSalesInvoicesRows[0]?.cnt ?? 0,
    },
    rates: {
      pricingRate,
      poRate,
      rfqToPoRate,
      responseRateThisMonth,
      avgResponseTimeHours,
    },
    itemAnalytics: { totalItems, pricedItems, unpricedItems, itemsWithPo },
    distributions: {
      rfqsByStatus: rfqsByStatus.map((r) => ({ status: r.status, count: r.count })),
      customerRfqsByStatus: customerRfqsByStatus.map((r) => ({ status: r.status, count: r.count })),
      customerPosByStatus: customerPosByStatus.map((r) => ({ status: r.status, count: r.count })),
      posByStatus: posByStatus.map((r) => ({ status: r.status, count: r.count })),
    },
    operations: {
      poReceipt: poReceiptTotals,
      customerPoDelivery: cpoDeliverySummary,
    },
    financials: {
      margins: {
        totalRevenue: fmt(totalRevenue),
        totalCost: fmt(totalCost),
        totalMargin: fmt(totalMargin),
        marginPct: fmt(marginPct),
        lossLines,
        lineCount: marginLineCount,
        pricedLines,
      },
      vat: {
        vatRate: settings.vatRate,
        output: { net: fmt(outputNet), vat: fmt(outputVat) },
        input: { net: fmt(inputNet), vat: fmt(inputVat) },
        netVat,
        payable: netVat > 0 ? netVat : 0,
        credit: netVat < 0 ? Math.abs(netVat) : 0,
      },
      withholding: {
        rate: settings.withholdingRate,
        totalNet: fmt(totalWithholdingNet),
        totalWithholding: fmt(totalWithholding),
        totalPayable: fmt(totalWithholdingNet - totalWithholding),
      },
      accounts: {
        totalAP: fmt(totalAP),
        totalAR: fmt(totalAR),
        cash: fmt(cashBal.balance),
        bank: fmt(bankBal.balance),
        pendingDrafts: draftEntries.length,
      },
      expenses: {
        grandTotal: fmt(expensesGrandTotal),
        byCategory: expensesByCategory,
      },
      collections: {
        totalReceivable: fmt(totalReceivable),
        totalCollected: fmt(totalCollected),
        outstandingCount: dueSoonCount,
        overdueCount,
        dueSoonCount,
      },
      statements: {
        netProfit: fmt(netProfit),
        totalAssets: fmt(totalAssets),
        totalLiabilities: fmt(totalLiabilities),
        totalEquity: fmt(totalEquity),
      },
    },
    monthlyTrend,
    topSuppliers,
    recentActivity: recentAudit.map((r) => ({
      id: r.log.id,
      action: r.log.action,
      description: r.log.description,
      employeeName: r.employeeName,
      createdAt: r.log.createdAt.toISOString(),
    })),
  });
});
export default router;

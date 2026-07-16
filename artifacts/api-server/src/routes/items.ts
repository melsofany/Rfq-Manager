import { Router } from "express";
import {
  db,
  rfqItemsTable,
  rfqTable,
  employeesTable,
  sentLogTable,
  suppliersTable,
  offersTable,
  offerItemsTable,
} from "@workspace/db";
import { eq, ilike, or, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();

// GET /items/search?q=...
// Search rfq_items by description, part_no, or line_item and return full history
router.get("/items/search", requireAuth, async (req, res): Promise<void> => {
  const q = (req.query.q as string | undefined)?.trim() ?? "";

  if (!q || q.length < 2) {
    res.json([]);
    return;
  }

  const pattern = `%${q}%`;

  // 1. Find matching rfq_items with their parent RFQ and employee
  const matchingItems = await db
    .select({
      item: rfqItemsTable,
      rfq: rfqTable,
      employeeName: employeesTable.name,
    })
    .from(rfqItemsTable)
    .innerJoin(rfqTable, eq(rfqItemsTable.rfqId, rfqTable.id))
    .leftJoin(employeesTable, eq(rfqTable.employeeId, employeesTable.id))
    .where(
      or(
        ilike(rfqItemsTable.description, pattern),
        ilike(sql`COALESCE(${rfqItemsTable.partNo}, '')`, pattern),
        ilike(sql`COALESCE(${rfqItemsTable.lineItem}, '')`, pattern),
      ),
    )
    .orderBy(sql`${rfqTable.createdAt} DESC`);

  if (matchingItems.length === 0) {
    res.json([]);
    return;
  }

  // Collect unique rfq ids and rfq_item ids
  const rfqIds = [...new Set(matchingItems.map((r) => r.rfq.id))];
  const rfqItemIds = matchingItems.map((r) => r.item.id);

  // 2. Get sent_log (all suppliers sent this RFQ) with supplier names
  const sentLogs = rfqIds.length > 0
    ? await db
        .select({
          sentLog: sentLogTable,
          supplierName: suppliersTable.name,
        })
        .from(sentLogTable)
        .innerJoin(suppliersTable, eq(sentLogTable.supplierId, suppliersTable.id))
        .where(inArray(sentLogTable.rfqId, rfqIds))
    : [];

  // 3. Get offer_items with their parent offer (supplier + date)
  const offerItems = rfqItemIds.length > 0
    ? await db
        .select({
          offerItem: offerItemsTable,
          offer: offersTable,
          supplierName: suppliersTable.name,
        })
        .from(offerItemsTable)
        .innerJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
        .innerJoin(suppliersTable, eq(offersTable.supplierId, suppliersTable.id))
        .where(inArray(offerItemsTable.rfqItemId, rfqItemIds))
    : [];

  // Build lookup maps
  // sentLogByRfqId: rfqId -> sentLog[]
  const sentLogByRfqId = new Map<number, typeof sentLogs>();
  for (const sl of sentLogs) {
    const list = sentLogByRfqId.get(sl.sentLog.rfqId) ?? [];
    list.push(sl);
    sentLogByRfqId.set(sl.sentLog.rfqId, list);
  }

  // offerItemsByRfqItemId: rfqItemId -> offerItems[]
  const offerItemsByRfqItemId = new Map<number, typeof offerItems>();
  for (const oi of offerItems) {
    const list = offerItemsByRfqItemId.get(oi.offerItem.rfqItemId) ?? [];
    list.push(oi);
    offerItemsByRfqItemId.set(oi.offerItem.rfqItemId, list);
  }

  // 4. Assemble results
  const results = matchingItems.map((r) => {
    const rfqId = r.rfq.id;
    const rfqItemId = r.item.id;

    // All suppliers sent this RFQ
    const sent = sentLogByRfqId.get(rfqId) ?? [];
    const responded = sent.filter((s) => s.sentLog.offerSubmitted);
    const notResponded = sent.filter((s) => !s.sentLog.offerSubmitted);

    // Offer prices for this specific item
    const itemOffers = offerItemsByRfqItemId.get(rfqItemId) ?? [];

    // Price analysis
    const prices = itemOffers
      .map((oi) => (oi.offerItem.price != null ? parseFloat(oi.offerItem.price) : null))
      .filter((p): p is number => p !== null);

    const minPrice = prices.length > 0 ? Math.min(...prices) : null;
    const maxPrice = prices.length > 0 ? Math.max(...prices) : null;
    const avgPrice =
      prices.length > 0
        ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100
        : null;

    // Build per-supplier response list
    const supplierResponseMap = new Map<
      number,
      {
        supplierId: number;
        supplierName: string;
        responded: boolean;
        offerSubmitted: boolean;
        price: number | null;
        taxIncluded: boolean;
        deliveryDays: number | null;
        notes: string | null;
        offerDate: string | null;
        linkOpened: boolean;
      }
    >();

    // Start with all sent suppliers (not responded)
    for (const sl of sent) {
      supplierResponseMap.set(sl.sentLog.supplierId, {
        supplierId: sl.sentLog.supplierId,
        supplierName: sl.supplierName ?? "",
        responded: sl.sentLog.offerSubmitted ?? false,
        offerSubmitted: sl.sentLog.offerSubmitted ?? false,
        price: null,
        taxIncluded: false,
        deliveryDays: null,
        notes: null,
        offerDate: null,
        linkOpened: sl.sentLog.linkOpened ?? false,
      });
    }

    // Overlay with offer item details
    for (const oi of itemOffers) {
      const existing = supplierResponseMap.get(oi.offer.supplierId);
      if (existing) {
        existing.price = oi.offerItem.price != null ? parseFloat(oi.offerItem.price) : null;
        existing.taxIncluded = oi.offerItem.taxIncluded ?? false;
        existing.deliveryDays = oi.offerItem.deliveryDays ?? null;
        existing.notes = oi.offerItem.notes ?? null;
        existing.offerDate = oi.offer.createdAt?.toISOString() ?? null;
      } else {
        // Offer from supplier not in sent_log (edge case)
        supplierResponseMap.set(oi.offer.supplierId, {
          supplierId: oi.offer.supplierId,
          supplierName: oi.supplierName ?? "",
          responded: true,
          offerSubmitted: true,
          price: oi.offerItem.price != null ? parseFloat(oi.offerItem.price) : null,
          taxIncluded: oi.offerItem.taxIncluded ?? false,
          deliveryDays: oi.offerItem.deliveryDays ?? null,
          notes: oi.offerItem.notes ?? null,
          offerDate: oi.offer.createdAt?.toISOString() ?? null,
          linkOpened: false,
        });
      }
    }

    const suppliers = [...supplierResponseMap.values()].sort((a, b) =>
      a.supplierName.localeCompare(b.supplierName),
    );

    return {
      rfqItemId,
      lineItem: r.item.lineItem ?? null,
      partNo: r.item.partNo ?? null,
      description: r.item.description,
      uom: r.item.uom ?? null,
      qty: r.item.qty != null ? parseFloat(r.item.qty) : null,
      referencePrice: r.item.referencePrice != null ? parseFloat(r.item.referencePrice) : null,
      rfqId,
      internalRfqNo: r.rfq.internalRfqNo,
      customerRfqNo: r.rfq.customerRfqNo,
      rfqStatus: r.rfq.status,
      rfqDate: r.rfq.createdAt.toISOString(),
      rfqResponseDate: r.rfq.requiredResponseDate ?? null,
      employeeName: r.employeeName ?? null,
      sentCount: sent.length,
      respondedCount: responded.length,
      notRespondedCount: notResponded.length,
      minPrice,
      maxPrice,
      avgPrice,
      suppliers,
    };
  });

  res.json(results);
});

export default router;

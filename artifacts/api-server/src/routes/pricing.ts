import { Router } from "express";
import { db, sentLogTable, rfqTable, rfqItemsTable, suppliersTable, offersTable, offerItemsTable, auditLogTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";

const router = Router();

router.get("/pricing/:token", async (req, res): Promise<void> => {
  const { token } = req.params;

  const [log] = await db.select({
    log: sentLogTable,
    rfq: rfqTable,
    supplier: suppliersTable,
  }).from(sentLogTable)
    .leftJoin(rfqTable, eq(sentLogTable.rfqId, rfqTable.id))
    .leftJoin(suppliersTable, eq(sentLogTable.supplierId, suppliersTable.id))
    .where(eq(sentLogTable.token, token));

  if (!log || !log.rfq) {
    res.status(404).json({ error: "Token not found or expired" });
    return;
  }

  const now = new Date();
  const isExpired =
    (log.rfq.expiresAt != null && log.rfq.expiresAt < now) ||
    (log.log.closeDate != null && new Date(log.log.closeDate) < now);
  const items = await db.select().from(rfqItemsTable).where(eq(rfqItemsTable.rfqId, log.rfq.id));

  // Check if already submitted
  const [existingOffer] = await db.select().from(offersTable)
    .where(and(eq(offersTable.rfqId, log.rfq.id), eq(offersTable.supplierId, log.log.supplierId)));

  let existingOfferOut = undefined;
  if (existingOffer) {
    const offerItems = await db.select({ item: offerItemsTable, rfqItem: rfqItemsTable })
      .from(offerItemsTable)
      .leftJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
      .where(eq(offerItemsTable.offerId, existingOffer.id));

    existingOfferOut = {
      id: existingOffer.id,
      rfqId: existingOffer.rfqId,
      supplierId: existingOffer.supplierId,
      supplierName: log.supplier?.name ?? null,
      sentLogId: existingOffer.sentLogId,
      employeeId: existingOffer.employeeId,
      totalPrice: existingOffer.totalPrice ? parseFloat(existingOffer.totalPrice) : null,
      generalNotes: existingOffer.generalNotes,
      createdAt: existingOffer.createdAt.toISOString(),
      items: offerItems.map(oi => ({
        id: oi.item.id, offerId: oi.item.offerId, rfqItemId: oi.item.rfqItemId,
        partNo: oi.rfqItem?.partNo ?? null, description: oi.rfqItem?.description ?? null,
        qty: oi.rfqItem?.qty ? parseFloat(oi.rfqItem.qty) : null,
        uom: oi.rfqItem?.uom ?? null,
        price: parseFloat(oi.item.price), taxIncluded: oi.item.taxIncluded,
        deliveryDays: oi.item.deliveryDays, notes: oi.item.notes,
      })),
    };
  }

  res.json({
    rfqNo: log.rfq.internalRfqNo,
    supplierName: log.supplier?.name ?? "",
    contactPerson: log.supplier?.contactPerson ?? null,
    items: items.map(i => ({
      id: i.id, rfqId: i.rfqId, itemId: i.itemId, lineItem: i.lineItem,
      partNo: i.partNo, description: i.description, uom: i.uom,
      qty: i.qty ? parseFloat(i.qty) : null,
      referencePrice: i.referencePrice ? parseFloat(i.referencePrice) : null,
    })),
    closeDate: log.log.closeDate || "N/A",
    isExpired,
    alreadySubmitted: !!existingOffer,
    existingOffer: existingOfferOut,
  });
});

router.post("/pricing/:token/track", async (req, res): Promise<void> => {
  const { token } = req.params;
  const [log] = await db.select().from(sentLogTable).where(eq(sentLogTable.token, token));
  if (!log) { res.json({ success: false }); return; }

  const now = new Date();
  await db.update(sentLogTable).set({
    linkOpened: true,
    openCount: log.openCount + 1,
    firstOpenedAt: log.firstOpenedAt || now,
    lastOpenedAt: now,
  }).where(eq(sentLogTable.token, token));

  res.json({ success: true });
});

router.post("/pricing/:token/submit", async (req, res): Promise<void> => {
  const { token } = req.params;

  const [log] = await db.select({
    log: sentLogTable,
    rfq: rfqTable,
  }).from(sentLogTable)
    .leftJoin(rfqTable, eq(sentLogTable.rfqId, rfqTable.id))
    .where(eq(sentLogTable.token, token));

  if (!log || !log.rfq) {
    res.status(404).json({ error: "Token not found" });
    return;
  }

  const now2 = new Date();
  const isExpired =
    (log.rfq.expiresAt != null && log.rfq.expiresAt < now2) ||
    (log.log.closeDate != null && new Date(log.log.closeDate) < now2);
  if (isExpired) {
    res.status(400).json({ error: "This link has expired" });
    return;
  }

  const { items, generalNotes } = req.body as {
    items: Array<{ rfqItemId: number; price: number; taxIncluded?: boolean; deliveryDays?: number; notes?: string }>;
    generalNotes?: string;
  };

  if (!items?.length) {
    res.status(400).json({ error: "Items required" });
    return;
  }

  const totalPrice = items.reduce((sum, i) => sum + (i.price || 0), 0);

  const [offer] = await db.insert(offersTable).values({
    rfqId: log.rfq.id,
    supplierId: log.log.supplierId,
    sentLogId: log.log.id,
    totalPrice: String(totalPrice),
    generalNotes,
  }).returning();

  for (const item of items) {
    await db.insert(offerItemsTable).values({
      offerId: offer.id,
      rfqItemId: item.rfqItemId,
      price: String(item.price),
      taxIncluded: item.taxIncluded ?? false,
      deliveryDays: item.deliveryDays,
      notes: item.notes,
    });
  }

  // Mark offer submitted in sent log
  await db.update(sentLogTable).set({ offerSubmitted: true }).where(eq(sentLogTable.token, token));

  // Audit
  await db.insert(auditLogTable).values({
    action: "offer.submitted",
    entityType: "offer",
    entityId: offer.id,
    description: `Supplier submitted offer for RFQ ${log.rfq.internalRfqNo} via pricing link`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.status(201).json({
    id: offer.id, rfqId: offer.rfqId, supplierId: offer.supplierId,
    supplierName: null, sentLogId: offer.sentLogId, employeeId: offer.employeeId,
    totalPrice: parseFloat(offer.totalPrice!),
    generalNotes: offer.generalNotes, createdAt: offer.createdAt.toISOString(), items: [],
  });
});

export default router;

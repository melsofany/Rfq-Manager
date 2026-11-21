import { Router } from "express";
import {
  db,
  offersTable,
  suppliersTable,
  offerItemsTable,
  rfqItemsTable,
  auditLogTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { guardFor } from "../../shared/permissions";

const router = Router();
router.use("/offers", guardFor("/offers"));

router.get("/offers", requireAuth, async (req, res): Promise<void> => {
  const { rfqId, supplierId } = req.query as Record<string, string>;

  const conditions = [];
  if (rfqId) conditions.push(eq(offersTable.rfqId, parseInt(rfqId, 10)));
  if (supplierId) conditions.push(eq(offersTable.supplierId, parseInt(supplierId, 10)));

  const offers = await db
    .select({ offer: offersTable, supplierName: suppliersTable.name })
    .from(offersTable)
    .leftJoin(suppliersTable, eq(offersTable.supplierId, suppliersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  res.json(
    offers.map((o) => ({
      id: o.offer.id,
      rfqId: o.offer.rfqId,
      supplierId: o.offer.supplierId,
      supplierName: o.supplierName,
      sentLogId: o.offer.sentLogId,
      employeeId: o.offer.employeeId,
      totalPrice: o.offer.totalPrice ? parseFloat(o.offer.totalPrice) : null,
      generalNotes: o.offer.generalNotes,
      createdAt: o.offer.createdAt.toISOString(),
      items: [],
    })),
  );
});

// Approve (endorse) a supplier price for a specific rfq_item.
// Only one offer_item per rfq_item may be approved at a time: approving a new
// one un-approves the previous one for the same rfq_item. The approved price
// is the reference cost used by the customer-rfq margin check.
router.patch("/offers/items/:offerItemId/approve", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.offerItemId)
    ? req.params.offerItemId[0]
    : req.params.offerItemId;
  const offerItemId = parseInt(raw, 10);
  if (!Number.isInteger(offerItemId) || offerItemId <= 0) {
    res.status(400).json({ error: "Invalid offer item id" });
    return;
  }
  const { approved } = req.body as { approved?: boolean };

  const [item] = await db.select().from(offerItemsTable).where(eq(offerItemsTable.id, offerItemId));
  if (!item) {
    res.status(404).json({ error: "Offer item not found" });
    return;
  }

  const target = approved === false ? false : true;

  // A rejected price cannot be endorsed. Un-rejecting first is the only way back.
  if (target && item.rejectedAt != null) {
    res.status(409).json({ error: "هذا العرض مرفوض — ألغِ الرفض أولاً ثم اعتمده" });
    return;
  }

  if (target) {
    // Un-approve any previously approved offer_item for the same rfq_item.
    await db
      .update(offerItemsTable)
      .set({ isApproved: false })
      .where(
        and(eq(offerItemsTable.rfqItemId, item.rfqItemId), eq(offerItemsTable.isApproved, true)),
      );
    await db
      .update(offerItemsTable)
      .set({ isApproved: true })
      .where(eq(offerItemsTable.id, offerItemId));
  } else {
    await db
      .update(offerItemsTable)
      .set({ isApproved: false })
      .where(eq(offerItemsTable.id, offerItemId));
  }

  await db.insert(auditLogTable).values({
    action: "offer_item.approval_toggled",
    entityType: "offer_item",
    entityId: offerItemId,
    employeeId: req.session.employeeId,
    description: `${target ? "Approved" : "Un-approved"} supplier price for rfq_item ${item.rfqItemId}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.json({ id: offerItemId, isApproved: target });
});

// Reject a supplier price for one rfq_item, with the reason. Rejecting also
// withdraws the approval if this price was the approved one, so the margin check
// never keeps using a price the buyer has refused.
router.patch("/offers/items/:offerItemId/reject", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.offerItemId)
    ? req.params.offerItemId[0]
    : req.params.offerItemId;
  const offerItemId = parseInt(raw, 10);
  if (!Number.isInteger(offerItemId) || offerItemId <= 0) {
    res.status(400).json({ error: "Invalid offer item id" });
    return;
  }
  const { rejected, reason } = req.body as { rejected?: boolean; reason?: string | null };

  const [item] = await db.select().from(offerItemsTable).where(eq(offerItemsTable.id, offerItemId));
  if (!item) {
    res.status(404).json({ error: "Offer item not found" });
    return;
  }

  // Rejecting needs a reason the buyer actually wrote, so it can be defended later.
  const trimmed = (reason ?? "").trim();
  const target = rejected !== false;
  if (target && trimmed.length < 3) {
    res.status(400).json({ error: "يجب كتابة سبب الرفض" });
    return;
  }

  if (target) {
    await db
      .update(offerItemsTable)
      .set({
        rejectedAt: new Date(),
        rejectedBy: req.session.employeeId ?? null,
        rejectionReason: trimmed,
        isApproved: false,
      })
      .where(eq(offerItemsTable.id, offerItemId));
  } else {
    await db
      .update(offerItemsTable)
      .set({ rejectedAt: null, rejectedBy: null, rejectionReason: null })
      .where(eq(offerItemsTable.id, offerItemId));
  }

  await db.insert(auditLogTable).values({
    action: "offer_item.rejection_toggled",
    entityType: "offer_item",
    entityId: offerItemId,
    employeeId: req.session.employeeId,
    description: target
      ? `Rejected supplier price for rfq_item ${item.rfqItemId}: ${trimmed}`
      : `Restored supplier price for rfq_item ${item.rfqItemId}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.json({
    id: offerItemId,
    isRejected: target,
    rejectionReason: target ? trimmed : null,
  });
});

export default router;

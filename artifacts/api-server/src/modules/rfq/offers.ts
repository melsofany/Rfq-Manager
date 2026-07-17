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

const router = Router();

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

export default router;

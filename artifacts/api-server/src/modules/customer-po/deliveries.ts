/**
 * Customer Delivery — تسليمات العملاء (line-item level)
 *
 * Tracks per-line delivery of customer purchase orders to the customer. The
 * customer may reject part of a delivered batch (defective/wrong), recorded
 * with a rejection reason. Delivered qty is guarded against the accepted qty
 * received from the supplier on the linked purchase_order_items (via
 * customerPoItemId) — you cannot deliver to the customer more than you have
 * accepted from the supplier.
 *
 * Routes mounted (via customer-po module index):
 *   GET   /customer-po/:id/deliveries        → list deliveries for a customer PO
 *   POST  /customer-po/:id/deliveries        → record a delivery (one or more lines)
 *   PATCH /customer-po/deliveries/:deliveryId → edit a delivery row
 *   DELETE /customer-po/deliveries/:deliveryId → delete a delivery row
 */
import { Router } from "express";
import {
  db,
  customerPosTable,
  customerPoItemsTable,
  customerPoItemDeliveriesTable,
  purchaseOrderItemsTable,
  workOrderAssignmentsTable,
  auditLogTable,
  WORK_ORDER_KIND,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { logger } from "../../shared/logger";
import { sendRepMainMenu } from "../communications/service";

const router = Router();

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * Re-aggregate the delivery totals onto a customer_po_item and recompute its
 * deliveryStatus. Called after every insert/update/delete of a delivery row.
 */
async function recomputeItemTotals(customerPoItemId: number): Promise<void> {
  const rows = await db
    .select()
    .from(customerPoItemDeliveriesTable)
    .where(eq(customerPoItemDeliveriesTable.customerPoItemId, customerPoItemId));

  const sum = (sel: (r: typeof rows[number]) => number | null) =>
    rows.reduce((acc, r) => acc + (sel(r) ?? 0), 0);

  const delivered = sum((r) => toNum(r.deliveredQty));
  const rejectedByCustomer = sum((r) => toNum(r.rejectedByCustomerQty));

  // Determine delivery status vs ordered qty.
  const [item] = await db
    .select({ qty: customerPoItemsTable.qty })
    .from(customerPoItemsTable)
    .where(eq(customerPoItemsTable.id, customerPoItemId));
  const ordered = toNum(item?.qty);
  let deliveryStatus = "pending";
  if (delivered > 0) {
    if (ordered != null && delivered >= ordered) deliveryStatus = "delivered";
    else deliveryStatus = "partial";
  } else if (rejectedByCustomer > 0) {
    deliveryStatus = "rejected";
  }

  await db
    .update(customerPoItemsTable)
    .set({
      totalDeliveredQty: delivered != null ? String(delivered) : null,
      totalRejectedByCustomerQty:
        rejectedByCustomer != null ? String(rejectedByCustomer) : null,
      deliveryStatus,
    })
    .where(eq(customerPoItemsTable.id, customerPoItemId));
}

/**
 * Sum of accepted qty received from the supplier for a customer_po_item.
 * Sums across all purchase_order_items linked to this customer_po_item via
 * customerPoItemId. Returns null when no supplier link exists (free/manual
 * lines) — in that case the guard is skipped.
 */
export async function acceptedQtyFromSupplier(customerPoItemId: number): Promise<number | null> {
  const rows = await db
    .select({
      accepted: purchaseOrderItemsTable.totalAcceptedQty,
      lineStatus: purchaseOrderItemsTable.lineStatus,
    })
    .from(purchaseOrderItemsTable)
    .where(eq(purchaseOrderItemsTable.customerPoItemId, customerPoItemId));
  if (!rows.length) return null; // no supplier link → unguarded
  // Only count lines that were actually received (not pending/rejected/cancelled).
  return rows
    .filter((r) => r.lineStatus !== "rejected" && r.lineStatus !== "cancelled")
    .reduce((acc, r) => acc + (toNum(r.accepted) ?? 0), 0);
}

// GET /customer-po/:id/deliveries — list all delivery rows for a customer PO.
router.get("/customer-po/:id/deliveries", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!isFinite(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const rows = await db
    .select({
      delivery: customerPoItemDeliveriesTable,
      lineItem: customerPoItemsTable.lineItem,
      partNo: customerPoItemsTable.partNo,
      description: customerPoItemsTable.description,
      uom: customerPoItemsTable.uom,
      orderedQty: customerPoItemsTable.qty,
    })
    .from(customerPoItemDeliveriesTable)
    .innerJoin(
      customerPoItemsTable,
      eq(customerPoItemDeliveriesTable.customerPoItemId, customerPoItemsTable.id),
    )
    .where(eq(customerPoItemDeliveriesTable.customerPoId, id))
    .orderBy(customerPoItemDeliveriesTable.deliveredAt);

  res.json(
    rows.map((r) => ({
      id: r.delivery.id,
      customerPoItemId: r.delivery.customerPoItemId,
      customerPoId: r.delivery.customerPoId,
      lineItem: r.lineItem,
      partNo: r.partNo,
      description: r.description,
      uom: r.uom,
      orderedQty: r.orderedQty ? parseFloat(r.orderedQty) : null,
      deliveredQty: r.delivery.deliveredQty ? parseFloat(r.delivery.deliveredQty) : null,
      rejectedByCustomerQty: r.delivery.rejectedByCustomerQty
        ? parseFloat(r.delivery.rejectedByCustomerQty)
        : null,
      rejectionReason: r.delivery.rejectionReason,
      deliveryStatus: r.delivery.deliveryStatus,
      deliveredBy: r.delivery.deliveredBy,
      deliveredAt: r.delivery.deliveredAt.toISOString(),
      createdAt: r.delivery.createdAt.toISOString(),
    })),
  );
});

interface DeliveryInput {
  customerPoItemId: number;
  deliveredQty?: number | string | null;
  rejectedByCustomerQty?: number | string | null;
  rejectionReason?: string | null;
  deliveredBy?: string | null;
}

// POST /customer-po/:id/deliveries — record one or more delivery rows.
router.post("/customer-po/:id/deliveries", requireAuth, async (req, res): Promise<void> => {
  const customerPoId = parseInt(String(req.params.id), 10);
  if (!isFinite(customerPoId)) {
    res.status(400).json({ error: "معرّف أمر شراء العميل غير صالح" });
    return;
  }
  const body = req.body ?? {};
  const items: DeliveryInput[] = Array.isArray(body.items) ? body.items : [body];
  if (!items.length) {
    res.status(400).json({ error: "أدخل بيانات التسليم" });
    return;
  }

  const [po] = await db
    .select({ id: customerPosTable.id, internalPoNo: customerPosTable.internalPoNo })
    .from(customerPosTable)
    .where(eq(customerPosTable.id, customerPoId));
  if (!po) {
    res.status(404).json({ error: "أمر شراء العميل غير موجود" });
    return;
  }

  const deliveredBy = (body.deliveredBy as string) || req.session.employeeName || null;
  const createdIds: number[] = [];

  for (const it of items) {
    const customerPoItemId = Number(it.customerPoItemId);
    if (!isFinite(customerPoItemId)) {
      res.status(400).json({ error: "معرّف البند غير صالح" });
      return;
    }
    const [line] = await db
      .select({ id: customerPoItemsTable.id })
      .from(customerPoItemsTable)
      .where(eq(customerPoItemsTable.id, customerPoItemId));
    if (!line) {
      res.status(404).json({ error: "البند غير موجود" });
      return;
    }

    const delivered = toNum(it.deliveredQty);
    const rejected = toNum(it.rejectedByCustomerQty);

    // Guard: cannot deliver to the customer before receiving from the supplier.
    // If a supplier link exists, accepted must be > 0 and delivered ≤ accepted.
    const accepted = await acceptedQtyFromSupplier(customerPoItemId);
    if (accepted != null && accepted <= 0) {
      res.status(400).json({
        error: "لا يمكن التسليم قبل الاستلام من المورد — البند لم يُستلم بعد",
      });
      return;
    }
    if (accepted != null && delivered != null && delivered > accepted + 1e-9) {
      res.status(400).json({
        error: `الكمية المسلّمة (${delivered}) تتجاوز الكمية المقبولة من المورد (${accepted})`,
      });
      return;
    }

    let status = "delivered";
    if ((delivered ?? 0) === 0 && (rejected ?? 0) > 0) status = "rejected";

    const [row] = await db
      .insert(customerPoItemDeliveriesTable)
      .values({
        customerPoItemId,
        customerPoId,
        deliveredQty: delivered != null ? String(delivered) : null,
        rejectedByCustomerQty: rejected != null ? String(rejected) : null,
        rejectionReason: it.rejectionReason ?? null,
        deliveryStatus: status,
        deliveredBy,
      })
      .returning({ id: customerPoItemDeliveriesTable.id });
    createdIds.push(row.id);

    await recomputeItemTotals(customerPoItemId);
  }

  await db.insert(auditLogTable).values({
    action: "customer_po.delivery",
    entityType: "customer_po",
    entityId: customerPoId,
    employeeId: req.session.employeeId,
    description: `Recorded ${createdIds.length} delivery(ies) for customer PO ${po.internalPoNo}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.status(201).json({ ok: true, createdIds });
});

/**
 * POST /customer-po/:id/send-delivery-prompts — nudge the representative(s)
 * assigned to this customer PO's pending delivery lines by sending them the
 * rep bot main menu (which lists their pending deliveries). Body may specify
 * { representativePhone, representativeName } to target one rep; otherwise all
 * reps with pending delivery assignments for this PO are pinged.
 */
router.post("/customer-po/:id/send-delivery-prompts", requireAuth, async (req, res): Promise<void> => {
  const customerPoId = parseInt(String(req.params.id), 10);
  if (!isFinite(customerPoId)) {
    res.status(400).json({ error: "معرّف أمر شراء العميل غير صالح" });
    return;
  }
  const [po] = await db
    .select({ id: customerPosTable.id, internalPoNo: customerPosTable.internalPoNo })
    .from(customerPosTable)
    .where(eq(customerPosTable.id, customerPoId));
  if (!po) {
    res.status(404).json({ error: "أمر شراء العميل غير موجود" });
    return;
  }

  // Find delivery assignments for this PO that are still pending.
  const assigns = await db
    .select({
      repPhone: workOrderAssignmentsTable.representativePhone,
      repName: workOrderAssignmentsTable.representativeName,
      status: workOrderAssignmentsTable.status,
    })
    .from(workOrderAssignmentsTable)
    .where(
      and(
        eq(workOrderAssignmentsTable.customerPoId, customerPoId),
        eq(workOrderAssignmentsTable.kind, WORK_ORDER_KIND.DELIVERY),
      ),
    );
  const phones = new Set<string>();
  for (const a of assigns) {
    if (a.status !== "delivered" && a.status !== "rejected") phones.add(a.repPhone);
  }
  // Allow an explicit target rep (e.g. when assigning a delivery to a rep who
  // has no assignment yet, so the nudge still reaches them).
  const bodyPhone = typeof req.body?.representativePhone === "string" ? req.body.representativePhone : null;
  if (bodyPhone) phones.add(bodyPhone);

  if (phones.size === 0) {
    res.status(400).json({ error: "لا يوجد مندوب مسند لهذا الأمر بعد." });
    return;
  }

  let sent = 0;
  for (const phone of phones) {
    try {
      // Send a nudge text + main menu so the rep sees their pending deliveries.
      await sendRepMainMenu(phone, { receipt: 0, delivery: 1 });
      sent++;
    } catch (err) {
      logger.warn({ err, phone }, "send-delivery-prompts: failed to message rep");
    }
  }

  await db.insert(auditLogTable).values({
    action: "customer_po.send_delivery_prompts",
    entityType: "customer_po",
    entityId: customerPoId,
    employeeId: req.session.employeeId,
    description: `Sent ${sent} delivery prompt(s) for customer PO ${po.internalPoNo}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.json({ ok: true, sent });
});

// PATCH /customer-po/deliveries/:deliveryId — edit a single delivery row.
router.patch(
  "/customer-po/deliveries/:deliveryId",
  requireAuth,
  async (req, res): Promise<void> => {
    const deliveryId = parseInt(String(req.params.deliveryId), 10);
    if (!isFinite(deliveryId)) {
      res.status(400).json({ error: "معرّف التسليم غير صالح" });
      return;
    }
    const [existing] = await db
      .select()
      .from(customerPoItemDeliveriesTable)
      .where(eq(customerPoItemDeliveriesTable.id, deliveryId));
    if (!existing) {
      res.status(404).json({ error: "سجل التسليم غير موجود" });
      return;
    }

    const body = req.body ?? {};
    const delivered = toNum(body.deliveredQty);
    const rejected = toNum(body.rejectedByCustomerQty);

    // Guard: delivered may not exceed accepted qty from supplier.
    const accepted = await acceptedQtyFromSupplier(existing.customerPoItemId);
    if (accepted != null && delivered != null && delivered > accepted + 1e-9) {
      res.status(400).json({
        error: `الكمية المسلّمة (${delivered}) تتجاوز الكمية المقبولة من المورد (${accepted})`,
      });
      return;
    }

    let status = existing.deliveryStatus;
    if (body.deliveryStatus) status = String(body.deliveryStatus);
    else if ((delivered ?? 0) === 0 && (rejected ?? 0) > 0) status = "rejected";
    else status = "delivered";

    await db
      .update(customerPoItemDeliveriesTable)
      .set({
        deliveredQty: delivered != null ? String(delivered) : null,
        rejectedByCustomerQty: rejected != null ? String(rejected) : null,
        rejectionReason: body.rejectionReason ?? existing.rejectionReason,
        deliveryStatus: status,
        deliveredBy: body.deliveredBy ?? existing.deliveredBy,
      })
      .where(eq(customerPoItemDeliveriesTable.id, deliveryId));

    await recomputeItemTotals(existing.customerPoItemId);

    await db.insert(auditLogTable).values({
      action: "customer_po.delivery.updated",
      entityType: "customer_po",
      entityId: existing.customerPoId,
      employeeId: req.session.employeeId,
      description: `Updated delivery ${deliveryId} for customer PO item ${existing.customerPoItemId}`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    res.json({ ok: true });
  },
);

// DELETE /customer-po/deliveries/:deliveryId — delete a delivery row.
router.delete(
  "/customer-po/deliveries/:deliveryId",
  requireAuth,
  async (req, res): Promise<void> => {
    const deliveryId = parseInt(String(req.params.deliveryId), 10);
    if (!isFinite(deliveryId)) {
      res.status(400).json({ error: "معرّف التسليم غير صالح" });
      return;
    }
    const [existing] = await db
      .select()
      .from(customerPoItemDeliveriesTable)
      .where(eq(customerPoItemDeliveriesTable.id, deliveryId));
    if (!existing) {
      res.status(404).json({ error: "سجل التسليم غير موجود" });
      return;
    }

    await db
      .delete(customerPoItemDeliveriesTable)
      .where(eq(customerPoItemDeliveriesTable.id, deliveryId));
    await recomputeItemTotals(existing.customerPoItemId);

    await db.insert(auditLogTable).values({
      action: "customer_po.delivery.deleted",
      entityType: "customer_po",
      entityId: existing.customerPoId,
      employeeId: req.session.employeeId,
      description: `Deleted delivery ${deliveryId} for customer PO item ${existing.customerPoItemId}`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    res.json({ ok: true });
  },
);

export default router;

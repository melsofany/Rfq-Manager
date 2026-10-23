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
import { freezeOnDelivery } from "../rfq/attribution";
import {
  db,
  customerPosTable,
  customerPoItemsTable,
  customerPoItemDeliveriesTable,
  purchaseOrderItemsTable,
  workOrderAssignmentsTable,
  auditLogTable,
  employeesTable,
  WORK_ORDER_KIND,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";
import { requireAuth } from "../../middlewares/auth";
import { logger } from "../../shared/logger";
import { sendRepMainMenu } from "../communications/service";
import { applyDeliverySideEffects } from "../communications/routes";

const router = Router();

/** Carries an HTTP status out of the delivery transaction to the response. */
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * Fingerprint of a WHOLE multi-item delivery submission. The items are sorted by
 * customerPoItemId so key order never changes the hash, and every effective
 * field (qty, customer-rejected qty, rejection reason) participates — so dropping
 * an item or changing a quantity produces a different hash and yields 409.
 */
function computePayloadHash(items: DeliveryInput[]): string {
  const canonical = [...items]
    .map((it) => ({
      id: Number(it.customerPoItemId),
      d: toNum(it.deliveredQty) ?? 0,
      r: toNum(it.rejectedByCustomerQty) ?? 0,
      reason: it.rejectionReason ?? null,
    }))
    .sort((a, b) => a.id - b.id);
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Re-aggregate the delivery totals onto a customer_po_item and recompute its
 * deliveryStatus. Called after every insert/update/delete of a delivery row.
 */
async function recomputeItemTotals(customerPoItemId: number): Promise<void> {
  // Voided rows keep their history but never count toward the totals.
  const rows = await db
    .select()
    .from(customerPoItemDeliveriesTable)
    .where(
      and(
        eq(customerPoItemDeliveriesTable.customerPoItemId, customerPoItemId),
        eq(customerPoItemDeliveriesTable.voided, false),
      ),
    );

  const sum = (sel: (r: (typeof rows)[number]) => number | null) =>
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
      totalRejectedByCustomerQty: rejectedByCustomer != null ? String(rejectedByCustomer) : null,
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
  const payloadHash = computePayloadHash(items);

  // The operation key identifies the WHOLE submission. Re-sending it must be
  // compared against the ORIGINAL item set — never against the item keys present
  // in the retried request (a dropped item would otherwise go unnoticed).
  const operationKey =
    (body.operationKey as string) ||
    (body.idempotencyKey as string) ||
    (req.get("x-operation-key") as string) ||
    crypto.randomUUID();
  const waMessageId = (body.waMessageId as string) || null;

  const submitted = new Map(
    items.map((it) => [
      Number(it.customerPoItemId),
      {
        delivered: toNum(it.deliveredQty) ?? 0,
        rejected: toNum(it.rejectedByCustomerQty) ?? 0,
        reason: it.rejectionReason ?? null,
      },
    ]),
  );

  // ── Idempotency: has this operation already been recorded? ────────────────
  const existing = await db
    .select()
    .from(customerPoItemDeliveriesTable)
    .where(eq(customerPoItemDeliveriesTable.operationKey, operationKey));
  if (existing.length > 0) {
    const sameSet =
      existing.length === submitted.size &&
      existing.every((r) => submitted.has(r.customerPoItemId));
    const sameContent = existing.every((r) => {
      const s = submitted.get(r.customerPoItemId);
      if (!s) return false;
      return (
        (toNum(r.deliveredQty) ?? 0) === s.delivered &&
        (toNum(r.rejectedByCustomerQty) ?? 0) === s.rejected &&
        (r.rejectionReason ?? null) === s.reason
      );
    });
    if (sameSet && sameContent) {
      // Exact re-send ⇒ return the ORIGINAL rows, create nothing.
      res.status(200).json({ ok: true, createdIds: existing.map((r) => r.id), idempotent: true });
      return;
    }
    res.status(409).json({
      error:
        "عملية تسليم بنفس المفتاح سبق تسجيلها بمحتوى مختلف (بنود/كميات/رفض) — استخدم عملية جديدة",
    });
    return;
  }

  // ── Atomic insert: every line succeeds or none is recorded ────────────────
  let createdIds: number[] = [];
  try {
    createdIds = await db.transaction(async (tx) => {
      const ids: number[] = [];
      for (const it of items) {
        const customerPoItemId = Number(it.customerPoItemId);
        if (!isFinite(customerPoItemId)) throw new HttpError(400, "معرّف البند غير صالح");
        const [line] = await tx
          .select({ id: customerPoItemsTable.id })
          .from(customerPoItemsTable)
          .where(eq(customerPoItemsTable.id, customerPoItemId));
        if (!line) throw new HttpError(404, "البند غير موجود");

        const delivered = toNum(it.deliveredQty);
        const rejected = toNum(it.rejectedByCustomerQty);

        const accepted = await acceptedQtyFromSupplier(customerPoItemId);
        if (accepted != null && accepted <= 0) {
          throw new HttpError(400, "لا يمكن التسليم قبل الاستلام من المورد — البند لم يُستلم بعد");
        }
        if (accepted != null && delivered != null && delivered > accepted + 1e-9) {
          throw new HttpError(
            400,
            `الكمية المسلّمة (${delivered}) تتجاوز الكمية المقبولة من المورد (${accepted})`,
          );
        }

        let status = "delivered";
        if ((delivered ?? 0) === 0 && (rejected ?? 0) > 0) status = "rejected";

        const [row] = await tx
          .insert(customerPoItemDeliveriesTable)
          .values({
            customerPoItemId,
            customerPoId,
            deliveredQty: delivered != null ? String(delivered) : null,
            rejectedByCustomerQty: rejected != null ? String(rejected) : null,
            rejectionReason: it.rejectionReason ?? null,
            deliveryStatus: status,
            deliveredBy,
            idempotencyKey:
              (body.idempotencyKey as string) || `${operationKey}:${customerPoItemId}`,
            operationKey,
            payloadHash,
            waMessageId,
          })
          .returning({ id: customerPoItemDeliveriesTable.id });
        ids.push(row.id);

        // The achievement is credited on DELIVERY (customer receipt), and only
        // for an approved classification — freezeOnDelivery enforces the gate.
        if ((delivered ?? 0) > 0) {
          await freezeOnDelivery(tx, customerPoItemId);
        }

        await recomputeItemTotals(customerPoItemId);
      }

      await tx.insert(auditLogTable).values({
        action: "customer_po.delivery",
        entityType: "customer_po",
        entityId: customerPoId,
        employeeId: req.session.employeeId,
        description: `Recorded ${ids.length} delivery(ies) for customer PO ${po.internalPoNo}`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });
      return ids;
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    // A concurrent identical submission may have won the unique index race.
    const raced = await db
      .select()
      .from(customerPoItemDeliveriesTable)
      .where(eq(customerPoItemDeliveriesTable.operationKey, operationKey));
    if (raced.length > 0) {
      const sameSet =
        raced.length === submitted.size && raced.every((r) => submitted.has(r.customerPoItemId));
      if (sameSet) {
        res.status(200).json({ ok: true, createdIds: raced.map((r) => r.id), idempotent: true });
        return;
      }
      res.status(409).json({ error: "تعارض في عملية تسليم متزامنة بنفس المفتاح" });
      return;
    }
    logger.error({ err }, "customer delivery failed");
    res.status(500).json({ error: "تعذّر تسجيل التسليم" });
    return;
  }

  // Side effects run AFTER the commit — a notification failure must never roll
  // back a recorded delivery.
  for (const it of items) {
    const customerPoItemId = Number(it.customerPoItemId);
    const [updated] = await db
      .select({ deliveryStatus: customerPoItemsTable.deliveryStatus })
      .from(customerPoItemsTable)
      .where(eq(customerPoItemsTable.id, customerPoItemId));
    try {
      await applyDeliverySideEffects(
        customerPoId,
        customerPoItemId,
        updated?.deliveryStatus ?? "pending",
      );
    } catch {
      // best-effort — never block the delivery if the side-effects fail
    }
  }

  res.status(201).json({ ok: true, createdIds });
});

/**
 * POST /customer-po/:id/send-delivery-prompts — nudge the representative(s)
 * assigned to this customer PO's pending delivery lines by sending them the
 * rep bot main menu (which lists their pending deliveries). Body may specify
 * { representativePhone, representativeName } to target one rep; otherwise all
 * reps with pending delivery assignments for this PO are pinged.
 */
router.post(
  "/customer-po/:id/send-delivery-prompts",
  requireAuth,
  async (req, res): Promise<void> => {
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
    const bodyPhone =
      typeof req.body?.representativePhone === "string" ? req.body.representativePhone : null;
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
  },
);

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

// PATCH /customer-po/deliveries/:deliveryId/void — SOFT-void a delivery row.
// The row is never deleted: it keeps its original deliveredAt, its actor and a
// snapshot of the voiding employee's name, but stops counting toward totals.
router.patch(
  "/customer-po/deliveries/:deliveryId/void",
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
    if (existing.voided) {
      res.status(409).json({ error: "سجل التسليم ملغى بالفعل" });
      return;
    }

    let voidedByName: string | null = null;
    if (req.session.employeeId) {
      const [emp] = await db
        .select({ name: employeesTable.name })
        .from(employeesTable)
        .where(eq(employeesTable.id, req.session.employeeId));
      voidedByName = emp?.name ?? null;
    }

    await db
      .update(customerPoItemDeliveriesTable)
      .set({
        voided: true,
        voidedAt: new Date(),
        voidedBy: req.session.employeeId ?? null,
        voidedByName,
        voidReason: (req.body?.reason as string) || null,
      })
      .where(eq(customerPoItemDeliveriesTable.id, deliveryId));
    await recomputeItemTotals(existing.customerPoItemId);

    await db.insert(auditLogTable).values({
      action: "customer_po.delivery.voided",
      entityType: "customer_po",
      entityId: existing.customerPoId,
      employeeId: req.session.employeeId,
      description: `Voided delivery ${deliveryId} for customer PO item ${existing.customerPoItemId}`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    res.json({ ok: true });
  },
);

export default router;

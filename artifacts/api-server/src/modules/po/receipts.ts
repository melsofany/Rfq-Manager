/**
 * Goods Receipt — استلام التوريدات من المورد (line-item level)
 *
 * Tracks per-line receipt of supplier purchase orders. A single
 * purchase_order_item may receive several receipts (partial shipments):
 * line A received in full in one row, line B postponed (no rows), line C
 * received across two rows. Each receipt captures received/accepted/rejected
 * qty, rejection reason, and the actual cost for that batch. The aggregated
 * totals are mirrored onto purchase_order_items for fast reads.
 *
 * Routes mounted (via po module index):
 *   GET   /po/:id/receipts          → list receipts for a PO
 *   POST  /po/:id/receipts          → record a receipt (one or more lines)
 *   PATCH /po/receipts/:receiptId   → edit a receipt row
 *   DELETE /po/receipts/:receiptId  → delete a receipt row (re-aggregates)
 */
import { Router } from "express";
import {
  db,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  poItemReceiptsTable,
  workOrderAssignmentsTable,
  auditLogTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import {
  isWhatsAppConfigured,
  sendRepresentativeItemReceiptWhatsApp,
} from "../communications/service";
import { applyReceiptSideEffects } from "../communications/routes";
import { normalizePhone } from "./routes";

const router = Router();

function formatQty(qty: string | null): string | null {
  if (qty == null) return null;
  const s = String(qty);
  if (!s.includes(".")) return s;
  const trimmed = s.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" ? "0" : trimmed;
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// Allowed rejection reasons surfaced to WhatsApp as quick-reply buttons.
export const REJECTION_REASONS = ["تالف", "خطأ في الصنف", "متأخر عن الموعد", "كمية أقل"] as const;

/**
 * Re-aggregate the receipt totals onto a purchase_order_item and recompute its
 * lineStatus. Called after every insert/update/delete of a receipt row.
 */
async function recomputeItemTotals(poItemId: number): Promise<void> {
  const rows = await db
    .select()
    .from(poItemReceiptsTable)
    .where(eq(poItemReceiptsTable.poItemId, poItemId));

  const sum = (sel: (r: typeof rows[number]) => number | null) =>
    rows.reduce((acc, r) => acc + (sel(r) ?? 0), 0);

  const received = sum((r) => toNum(r.receivedQty));
  const accepted = sum((r) => toNum(r.acceptedQty));
  const rejected = sum((r) => toNum(r.rejectedQty));

  // Weighted average actual cost across batches, using accepted qty as weight.
  let actualCost: number | null = null;
  const weighted = rows.reduce(
    (acc, r) => {
      const q = toNum(r.acceptedQty) ?? 0;
      const c = toNum(r.actualCost);
      if (q > 0 && c != null) {
        acc.total += q * c;
        acc.weight += q;
      }
      return acc;
    },
    { total: 0, weight: 0 },
  );
  if (weighted.weight > 0) actualCost = weighted.total / weighted.weight;

  // Determine line status from totals vs ordered qty.
  const [item] = await db
    .select({ qty: purchaseOrderItemsTable.qty, lineStatus: purchaseOrderItemsTable.lineStatus })
    .from(purchaseOrderItemsTable)
    .where(eq(purchaseOrderItemsTable.id, poItemId));
  // A cancelled line stays cancelled — never resurrect it from receipt rows.
  if (item?.lineStatus === "cancelled") return;
  const ordered = toNum(item?.qty);
  let lineStatus = "pending";
  if (accepted != null && accepted > 0) {
    if (ordered != null && accepted >= ordered) lineStatus = "fulfilled";
    else lineStatus = "partial";
  } else if (rejected != null && rejected > 0) {
    lineStatus = "rejected";
  }
  // If a line has no receipts yet it stays pending; "postponed" is set
  // explicitly via the POST { postpone: true } shortcut.

  await db
    .update(purchaseOrderItemsTable)
    .set({
      totalReceivedQty: received != null ? String(received) : null,
      totalAcceptedQty: accepted != null ? String(accepted) : null,
      totalRejectedQty: rejected != null ? String(rejected) : null,
      finalActualCost: actualCost != null ? String(actualCost) : null,
      lineStatus,
    })
    .where(eq(purchaseOrderItemsTable.id, poItemId));
}

// GET /po/:id/receipts — list all receipt rows for a PO, joined with item info.
router.get("/po/:id/receipts", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!isFinite(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const rows = await db
    .select({
      receipt: poItemReceiptsTable,
      lineItem: purchaseOrderItemsTable.lineItem,
      partNo: purchaseOrderItemsTable.partNo,
      description: purchaseOrderItemsTable.description,
      uom: purchaseOrderItemsTable.uom,
    })
    .from(poItemReceiptsTable)
    .innerJoin(purchaseOrderItemsTable, eq(poItemReceiptsTable.poItemId, purchaseOrderItemsTable.id))
    .where(eq(poItemReceiptsTable.poId, id))
    .orderBy(poItemReceiptsTable.receivedAt);

  res.json(
    rows.map((r) => ({
      id: r.receipt.id,
      poItemId: r.receipt.poItemId,
      poId: r.receipt.poId,
      lineItem: r.lineItem,
      partNo: r.partNo,
      description: r.description,
      uom: r.uom,
      receivedQty: r.receipt.receivedQty ? parseFloat(r.receipt.receivedQty) : null,
      acceptedQty: r.receipt.acceptedQty ? parseFloat(r.receipt.acceptedQty) : null,
      rejectedQty: r.receipt.rejectedQty ? parseFloat(r.receipt.rejectedQty) : null,
      rejectionReason: r.receipt.rejectionReason,
      actualCost: r.receipt.actualCost ? parseFloat(r.receipt.actualCost) : null,
      receiptStatus: r.receipt.receiptStatus,
      receivedBy: r.receipt.receivedBy,
      receivedAt: r.receipt.receivedAt.toISOString(),
      createdAt: r.receipt.createdAt.toISOString(),
    })),
  );
});

interface ReceiptInput {
  poItemId: number;
  receivedQty?: number | string | null;
  acceptedQty?: number | string | null;
  rejectedQty?: number | string | null;
  rejectionReason?: string | null;
  actualCost?: number | string | null;
  receivedBy?: string | null;
  // Shortcut: mark a line as postponed (no receipt row, just set lineStatus).
  postpone?: boolean;
}

// POST /po/:id/receipts — record one or more receipt rows for a PO.
router.post("/po/:id/receipts", requireAuth, async (req, res): Promise<void> => {
  const poId = parseInt(String(req.params.id), 10);
  if (!isFinite(poId)) {
    res.status(400).json({ error: "معرّف أمر الشراء غير صالح" });
    return;
  }
  const body = req.body ?? {};
  const items: ReceiptInput[] = Array.isArray(body.items) ? body.items : [body];
  if (!items.length) {
    res.status(400).json({ error: "أدخل بيانات الاستلام" });
    return;
  }

  const [po] = await db
    .select({ id: purchaseOrdersTable.id, internalPoNo: purchaseOrdersTable.internalPoNo })
    .from(purchaseOrdersTable)
    .where(eq(purchaseOrdersTable.id, poId));
  if (!po) {
    res.status(404).json({ error: "أمر الشراء غير موجود" });
    return;
  }

  const receivedBy = (body.receivedBy as string) || req.session.employeeName || null;
  const createdIds: number[] = [];

  for (const it of items) {
    const poItemId = Number(it.poItemId);
    if (!isFinite(poItemId)) {
      res.status(400).json({ error: "معرّف البند غير صالح" });
      return;
    }
    // Verify the item belongs to this PO + is still active (not cancelled).
    const [line] = await db
      .select({ id: purchaseOrderItemsTable.id, lineStatus: purchaseOrderItemsTable.lineStatus })
      .from(purchaseOrderItemsTable)
      .where(eq(purchaseOrderItemsTable.id, poItemId));
    if (!line) {
      res.status(404).json({ error: "البند غير موجود" });
      return;
    }
    if (line.lineStatus === "cancelled") {
      res.status(400).json({ error: "لا يمكن تسجيل استلام لبند تم إلغاؤه" });
      return;
    }

    if (it.postpone) {
      await db
        .update(purchaseOrderItemsTable)
        .set({ lineStatus: "postponed" })
        .where(eq(purchaseOrderItemsTable.id, poItemId));
      continue;
    }

    const received = toNum(it.receivedQty);
    const accepted = toNum(it.acceptedQty);
    const rejected = toNum(it.rejectedQty);
    let status = "received";
    if ((accepted ?? 0) === 0 && (rejected ?? 0) > 0) status = "rejected";
    else if (received != null && accepted != null && accepted < received) status = "partial";

    const [row] = await db
      .insert(poItemReceiptsTable)
      .values({
        poItemId,
        poId,
        receivedQty: received != null ? String(received) : null,
        acceptedQty: accepted != null ? String(accepted) : null,
        rejectedQty: rejected != null ? String(rejected) : null,
        rejectionReason: it.rejectionReason ?? null,
        actualCost: toNum(it.actualCost) != null ? String(toNum(it.actualCost)) : null,
        receiptStatus: status,
        receivedBy,
      })
      .returning({ id: poItemReceiptsTable.id });
    createdIds.push(row.id);

    await recomputeItemTotals(poItemId);

    // Mirror the rep bot: mark the receipt assignment done, chain a delivery
    // assignment for linked customer-PO items, broadcast to portal clients.
    const [updatedLine] = await db
      .select({ lineStatus: purchaseOrderItemsTable.lineStatus })
      .from(purchaseOrderItemsTable)
      .where(eq(purchaseOrderItemsTable.id, poItemId));
    try {
      await applyReceiptSideEffects(poId, poItemId, updatedLine?.lineStatus ?? "pending");
    } catch {
      // best-effort — never block the receipt if the side-effects fail
    }
  }

  await db.insert(auditLogTable).values({
    action: "po.receipt",
    entityType: "po",
    entityId: poId,
    employeeId: req.session.employeeId,
    description: `Recorded ${createdIds.length} receipt(s) for PO ${po.internalPoNo}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.status(201).json({ ok: true, createdIds });
});

// PATCH /po/receipts/:receiptId — edit a single receipt row.
router.patch("/po/receipts/:receiptId", requireAuth, async (req, res): Promise<void> => {
  const receiptId = parseInt(String(req.params.receiptId), 10);
  if (!isFinite(receiptId)) {
    res.status(400).json({ error: "معرّف الاستلام غير صالح" });
    return;
  }
  const [existing] = await db
    .select()
    .from(poItemReceiptsTable)
    .where(eq(poItemReceiptsTable.id, receiptId));
  if (!existing) {
    res.status(404).json({ error: "سجل الاستلام غير موجود" });
    return;
  }

  const body = req.body ?? {};
  const received = toNum(body.receivedQty);
  const accepted = toNum(body.acceptedQty);
  const rejected = toNum(body.rejectedQty);
  let status = existing.receiptStatus;
  if (body.receiptStatus) status = String(body.receiptStatus);
  else if ((accepted ?? 0) === 0 && (rejected ?? 0) > 0) status = "rejected";
  else if (received != null && accepted != null && accepted < received) status = "partial";
  else status = "received";

  await db
    .update(poItemReceiptsTable)
    .set({
      receivedQty: received != null ? String(received) : null,
      acceptedQty: accepted != null ? String(accepted) : null,
      rejectedQty: rejected != null ? String(rejected) : null,
      rejectionReason: body.rejectionReason ?? existing.rejectionReason,
      actualCost: toNum(body.actualCost) != null ? String(toNum(body.actualCost)) : existing.actualCost,
      receiptStatus: status,
      receivedBy: body.receivedBy ?? existing.receivedBy,
    })
    .where(eq(poItemReceiptsTable.id, receiptId));

  await recomputeItemTotals(existing.poItemId);

  await db.insert(auditLogTable).values({
    action: "po.receipt.updated",
    entityType: "po",
    entityId: existing.poId,
    employeeId: req.session.employeeId,
    description: `Updated receipt ${receiptId} for PO item ${existing.poItemId}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.json({ ok: true });
});

// DELETE /po/receipts/:receiptId — delete a receipt row and re-aggregate.
router.delete("/po/receipts/:receiptId", requireAuth, async (req, res): Promise<void> => {
  const receiptId = parseInt(String(req.params.receiptId), 10);
  if (!isFinite(receiptId)) {
    res.status(400).json({ error: "معرّف الاستلام غير صالح" });
    return;
  }
  const [existing] = await db
    .select()
    .from(poItemReceiptsTable)
    .where(eq(poItemReceiptsTable.id, receiptId));
  if (!existing) {
    res.status(404).json({ error: "سجل الاستلام غير موجود" });
    return;
  }

  await db.delete(poItemReceiptsTable).where(eq(poItemReceiptsTable.id, receiptId));
  await recomputeItemTotals(existing.poItemId);

  await db.insert(auditLogTable).values({
    action: "po.receipt.deleted",
    entityType: "po",
    entityId: existing.poId,
    employeeId: req.session.employeeId,
    description: `Deleted receipt ${receiptId} for PO item ${existing.poItemId}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.json({ ok: true });
});

/**
 * POST /po/:id/send-receipt-prompts — send a per-item goods-receipt prompt to
 * the representative for each line of a supplier PO via WhatsApp. Creates a
 * per-item work_order_assignment for each line and fires one interactive
 * button message per item. Returns per-item send results so the UI can report
 * successes/failures. Skips items whose line_status is already fulfilled.
 */
router.post("/po/:id/send-receipt-prompts", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!isFinite(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  const repName = typeof req.body?.representativeName === "string" ? req.body.representativeName.trim() : "";
  if (!phone || !repName) {
    res.status(400).json({ error: "بيانات المندوب غير مكتملة (الاسم/الهاتف)" });
    return;
  }
  if (!isWhatsAppConfigured) {
    res.status(400).json({ error: "واتساب غير مُعدّ" });
    return;
  }

  const [po] = await db
    .select({ id: purchaseOrdersTable.id, internalPoNo: purchaseOrdersTable.internalPoNo })
    .from(purchaseOrdersTable)
    .where(eq(purchaseOrdersTable.id, id));
  if (!po) {
    res.status(404).json({ error: "أمر الشراء غير موجود" });
    return;
  }

  const items = await db
    .select({
      id: purchaseOrderItemsTable.id,
      lineItem: purchaseOrderItemsTable.lineItem,
      description: purchaseOrderItemsTable.description,
      qty: purchaseOrderItemsTable.qty,
      lineStatus: purchaseOrderItemsTable.lineStatus,
    })
    .from(purchaseOrderItemsTable)
    .where(eq(purchaseOrderItemsTable.poId, id));

  const results: { poItemId: number; lineLabel: string; sent: boolean; error?: string }[] = [];
  const normalized = normalizePhone(phone);

  for (const it of items) {
    if (it.lineStatus === "fulfilled" || it.lineStatus === "rejected" || it.lineStatus === "cancelled") {
      results.push({
        poItemId: it.id,
        lineLabel: `${it.lineItem || ""} ${it.description || ""}`.trim(),
        sent: false,
        error: "البند تم استلامه/رفضه/إلغاؤه مسبقاً",
      });
      continue;
    }
    const lineLabel = `${it.lineItem || "بند"} — ${it.description || ""}`.trim();
    const qtyText = it.qty ? String(it.qty) : null;
    try {
      const waId = await sendRepresentativeItemReceiptWhatsApp({
        phone: normalized,
        poNo: po.internalPoNo,
        poItemId: it.id,
        lineLabel,
        qty: qtyText,
      });
      await db.insert(workOrderAssignmentsTable).values({
        poId: id,
        poItemId: it.id,
        representativeName: repName,
        representativePhone: normalized,
        status: "sent",
        waMessageId: waId,
      });
      results.push({ poItemId: it.id, lineLabel, sent: true });
    } catch (err) {
      results.push({
        poItemId: it.id,
        lineLabel,
        sent: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await db.insert(auditLogTable).values({
    action: "po.receipt.prompts",
    entityType: "po",
    entityId: id,
    employeeId: req.session.employeeId,
    description: `Sent ${results.filter((r) => r.sent).length}/${items.length} receipt prompt(s) for PO ${po.internalPoNo}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.json({ ok: true, results });
});

export default router;

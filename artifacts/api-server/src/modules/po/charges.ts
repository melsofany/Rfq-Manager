/**
 * PO Line-Item Charges — مصاريف مرتبطة ببند أمر الشراء
 *
 * Charges attached to a single supplier purchase-order line item (نقل، شحن،
 * جمارك، تحميل، تنزيل، …). Recorded at the line level so the true cost of
 * each line is known precisely; summed into the realized cost in the accounts
 * margin computation.
 *
 * Routes mounted (via po module index):
 *   GET    /po/items/:itemId/charges → list charges for a line
 *   POST   /po/items/:itemId/charges → add a charge to a line
 *   DELETE /po/charges/:chargeId     → delete a charge
 */
import { Router } from "express";
import { db, poItemChargesTable, purchaseOrderItemsTable, auditLogTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";

const router = Router();

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function formatNum(n: number | null): string | null {
  if (n == null) return null;
  const s = String(Math.round(n * 10000) / 10000);
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

// GET /po/items/:itemId/charges — list charges for a single PO line item.
router.get("/po/items/:itemId/charges", requireAuth, async (req, res): Promise<void> => {
  const itemId = parseInt(String(req.params.itemId), 10);
  if (!isFinite(itemId)) {
    res.status(400).json({ error: "معرّف البند غير صالح" });
    return;
  }
  const rows = await db
    .select()
    .from(poItemChargesTable)
    .where(eq(poItemChargesTable.poItemId, itemId));
  const total = rows.reduce((s, r) => s + (toNum(r.amount) ?? 0), 0);
  res.json({
    total: formatNum(total),
    charges: rows.map((r) => ({
      id: r.id,
      poItemId: r.poItemId,
      poId: r.poId,
      chargeType: r.chargeType,
      description: r.description,
      amount: formatNum(toNum(r.amount)),
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

// POST /po/items/:itemId/charges — add one or more charges to a line.
router.post("/po/items/:itemId/charges", requireAuth, async (req, res): Promise<void> => {
  const itemId = parseInt(String(req.params.itemId), 10);
  if (!isFinite(itemId)) {
    res.status(400).json({ error: "معرّف البند غير صالح" });
    return;
  }
  const [line] = await db
    .select({ id: purchaseOrderItemsTable.id, poId: purchaseOrderItemsTable.poId })
    .from(purchaseOrderItemsTable)
    .where(eq(purchaseOrderItemsTable.id, itemId));
  if (!line) {
    res.status(404).json({ error: "البند غير موجود" });
    return;
  }

  const body = req.body ?? {};
  const items: any[] = Array.isArray(body.charges) ? body.charges : [body];
  if (!items.length) {
    res.status(400).json({ error: "أدخل بيانات المصروف" });
    return;
  }

  const createdIds: number[] = [];
  for (const it of items) {
    const amount = toNum(it.amount);
    const chargeType = typeof it.chargeType === "string" ? it.chargeType.trim() : "";
    if (!chargeType) {
      res.status(400).json({ error: "نوع المصروف مطلوب" });
      return;
    }
    if (amount == null || amount <= 0) {
      res.status(400).json({ error: "قيمة المصروف غير صالحة" });
      return;
    }
    const [row] = await db
      .insert(poItemChargesTable)
      .values({
        poItemId: itemId,
        poId: line.poId,
        chargeType,
        description: it.description ?? null,
        amount: String(amount),
      })
      .returning({ id: poItemChargesTable.id });
    createdIds.push(row.id);
  }

  await db.insert(auditLogTable).values({
    action: "po.item.charge",
    entityType: "po",
    entityId: line.poId,
    employeeId: req.session.employeeId,
    description: `Added ${createdIds.length} charge(s) to PO item ${itemId}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.status(201).json({ ok: true, createdIds });
});

// DELETE /po/charges/:chargeId — delete a charge.
router.delete("/po/charges/:chargeId", requireAuth, async (req, res): Promise<void> => {
  const chargeId = parseInt(String(req.params.chargeId), 10);
  if (!isFinite(chargeId)) {
    res.status(400).json({ error: "معرّف المصروف غير صالح" });
    return;
  }
  const [existing] = await db
    .select()
    .from(poItemChargesTable)
    .where(eq(poItemChargesTable.id, chargeId));
  if (!existing) {
    res.status(404).json({ error: "المصروف غير موجود" });
    return;
  }
  await db.delete(poItemChargesTable).where(eq(poItemChargesTable.id, chargeId));
  await db.insert(auditLogTable).values({
    action: "po.item.charge.deleted",
    entityType: "po",
    entityId: existing.poId,
    employeeId: req.session.employeeId,
    description: `Deleted charge ${chargeId} from PO item ${existing.poItemId}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });
  res.json({ ok: true });
});

export default router;

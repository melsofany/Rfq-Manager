import { Router } from "express";
import {
  db,
  customerPosTable,
  customerPoItemsTable,
  customerRfqsTable,
  employeesTable,
  auditLogTable,
} from "@workspace/db";
import { eq, count, inArray, desc, sql } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";

const router = Router();

// Generate internal customer-PO number: CPO-YYYY-NNNNNN.
// Uses MAX of existing numbers (not COUNT) so deletions never cause collisions.
async function generateInternalPoNo(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `CPO-${year}-`;
  const [result] = await db
    .select({ maxNo: sql<string | null>`max(${customerPosTable.internalPoNo})` })
    .from(customerPosTable)
    .where(sql`${customerPosTable.internalPoNo} like ${prefix + "%"}`);
  let seq = 1;
  if (result?.maxNo) {
    const lastSeq = parseInt(result.maxNo.slice(prefix.length), 10);
    if (!isNaN(lastSeq) && lastSeq > 0) seq = lastSeq + 1;
  }
  return `${prefix}${String(seq).padStart(6, "0")}`;
}

// Trim trailing zeros from a NUMERIC value: "3.0000" → "3", "3.5000" → "3.5".
function formatQty(qty: string | null): string | null {
  if (qty == null) return null;
  const s = String(qty);
  if (!s.includes(".")) return s;
  const trimmed = s.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" ? "0" : trimmed;
}

// Line total = qty * unitPrice, rounded to 4dp and stripped of trailing zeros.
function computeTotal(qty: string | null, unitPrice: string | null): string | null {
  if (qty == null || unitPrice == null) return null;
  const q = Number(qty);
  const p = Number(unitPrice);
  if (!isFinite(q) || !isFinite(p)) return null;
  const n = Math.round(q * p * 10000) / 10000;
  return formatQty(String(n));
}

function serialize(
  r: typeof customerPosTable.$inferSelect,
  itemCount: number,
) {
  return {
    id: r.id,
    internalPoNo: r.internalPoNo,
    customerPoNo: r.customerPoNo,
    customerId: r.customerId,
    customerName: r.customerName,
    poDate: r.poDate,
    buyerName: r.buyerName,
    employeeId: r.employeeId,
    employeeName: r.employeeName,
    status: r.status,
    notes: r.notes,
    itemCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// GET /customer-po — list with optional search
router.get("/customer-po", requireAuth, async (req, res): Promise<void> => {
  const { search, status } = req.query as Record<string, string>;

  const rows = await db
    .select({ po: customerPosTable })
    .from(customerPosTable)
    .orderBy(desc(customerPosTable.createdAt));

  let filtered = rows;
  if (status) filtered = filtered.filter((r) => r.po.status === status);
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.po.internalPoNo.toLowerCase().includes(s) ||
        r.po.customerPoNo.toLowerCase().includes(s) ||
        (r.po.buyerName ?? "").toLowerCase().includes(s) ||
        (r.po.customerName ?? "").toLowerCase().includes(s),
    );
  }

  const ids = filtered.map((r) => r.po.id);
  const counts =
    ids.length > 0
      ? await db
          .select({ customerPoId: customerPoItemsTable.customerPoId, cnt: count() })
          .from(customerPoItemsTable)
          .where(inArray(customerPoItemsTable.customerPoId, ids))
          .groupBy(customerPoItemsTable.customerPoId)
      : [];
  const countMap = Object.fromEntries(counts.map((c) => [c.customerPoId, c.cnt]));

  res.json(filtered.map((r) => serialize(r.po, countMap[r.po.id] ?? 0)));
});

// GET /customer-po/customer-rfqs — light list of customer RFQs (id, number,
// customer, status) for the picker on the new page. Both draft and sent RFQs
// can be the source of a customer PO (sent = finalized prices).
router.get("/customer-po/customer-rfqs", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: customerRfqsTable.id,
      customerRfqNo: customerRfqsTable.customerRfqNo,
      internalNo: customerRfqsTable.internalNo,
      customerName: customerRfqsTable.customerName,
      status: customerRfqsTable.status,
    })
    .from(customerRfqsTable)
    .orderBy(desc(customerRfqsTable.createdAt));
  res.json({ rfqs: rows });
});

// POST /customer-po — create a customer PO
router.post("/customer-po", requireAuth, async (req, res): Promise<void> => {
  const { customerPoNo, customerId, customerName, poDate, buyerName, notes, items } = req.body as {
    customerPoNo?: string;
    customerId?: number | null;
    customerName?: string;
    poDate?: string;
    buyerName?: string;
    notes?: string;
    items?: Array<{
      customerRfqId?: number | null;
      customerRfqItemId?: number | null;
      partNo?: string;
      lineItem?: string;
      description?: string;
      uom?: string;
      qty?: string | number | null;
      unitPrice?: string | number | null;
      deliveryDate?: string;
    }>;
  };

  if (!customerPoNo?.trim()) {
    res.status(400).json({ error: "رقم أمر شراء العميل مطلوب" });
    return;
  }
  if (!customerName?.trim() && !customerId) {
    res.status(400).json({ error: "يجب اختيار اسم العميل" });
    return;
  }
  const validItems = (items ?? []).filter(
    (it) => (it.partNo?.trim() || it.lineItem?.trim() || it.description?.trim()) && it.qty,
  );
  if (validItems.length === 0) {
    res.status(400).json({ error: "يجب إدخال بند واحد على الأقل" });
    return;
  }

  const internalPoNo = await generateInternalPoNo();

  // Record the logged-in employee (the user who entered the PO).
  let employeeName: string | null = null;
  if (req.session.employeeId) {
    const [emp] = await db
      .select({ name: employeesTable.name })
      .from(employeesTable)
      .where(eq(employeesTable.id, req.session.employeeId));
    employeeName = emp?.name ?? null;
  }

  const [po] = await db
    .insert(customerPosTable)
    .values({
      internalPoNo,
      customerPoNo: customerPoNo.trim(),
      customerId: customerId ?? null,
      customerName: customerName?.trim() || null,
      poDate: poDate || null,
      buyerName: buyerName?.trim() || null,
      employeeId: req.session.employeeId,
      employeeName,
      notes: notes?.trim() || null,
      status: "draft",
    })
    .returning();

  await db.insert(customerPoItemsTable).values(
    validItems.map((it) => ({
      customerPoId: po.id,
      customerRfqId: it.customerRfqId ?? null,
      customerRfqItemId: it.customerRfqItemId ?? null,
      partNo: it.partNo?.trim() || null,
      lineItem: it.lineItem ? it.lineItem.replace(/\s+/g, "") : null,
      description: it.description?.trim() || null,
      uom: it.uom?.trim() || null,
      qty: it.qty != null && it.qty !== "" ? String(it.qty) : null,
      unitPrice: it.unitPrice != null && it.unitPrice !== "" ? String(it.unitPrice) : null,
      deliveryDate: it.deliveryDate || null,
    })),
  );

  await db.insert(auditLogTable).values({
    action: "customer_po.created",
    entityType: "customer_po",
    entityId: po.id,
    employeeId: req.session.employeeId,
    description: `Created customer PO ${internalPoNo} (customer PO ${customerPoNo}) for ${customerName?.trim() || "—"} with ${validItems.length} item(s)`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.status(201).json(serialize(po, validItems.length));
});

// GET /customer-po/:id — detail with items
router.get("/customer-po/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [po] = await db.select().from(customerPosTable).where(eq(customerPosTable.id, id));
  if (!po) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const items = await db
    .select()
    .from(customerPoItemsTable)
    .where(eq(customerPoItemsTable.customerPoId, id));
  res.json({
    ...serialize(po, items.length),
    items: items.map((i) => ({
      id: i.id,
      customerPoId: i.customerPoId,
      customerRfqId: i.customerRfqId,
      customerRfqItemId: i.customerRfqItemId,
      partNo: i.partNo,
      lineItem: i.lineItem,
      description: i.description,
      uom: i.uom,
      qty: formatQty(i.qty),
      unitPrice: formatQty(i.unitPrice),
      total: computeTotal(i.qty, i.unitPrice),
      deliveryDate: i.deliveryDate,
      createdAt: i.createdAt.toISOString(),
    })),
  });
});

// PATCH /customer-po/:id — update a draft (or finalize → sent)
router.patch("/customer-po/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [existing] = await db.select().from(customerPosTable).where(eq(customerPosTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (existing.status !== "draft") {
    res.status(400).json({ error: "لا يمكن تعديل أمر شراء العميل بعد إرساله" });
    return;
  }

  const { customerPoNo, customerId, customerName, poDate, buyerName, notes, status, items } = req.body as {
    customerPoNo?: string;
    customerId?: number | null;
    customerName?: string;
    poDate?: string;
    buyerName?: string;
    notes?: string;
    status?: string;
    items?: Array<{
      customerRfqId?: number | null;
      customerRfqItemId?: number | null;
      partNo?: string;
      lineItem?: string;
      description?: string;
      uom?: string;
      qty?: string | number | null;
      unitPrice?: string | number | null;
      deliveryDate?: string;
    }>;
  };

  const updates: Record<string, unknown> = {};
  if (customerPoNo !== undefined) updates.customerPoNo = customerPoNo.trim();
  if (customerId !== undefined) updates.customerId = customerId ?? null;
  if (customerName !== undefined) updates.customerName = customerName?.trim() || null;
  if (poDate !== undefined) updates.poDate = poDate || null;
  if (buyerName !== undefined) updates.buyerName = buyerName?.trim() || null;
  if (notes !== undefined) updates.notes = notes?.trim() || null;
  if (status === "sent") updates.status = "sent";
  else if (status !== undefined) updates.status = status;

  if (Object.keys(updates).length > 0) {
    await db.update(customerPosTable).set(updates).where(eq(customerPosTable.id, id));
  }

  if (items !== undefined) {
    const validItems = items.filter(
      (it) => (it.partNo?.trim() || it.lineItem?.trim() || it.description?.trim()) && it.qty,
    );
    await db.delete(customerPoItemsTable).where(eq(customerPoItemsTable.customerPoId, id));
    if (validItems.length > 0) {
      await db.insert(customerPoItemsTable).values(
        validItems.map((it) => ({
          customerPoId: id,
          customerRfqId: it.customerRfqId ?? null,
          customerRfqItemId: it.customerRfqItemId ?? null,
          partNo: it.partNo?.trim() || null,
          lineItem: it.lineItem ? it.lineItem.replace(/\s+/g, "") : null,
          description: it.description?.trim() || null,
          uom: it.uom?.trim() || null,
          qty: it.qty != null && it.qty !== "" ? String(it.qty) : null,
          unitPrice: it.unitPrice != null && it.unitPrice !== "" ? String(it.unitPrice) : null,
          deliveryDate: it.deliveryDate || null,
        })),
      );
    }
  }

  const [updated] = await db.select().from(customerPosTable).where(eq(customerPosTable.id, id));
  const itemRows = await db
    .select()
    .from(customerPoItemsTable)
    .where(eq(customerPoItemsTable.customerPoId, id));
  res.json({
    ...serialize(updated, itemRows.length),
    items: itemRows.map((i) => ({
      id: i.id,
      customerPoId: i.customerPoId,
      customerRfqId: i.customerRfqId,
      customerRfqItemId: i.customerRfqItemId,
      partNo: i.partNo,
      lineItem: i.lineItem,
      description: i.description,
      uom: i.uom,
      qty: formatQty(i.qty),
      unitPrice: formatQty(i.unitPrice),
      total: computeTotal(i.qty, i.unitPrice),
      deliveryDate: i.deliveryDate,
      createdAt: i.createdAt.toISOString(),
    })),
  });
});

// DELETE /customer-po/:id — delete a draft
router.delete("/customer-po/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [existing] = await db.select().from(customerPosTable).where(eq(customerPosTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (existing.status !== "draft") {
    res.status(400).json({ error: "لا يمكن حذف أمر شراء العميل بعد إرساله" });
    return;
  }
  await db.delete(customerPosTable).where(eq(customerPosTable.id, id));
  await db.insert(auditLogTable).values({
    action: "customer_po.deleted",
    entityType: "customer_po",
    entityId: id,
    employeeId: req.session.employeeId,
    description: `Deleted draft customer PO ${existing.internalPoNo}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });
  res.status(204).end();
});

export default router;

import { Router } from "express";
import {
  db,
  customerPosTable,
  customerPoItemsTable,
  customerRfqsTable,
  employeesTable,
  auditLogTable,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
} from "@workspace/db";
import { eq, count, inArray, desc, sql, and, isNotNull } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";

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

// Resolve customer RFQ numbers for a set of po-item rows. Returns a map of
// customerRfqId -> customerRfqNo (only for non-null ids that exist).
async function resolveRfqNos(
  items: (typeof customerPoItemsTable.$inferSelect)[],
): Promise<Record<number, string>> {
  const ids = Array.from(
    new Set(items.map((i) => i.customerRfqId).filter((x): x is number => x != null)),
  );
  if (ids.length === 0) return {};
  const rows = await db
    .select({ id: customerRfqsTable.id, no: customerRfqsTable.customerRfqNo })
    .from(customerRfqsTable)
    .where(inArray(customerRfqsTable.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.no]));
}

// ── Fulfillment status ───────────────────────────────────────────────────────
// A derived, progressive status for a customer PO that reflects the supplier
// purchase orders issued for it and the deliveries made to the customer. It is
// computed on every list/detail fetch (never stored), so it advances
// automatically when a supplier PO is dispatched from /purchase-orders, when a
// receipt is recorded from the supplier, or when a delivery is recorded from the
// customer-deliveries page.
//
// Stages (most advanced wins):
//   draft           — the customer PO is not yet finalized (status="draft").
//   sent            — finalized (status="sent") but no supplier PO dispatched yet.
//   po_issued       — at least one dispatched (status="sent") supplier PO is linked
//                     to this customer PO (via purchase_order_items.customerPoItemId,
//                     or, as a header-level fallback, sheetPoNo = customerPoNo).
//   ready_to_deliver — some line items have been received from the supplier
//                     (linked supplier PO item accepted) but none delivered yet.
//                     receivedPct = receivedItems/totalItems.
//   delivered       — deliveries recorded; partial when resolvedPct < 100.
//   fulfilled       — every line item is resolved (delivered OR rejected by the
//                     customer); resolvedPct = 100.
export interface CustomerPoFulfillmentStatus {
  stage: "draft" | "sent" | "po_issued" | "ready_to_deliver" | "delivered" | "fulfilled";
  label: string;
  poIssued: boolean;
  totalItems: number;
  receivedItems: number;
  receivedPct: number | null;
  deliveredItems: number;
  deliveredPct: number | null;
}

function buildFulfillmentStatus(input: {
  storedStatus: string;
  poIssued: boolean;
  totalItems: number;
  receivedItems: number;
  deliveredItems: number;
  rejectedItems: number;
}): CustomerPoFulfillmentStatus {
  const { storedStatus, poIssued, totalItems, receivedItems, deliveredItems, rejectedItems } = input;
  const receivedPct =
    totalItems > 0 ? Math.round((receivedItems / totalItems) * 100) : null;
  // A line is "resolved" when it's either delivered or the customer rejected it
  // (both are terminal outcomes — the order is settled for that line).
  const resolvedItems = deliveredItems + rejectedItems;
  const resolvedPct =
    totalItems > 0 ? Math.round((resolvedItems / totalItems) * 100) : null;

  let stage: CustomerPoFulfillmentStatus["stage"] = "draft";
  let label = "مسودة";

  if (storedStatus === "draft" && !poIssued && receivedItems === 0 && resolvedItems === 0) {
    stage = "draft";
    label = "مسودة";
  } else if (resolvedPct != null && resolvedItems > 0) {
    if (resolvedPct >= 100) {
      stage = "fulfilled";
      label = "اكتمل";
    } else {
      stage = "delivered";
      label = `تم تنفيذه ${resolvedPct}%`;
    }
  } else if (receivedItems > 0) {
    stage = "ready_to_deliver";
    label = `جاهز للتسليم ${receivedPct ?? 0}%`;
  } else if (poIssued) {
    stage = "po_issued";
    label = "تم إصدار أمر شراء للمورد";
  } else if (storedStatus === "sent") {
    stage = "sent";
    label = "تم الإرسال";
  } else {
    stage = "draft";
    label = "مسودة";
  }

  return { stage, label, poIssued, totalItems, receivedItems, receivedPct, deliveredItems, deliveredPct: resolvedPct };
}

// Resolve, for a set of customer PO ids, the ids that have at least one
// DISPATCHED (status="sent") supplier PO linked to them. A supplier PO links to
// a customer PO either through its items (purchase_order_items.customerPoItemId
// → customer_po_items.customerPoId) or, as a header-level fallback for legacy
// rows created before the item FK existed, through sheetPoNo = customerPoNo.
async function resolvePoIssuedIds(
  customerPoIds: number[],
  customerPoNoByPoId: Map<number, string>,
): Promise<Set<number>> {
  const issued = new Set<number>();
  if (customerPoIds.length === 0) return issued;

  // 1) Item-level link: dispatched supplier POs whose items reference a
  //    customer_po_item belonging to one of these customer POs. We join
  //    purchase_order_items → purchase_orders (for the sent filter) AND
  //    → customer_po_items (so customer_po_items.customer_po_id is available
  //    to map the hit back to the owning customer PO).
  const linked = await db
    .select({ customerPoId: customerPoItemsTable.customerPoId })
    .from(purchaseOrderItemsTable)
    .innerJoin(
      purchaseOrdersTable,
      eq(purchaseOrderItemsTable.poId, purchaseOrdersTable.id),
    )
    .innerJoin(
      customerPoItemsTable,
      eq(purchaseOrderItemsTable.customerPoItemId, customerPoItemsTable.id),
    )
    .where(
      and(
        eq(purchaseOrdersTable.status, "sent"),
        isNotNull(purchaseOrderItemsTable.customerPoItemId),
        inArray(customerPoItemsTable.customerPoId, customerPoIds),
      ),
    );
  for (const r of linked) {
    if (r.customerPoId != null) issued.add(r.customerPoId);
  }

  // 2) Header-level fallback: dispatched supplier POs whose sheetPoNo matches a
  //    listed customer PO's customerPoNo (case-insensitive). Covers legacy
  //    supplier POs created before the item FK was wired.
  const poNos = new Set(
    [...customerPoNoByPoId.values()].map((n) => n.toLowerCase()),
  );
  if (poNos.size > 0) {
    const dispatched = await db
      .select({ sheetPoNo: purchaseOrdersTable.sheetPoNo })
      .from(purchaseOrdersTable)
      .where(eq(purchaseOrdersTable.status, "sent"));
    const matchedPoNos = new Set<string>();
    for (const r of dispatched) {
      if (r.sheetPoNo && poNos.has(r.sheetPoNo.toLowerCase())) {
        matchedPoNos.add(r.sheetPoNo.toLowerCase());
      }
    }
    for (const [poId, no] of customerPoNoByPoId) {
      if (matchedPoNos.has(no.toLowerCase())) issued.add(poId);
    }
  }

  return issued;
}

// For a set of customer PO ids, load all their line items (with deliveryStatus)
// and return per-PO totals: total items, delivered items, and customer-rejected
// items counts.
async function resolveDeliveryRollup(
  customerPoIds: number[],
): Promise<Map<number, { totalItems: number; deliveredItems: number; rejectedItems: number }>> {
  const map = new Map<number, { totalItems: number; deliveredItems: number; rejectedItems: number }>();
  if (customerPoIds.length === 0) return map;
  const rows = await db
    .select({
      customerPoId: customerPoItemsTable.customerPoId,
      deliveryStatus: customerPoItemsTable.deliveryStatus,
    })
    .from(customerPoItemsTable)
    .where(inArray(customerPoItemsTable.customerPoId, customerPoIds));
  for (const r of rows) {
    if (r.customerPoId == null) continue; // detached (removed) row — not on any PO
    const entry = map.get(r.customerPoId) ?? { totalItems: 0, deliveredItems: 0, rejectedItems: 0 };
    entry.totalItems += 1;
    if (r.deliveryStatus === "delivered") entry.deliveredItems += 1;
    else if (r.deliveryStatus === "rejected") entry.rejectedItems += 1;
    map.set(r.customerPoId, entry);
  }
  return map;
}

/**
 * For a set of customer PO ids, count how many of each PO's line items have been
 * RECEIVED from the supplier (i.e. a linked purchase_order_item was accepted —
 * line_status fulfilled/partial with total_accepted_qty > 0). A customer_po_item
 * links to a supplier PO item via purchase_order_items.customer_po_item_id, with
 * a header-level fallback (sheetPoNo = customerPoNo) + lineItem match.
 * Returns a map of customerPoId → receivedItems count.
 */
async function resolveReceivedRollup(
  customerPoIds: number[],
  customerPoNoByPoId: Map<number, string>,
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (customerPoIds.length === 0) return map;

  // 1) Item-level link: customer_po_items that have a linked purchase_order_item
  //    with accepted qty > 0.
  const linked = await db
    .select({
      customerPoId: customerPoItemsTable.customerPoId,
      customerPoItemId: customerPoItemsTable.id,
      lineStatus: purchaseOrderItemsTable.lineStatus,
      acceptedQty: purchaseOrderItemsTable.totalAcceptedQty,
    })
    .from(customerPoItemsTable)
    .innerJoin(
      purchaseOrderItemsTable,
      eq(purchaseOrderItemsTable.customerPoItemId, customerPoItemsTable.id),
    )
    .where(inArray(customerPoItemsTable.customerPoId, customerPoIds));
  const receivedItemIds = new Set<number>();
  for (const r of linked) {
    const accepted = r.acceptedQty ? Number(r.acceptedQty) : 0;
    if (accepted > 0 && r.lineStatus !== "rejected") {
      receivedItemIds.add(r.customerPoItemId);
    }
  }

  // 2) Header-level fallback: for customer POs whose number matches a dispatched
  //    supplier PO's sheetPoNo, mark their items as received when a matching
  //    supplier PO item was accepted (matched by lineItem).
  const poNos = new Set(
    [...customerPoNoByPoId.values()].map((n) => n.toLowerCase()),
  );
  if (poNos.size > 0) {
    const dispatched = await db
      .select({
        sheetPoNo: purchaseOrdersTable.sheetPoNo,
        poId: purchaseOrdersTable.id,
      })
      .from(purchaseOrdersTable)
      .where(eq(purchaseOrdersTable.status, "sent"));
    const matchedPoIds: number[] = [];
    for (const d of dispatched) {
      if (d.sheetPoNo && poNos.has(d.sheetPoNo.toLowerCase())) matchedPoIds.push(d.poId);
    }
    if (matchedPoIds.length > 0) {
      const supplierItems = await db
        .select({
          poId: purchaseOrderItemsTable.poId,
          lineItem: purchaseOrderItemsTable.lineItem,
          lineStatus: purchaseOrderItemsTable.lineStatus,
          acceptedQty: purchaseOrderItemsTable.totalAcceptedQty,
        })
        .from(purchaseOrderItemsTable)
        .where(inArray(purchaseOrderItemsTable.poId, matchedPoIds));
      // Map poId → set of accepted lineItems.
      const acceptedByPo = new Map<number, Set<string>>();
      for (const si of supplierItems) {
        const accepted = si.acceptedQty ? Number(si.acceptedQty) : 0;
        if (accepted > 0 && si.lineStatus !== "rejected" && si.lineItem) {
          const set = acceptedByPo.get(si.poId) ?? new Set<string>();
          set.add(si.lineItem.trim());
          acceptedByPo.set(si.poId, set);
        }
      }
      // Map sheetPoNo(lower) → poId for the matched dispatched POs.
      const poIdByNo = new Map<string, number>();
      for (const d of dispatched) {
        if (d.sheetPoNo) poIdByNo.set(d.sheetPoNo.toLowerCase(), d.poId);
      }
      // For each listed customer PO matched by number, load its items and count
      // those whose lineItem matches an accepted supplier item.
      for (const [cpoId, cpoNo] of customerPoNoByPoId) {
        const spoId = poIdByNo.get(cpoNo.toLowerCase());
        const acceptedLines = spoId != null ? acceptedByPo.get(spoId) : undefined;
        if (!acceptedLines) continue;
        const cpoItems = await db
          .select({ id: customerPoItemsTable.id, lineItem: customerPoItemsTable.lineItem })
          .from(customerPoItemsTable)
          .where(eq(customerPoItemsTable.customerPoId, cpoId));
        for (const ci of cpoItems) {
          if (ci.lineItem && acceptedLines.has(ci.lineItem.trim())) {
            receivedItemIds.add(ci.id);
          }
        }
      }
    }
  }

  // Tally received items per customer PO from the collected item ids.
  const itemIdRows = await db
    .select({ id: customerPoItemsTable.id, customerPoId: customerPoItemsTable.customerPoId })
    .from(customerPoItemsTable)
    .where(inArray(customerPoItemsTable.customerPoId, customerPoIds));
  for (const r of itemIdRows) {
    if (r.customerPoId == null) continue; // detached (removed) row — not on any PO
    if (receivedItemIds.has(r.id)) {
      map.set(r.customerPoId, (map.get(r.customerPoId) ?? 0) + 1);
    }
  }
  return map;
}

// Compute the fulfillment status for a single customer PO (detail path).
async function computeFulfillmentStatus(
  customerPoId: number,
  storedStatus: string,
  customerPoNo: string,
  items: Array<{ deliveryStatus: string; lineItem?: string | null }>,
): Promise<CustomerPoFulfillmentStatus> {
  const totalItems = items.length;
  const deliveredItems = items.filter((i) => i.deliveryStatus === "delivered").length;
  const rejectedItems = items.filter((i) => i.deliveryStatus === "rejected").length;
  const poIssuedSet = await resolvePoIssuedIds(
    [customerPoId],
    new Map([[customerPoId, customerPoNo]]),
  );
  const receivedMap = await resolveReceivedRollup(
    [customerPoId],
    new Map([[customerPoId, customerPoNo]]),
  );
  return buildFulfillmentStatus({
    storedStatus,
    poIssued: poIssuedSet.has(customerPoId),
    totalItems,
    receivedItems: receivedMap.get(customerPoId) ?? 0,
    deliveredItems,
    rejectedItems,
  });
}

function serializeItem(
  i: typeof customerPoItemsTable.$inferSelect,
  rfqNoMap: Record<number, string>,
) {
  return {
    id: i.id,
    customerPoId: i.customerPoId,
    customerRfqId: i.customerRfqId,
    customerRfqItemId: i.customerRfqItemId,
    customerRfqNo: (i.customerRfqId != null ? rfqNoMap[i.customerRfqId] ?? null : null),
    partNo: i.partNo,
    lineItem: i.lineItem,
    description: i.description,
    uom: i.uom,
    qty: formatQty(i.qty),
    unitPrice: formatQty(i.unitPrice),
    total: computeTotal(i.qty, i.unitPrice),
    deliveryDate: i.deliveryDate,
    deliveryStatus: i.deliveryStatus,
    highlightColor: i.highlightColor,
    highlightNote: i.highlightNote,
    totalDeliveredQty: formatQty(i.totalDeliveredQty),
    totalRejectedByCustomerQty: formatQty(i.totalRejectedByCustomerQty),
    createdAt: i.createdAt.toISOString(),
  };
}

function serialize(
  r: typeof customerPosTable.$inferSelect,
  itemCount: number,
  fulfillmentStatus?: CustomerPoFulfillmentStatus,
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
    fulfillmentStatus: fulfillmentStatus ?? null,
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

  // Derived fulfillment status per PO (po_issued + receipt progress + delivery
  // progress). Computed in batch: one delivery rollup + one received rollup +
  // one po-issued resolution for all POs.
  const customerPoNoByPoId = new Map<number, string>();
  for (const r of filtered) customerPoNoByPoId.set(r.po.id, r.po.customerPoNo);
  const [deliveryRollup, receivedRollup, poIssuedSet] = await Promise.all([
    resolveDeliveryRollup(ids),
    resolveReceivedRollup(ids, customerPoNoByPoId),
    resolvePoIssuedIds(ids, customerPoNoByPoId),
  ]);

  res.json(
    filtered.map((r) => {
      const roll = deliveryRollup.get(r.po.id) ?? { totalItems: 0, deliveredItems: 0, rejectedItems: 0 };
      const fulfillment = buildFulfillmentStatus({
        storedStatus: r.po.status,
        poIssued: poIssuedSet.has(r.po.id),
        totalItems: roll.totalItems,
        receivedItems: receivedRollup.get(r.po.id) ?? 0,
        deliveredItems: roll.deliveredItems,
        rejectedItems: roll.rejectedItems,
      });
      return serialize(r.po, countMap[r.po.id] ?? 0, fulfillment);
    }),
  );
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

  const fulfillment = buildFulfillmentStatus({
    storedStatus: po.status,
    poIssued: false,
    totalItems: validItems.length,
    receivedItems: 0,
    deliveredItems: 0,
    rejectedItems: 0,
  });
  res.status(201).json(serialize(po, validItems.length, fulfillment));
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
  const rfqNoMap = await resolveRfqNos(items);
  const fulfillment = await computeFulfillmentStatus(id, po.status, po.customerPoNo, items);
  res.json({
    ...serialize(po, items.length, fulfillment),
    items: items.map((i) => serializeItem(i, rfqNoMap)),
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
  // Admins/managers may fully edit a sent PO (the portal gates the edit UI the
  // same way); everyone else is restricted to drafts.
  const canFullEditSent = req.session.role === "admin" || req.session.role === "manager";
  if (existing.status !== "draft" && !canFullEditSent) {
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

    // Removed (or no-longer-linked) items are NOT hard-deleted: their order
    // data (PO number, PO date, delivery status, rejection reason, manual
    // highlight + any recorded delivery history) must stay visible in the
    // items sheet view with the red-flag styling. We detach the row from this
    // PO, zero its qty/price and mark it "cancelled" so the «السبب» column
    // shows «إلغي» alongside the previously recorded rejection reason /
    // highlight note, while its quantities stop counting as active order
    // data. Kept items still get the old delete+re-insert treatment below.
    const previous = await db
      .select({
        id: customerPoItemsTable.id,
        customerRfqItemId: customerPoItemsTable.customerRfqItemId,
      })
      .from(customerPoItemsTable)
      .where(eq(customerPoItemsTable.customerPoId, id));
    const keptRfqItemIds = new Set(
      validItems.map((it) => it.customerRfqItemId).filter((x): x is number => x != null),
    );
    const removedIds = previous
      .filter((r) => r.customerRfqItemId == null || !keptRfqItemIds.has(r.customerRfqItemId))
      .map((r) => r.id);
    if (removedIds.length > 0) {
      await db
        .update(customerPoItemsTable)
        .set({
          customerPoId: null,
          qty: null,
          unitPrice: null,
          deliveryDate: null,
          deliveryStatus: "cancelled",
        })
        .where(inArray(customerPoItemsTable.id, removedIds));
      await db.delete(customerPoItemsTable).where(eq(customerPoItemsTable.customerPoId, id));
    }
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

  // Audit a privileged full edit of an already-sent (finalized) PO.
  if (existing.status !== "draft") {
    await db.insert(auditLogTable).values({
      action: "customer_po.sent_edit",
      entityType: "customer_po",
      entityId: id,
      employeeId: req.session.employeeId,
      description: `Edited sent customer PO (role: ${req.session.role ?? "unknown"}).`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
  }

  const [updated] = await db.select().from(customerPosTable).where(eq(customerPosTable.id, id));
  const itemRows = await db
    .select()
    .from(customerPoItemsTable)
    .where(eq(customerPoItemsTable.customerPoId, id));
  const rfqNoMap = await resolveRfqNos(itemRows);
  const fulfillment = await computeFulfillmentStatus(
    id,
    updated.status,
    updated.customerPoNo,
    itemRows,
  );
  res.json({
    ...serialize(updated, itemRows.length, fulfillment),
    items: itemRows.map((i) => serializeItem(i, rfqNoMap)),
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

// Highlight colors a row may be tinted with on the items sheet (/items).
// Kept tight so the frontend can map each one to a row background class.
const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "red", "orange", "purple"] as const;
type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

// PATCH /customer-po/items/:itemId/highlight — admin/accountant-only manual
// flag for a PO line: a row tint shown on `/items` (سجل البنود والطلبات) plus
// a free-form note surfaced in the «السبب» column there. Works on ANY PO
// (draft or sent — it is a visual flag, not a PO content change). Pass
// `{clear: true}` to remove the highlight.
router.patch(
  "/customer-po/items/:itemId/highlight",
  requireRole("admin", "accountant", "manager"),
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.itemId) ? req.params.itemId[0] : req.params.itemId;
    const itemId = parseInt(raw, 10);
    if (!Number.isFinite(itemId)) {
      res.status(400).json({ error: "معرّف بند غير صالح" });
      return;
    }

    const body = (req.body ?? {}) as {
      highlightColor?: string | null;
      highlightNote?: string | null;
      clear?: boolean;
    };
    const clear = body.clear === true || (body.highlightColor == null && body.highlightNote == null);

    let color: HighlightColor | null = null;
    let note: string | null = null;
    if (!clear) {
      if (!HIGHLIGHT_COLORS.includes(body.highlightColor as HighlightColor)) {
        res.status(400).json({
          error: `اللون يجب أن يكون أحد: ${HIGHLIGHT_COLORS.join(", ")}`,
        });
        return;
      }
      color = body.highlightColor as HighlightColor;
      note = body.highlightNote?.trim() || null;
    }

    const [item] = await db
      .select({ id: customerPoItemsTable.id, customerPoId: customerPoItemsTable.customerPoId })
      .from(customerPoItemsTable)
      .where(eq(customerPoItemsTable.id, itemId));
    if (!item) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    await db
      .update(customerPoItemsTable)
      .set({ highlightColor: color, highlightNote: note })
      .where(eq(customerPoItemsTable.id, itemId));

    await db.insert(auditLogTable).values({
      action: clear ? "customer_po_item.highlight_cleared" : "customer_po_item.highlighted",
      entityType: "customer_po_item",
      entityId: itemId,
      employeeId: req.session.employeeId,
      description: clear
        ? `Cleared highlight on customer PO item ${itemId}`
        : `Highlighted customer PO item ${itemId} (${color})${note ? `: ${note}` : ""}`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    res.json({ ok: true, itemId, highlightColor: color, highlightNote: note });
  },
);

export default router;

import { Router } from "express";
import {
  db,
  customerRfqsTable,
  customerRfqItemsTable,
  customersTable,
  employeesTable,
  rfqItemsTable,
  offerItemsTable,
  auditLogTable,
  customerPoItemsTable,
  customerPosTable,
  customerPoItemDeliveriesTable,
  purchaseOrderItemsTable,
} from "@workspace/db";
import { eq, ilike, count, inArray, desc, asc, and, isNull, or, isNotNull } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";

const router = Router();

// VAT rate — must match the rfq module (used to normalize tax-inclusive
// supplier prices to excl-tax for the margin check).
const VAT_RATE = 0.14;
// Required margin: the customer price (excl tax) must be at least this factor
// times the approved supplier price (excl tax) — prevents pricing at a loss.
const MARGIN_FACTOR = 1.06;

// For each customer RFQ item, resolve the approved supplier price (excl tax)
// via the rfq_items.customer_rfq_item_id link, falling back to partNo/lineItem
// matching for legacy supplier RFQs that lack the FK link. Returns a map
// customerItemId -> { costExclTax (min approved) | null, hasApproved }.
async function resolveApprovedCosts(
  customerItems: Array<{ id: number; partNo: string | null; lineItem: string | null }>,
): Promise<Map<number, number | null>> {
  const result = new Map<number, number | null>();
  if (customerItems.length === 0) return result;

  const ids = customerItems.map((i) => i.id);
  // Approved offer items linked directly via the FK.
  const linked = await db
    .select({
      customerRfqItemId: rfqItemsTable.customerRfqItemId,
      price: offerItemsTable.price,
      taxIncluded: offerItemsTable.taxIncluded,
    })
    .from(offerItemsTable)
    .innerJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
    .where(
      and(inArray(rfqItemsTable.customerRfqItemId, ids), eq(offerItemsTable.isApproved, true)),
    );

  const byCustomerItem = new Map<number, number[]>();
  for (const row of linked) {
    if (row.customerRfqItemId == null) continue;
    const price = parseFloat(row.price);
    const excl = row.taxIncluded ? price / (1 + VAT_RATE) : price;
    const arr = byCustomerItem.get(row.customerRfqItemId) ?? [];
    arr.push(excl);
    byCustomerItem.set(row.customerRfqItemId, arr);
  }

  for (const ci of customerItems) {
    const approved = byCustomerItem.get(ci.id);
    if (approved && approved.length > 0) {
      result.set(ci.id, Math.min(...approved));
      continue;
    }
    // Fallback: match by partNo (priority) or lineItem for legacy rfq_items
    // that have no customer_rfq_item_id link.
    const key = ci.partNo?.trim() || ci.lineItem?.trim();
    if (!key) {
      result.set(ci.id, null);
      continue;
    }
    const partMatch = ci.partNo?.trim() ? eq(rfqItemsTable.partNo, ci.partNo.trim()) : null;
    const lineMatch = ci.lineItem?.trim() ? eq(rfqItemsTable.lineItem, ci.lineItem.trim()) : null;
    const matchCond = partMatch && lineMatch ? or(partMatch, lineMatch) : (partMatch ?? lineMatch);
    if (!matchCond) {
      result.set(ci.id, null);
      continue;
    }
    const fallback = await db
      .select({ price: offerItemsTable.price, taxIncluded: offerItemsTable.taxIncluded })
      .from(offerItemsTable)
      .innerJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
      .where(
        and(
          matchCond,
          isNull(rfqItemsTable.customerRfqItemId),
          eq(offerItemsTable.isApproved, true),
        ),
      );
    if (fallback.length > 0) {
      const excl = fallback.map((f) =>
        f.taxIncluded ? parseFloat(f.price) / (1 + VAT_RATE) : parseFloat(f.price),
      );
      result.set(ci.id, Math.min(...excl));
    } else {
      result.set(ci.id, null);
    }
  }
  return result;
}

// Generate internal customer-RFQ number: CRFQ-YYYY-NNNNNN
async function generateInternalNo(): Promise<string> {
  const year = new Date().getFullYear();
  const [result] = await db.select({ cnt: count() }).from(customerRfqsTable);
  const seq = String((result?.cnt ?? 0) + 1).padStart(6, "0");
  return `CRFQ-${year}-${seq}`;
}

// Trim trailing zeros from a NUMERIC qty so "3.0000" reads as "3", "3.5000" as "3.5".
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

// ── Request status (حالة الطلب) ───────────────────────────────────────────────
// A derived, progressive status shown on the customer-RFQ list/detail. It rolls
// up four milestones across several tables:
//   1. received   — the RFQ exists (default).
//   2. supplierPriced — at least one offer_item with is_approved=true links to an
//      item of this RFQ (via rfq_items.customer_rfq_item_id, with partNo/lineItem
//      fallback for legacy rows).
//   3. customerPricedPct — share of this RFQ's items that carry a customer
//      unit_price > 0.
//   4. poIssued / deliveredPct — whether a customer PO was issued for any item,
//      and (via customer_po_items.total_delivered_qty) the share of PO'd items
//      that have been (fully or partially) delivered to the customer.
//
// When the close date (expiryDate) has passed and the request never progressed
// past "received" (no item was priced by supplier or customer, no PO issued),
// the stage becomes "expired" (فشل/منتهي) — a failed request.
//
// The headline label prefers the most advanced milestone reached, while the
// numeric fields let the UI render a richer badge ("مسعَّر 60%").
export interface CustomerRfqRequestStatus {
  // Machine-readable headline stage:
  // received | supplier_priced | customer_priced | po_issued | delivered | failed | expired
  stage: string;
  // Arabic label ready to display, e.g. "طلب وارد", "مسعَّر من المورد", "مسعَّر 50%", "صدر أمر شراء", "نجح 60%", "نجح بالكامل", "فشل", "منتهي (فشل)"
  label: string;
  // True when at least one approved supplier offer exists for an item of this RFQ.
  supplierPriced: boolean;
  // Share (0–100) of this RFQ's items priced for the customer (unit_price > 0).
  customerPricingPct: number | null;
  // True when any customer_po_items row links back to an item (or the RFQ) of this RFQ.
  poIssued: boolean;
  // Set of customer_rfq_item_ids that already appear on a customer PO — used to
  // highlight rows green inside the detail page.
  poItemIds: number[];
  // Share (0–100) of PO'd items successfully delivered to the customer. A
  // customer-rejected or supplier-receipt-rejected item does NOT count as
  // delivered. Null when no PO was issued.
  deliveredPct: number | null;
  // True when at least one PO'd item was rejected (by the customer at delivery
  // OR by the rep at supplier receipt) and NONE were delivered → the request failed.
  failed: boolean;
}

// Resolve the approved-supplier-priced flag per RFQ item id. Reuses the same
// join as resolveApprovedCosts but only needs the set of item ids that have ANY
// approved offer_item (we don't care about the price here).
//
// `withLegacyFallback` runs a per-item partNo/lineItem match for items that have
// no FK link to a supplier rfq_item. It is O(N) in the number of unlinked items
// (one query each), so it is only safe for a SINGLE RFQ's handful of items —
// never the list view (which loads every item of every listed RFQ).
async function resolveSupplierPricedItemIds(
  customerItems: Array<{ id: number; partNo: string | null; lineItem: string | null }>,
  withLegacyFallback = true,
): Promise<Set<number>> {
  const priced = new Set<number>();
  if (customerItems.length === 0) return priced;

  const ids = customerItems.map((i) => i.id);
  const linked = await db
    .select({ customerRfqItemId: rfqItemsTable.customerRfqItemId })
    .from(offerItemsTable)
    .innerJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
    .where(
      and(inArray(rfqItemsTable.customerRfqItemId, ids), eq(offerItemsTable.isApproved, true)),
    );
  for (const row of linked) {
    if (row.customerRfqItemId != null) priced.add(row.customerRfqItemId);
  }

  if (!withLegacyFallback) return priced;

  // Legacy fallback: items with no FK link, matched by partNo/lineItem.
  const unlinked = customerItems.filter((ci) => !priced.has(ci.id));
  for (const ci of unlinked) {
    const key = ci.partNo?.trim() || ci.lineItem?.trim();
    if (!key) continue;
    const partMatch = ci.partNo?.trim() ? eq(rfqItemsTable.partNo, ci.partNo.trim()) : null;
    const lineMatch = ci.lineItem?.trim() ? eq(rfqItemsTable.lineItem, ci.lineItem.trim()) : null;
    const matchCond = partMatch && lineMatch ? or(partMatch, lineMatch) : (partMatch ?? lineMatch);
    if (!matchCond) continue;
    const fallback = await db
      .select({ id: offerItemsTable.id })
      .from(offerItemsTable)
      .innerJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
      .where(
        and(
          matchCond,
          isNull(rfqItemsTable.customerRfqItemId),
          eq(offerItemsTable.isApproved, true),
        ),
      );
    if (fallback.length > 0) priced.add(ci.id);
  }
  return priced;
}

// True when the customer RFQ's close date (expiryDate, a free-text YYYY-MM-DD
// or similar parseable date) is in the past. Used to mark requests that passed
// their close date with no pricing as "expired" (failed). A non-parseable or
// missing expiryDate is never considered expired.
function hasExpired(expiryDate: string | null): boolean {
  if (!expiryDate) return false;
  const d = new Date(expiryDate);
  if (Number.isNaN(d.getTime())) return false;
  // Compare against the start of today so the whole close day stays valid.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() < today.getTime();
}

// True when the customer RFQ's close date has ARRIVED — i.e. it is today or in
// the past (inclusive of the whole close day). This is the gate for re-pricing
// a sent (finalized) customer RFQ: on the close day itself the operator may
// already enter/adjust customer prices (the close day is the natural moment to
// price). Stricter than hasExpired only in that it includes today. A
// non-parseable or missing expiryDate is never considered reached.
function closeDateReached(expiryDate: string | null): boolean {
  if (!expiryDate) return false;
  const d = new Date(expiryDate);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() <= today.getTime();
}

// For a single RFQ: load its items + the cross-table milestones and return the
// derived request status. Used by GET /:id (detail) and as a one-off helper.
async function computeRequestStatusForRfq(
  rfqId: number,
  expiryDate: string | null = null,
): Promise<{
  status: CustomerRfqRequestStatus;
  items: (typeof customerRfqItemsTable.$inferSelect)[];
}> {
  const items = await db
    .select()
    .from(customerRfqItemsTable)
    .where(eq(customerRfqItemsTable.customerRfqId, rfqId));

  const itemIds = items.map((i) => i.id);
  const totalItems = items.length;

  // 2) supplier-priced: any approved offer for an item of this RFQ.
  const supplierPricedIds = await resolveSupplierPricedItemIds(
    items.map((i) => ({ id: i.id, partNo: i.partNo, lineItem: i.lineItem })),
  );
  const supplierPriced = supplierPricedIds.size > 0;

  // 3) customer-priced share: items with unit_price > 0.
  let customerPricingPct: number | null = null;
  if (totalItems > 0) {
    const priced = items.filter((i) => i.unitPrice != null && Number(i.unitPrice) > 0).length;
    customerPricingPct = Math.round((priced / totalItems) * 100);
  }

  // 4) PO issued + delivered share.
  let poIssued = false;
  let poItemIds: number[] = [];
  let deliveredPct: number | null = null;
  let failed = false;
  if (itemIds.length > 0) {
    const poRows = await db
      .select({
        customerRfqItemId: customerPoItemsTable.customerRfqItemId,
        customerPoItemId: customerPoItemsTable.id,
        totalDeliveredQty: customerPoItemsTable.totalDeliveredQty,
        totalRejectedByCustomerQty: customerPoItemsTable.totalRejectedByCustomerQty,
        deliveryStatus: customerPoItemsTable.deliveryStatus,
        qty: customerPoItemsTable.qty,
      })
      .from(customerPoItemsTable)
      .where(
        and(
          inArray(customerPoItemsTable.customerRfqItemId, itemIds),
          isNotNull(customerPoItemsTable.customerRfqItemId),
        ),
      );

    // For the supplier-receipt-rejection check: load the linked purchase_order
    // items' line status for these customer_po_items.
    const cpoItemIds = poRows.map((r) => r.customerPoItemId);
    const supplierLineStatusByCpoItemId = new Map<number, string>();
    if (cpoItemIds.length > 0) {
      const supplierRows = await db
        .select({
          customerPoItemId: purchaseOrderItemsTable.customerPoItemId,
          lineStatus: purchaseOrderItemsTable.lineStatus,
          acceptedQty: purchaseOrderItemsTable.totalAcceptedQty,
        })
        .from(purchaseOrderItemsTable)
        .where(inArray(purchaseOrderItemsTable.customerPoItemId, cpoItemIds));
      for (const s of supplierRows) {
        if (s.customerPoItemId != null) {
          const accepted = s.acceptedQty ? Number(s.acceptedQty) : 0;
          // A supplier line rejected at receipt (and nothing accepted) = failure.
          if (s.lineStatus === "rejected" && accepted <= 0) {
            supplierLineStatusByCpoItemId.set(s.customerPoItemId, "rejected");
          }
        }
      }
    }

    const poItemIdSet = new Set<number>();
    let deliveredItems = 0;
    let rejectedItems = 0;
    const poCount = poRows.length;
    for (const r of poRows) {
      if (r.customerRfqItemId != null) poItemIdSet.add(r.customerRfqItemId);
      const ordered = r.qty != null ? Number(r.qty) : 0;
      const delivered = r.totalDeliveredQty != null ? Number(r.totalDeliveredQty) : 0;
      // Delivered to customer = actual success (customer received the goods).
      if (r.deliveryStatus === "delivered" || (ordered > 0 && delivered >= ordered)) {
        deliveredItems += 1;
      }
      // Failed = customer rejected the delivery OR the supplier receipt was rejected.
      else if (
        r.deliveryStatus === "rejected" ||
        supplierLineStatusByCpoItemId.get(r.customerPoItemId) === "rejected"
      ) {
        rejectedItems += 1;
      }
    }
    poItemIds = [...poItemIdSet];
    poIssued = poCount > 0;
    if (poCount > 0) {
      // نجح % counts only successfully delivered items; rejections are NOT success.
      deliveredPct = Math.round((deliveredItems / poCount) * 100);
      // The request FAILED when items were rejected but none delivered.
      failed = deliveredItems === 0 && rejectedItems > 0;
    }
  }

  return {
    status: buildRequestStatus({
      supplierPriced,
      customerPricingPct,
      poIssued,
      poItemIds,
      deliveredPct,
      failed,
      expiryDate,
    }),
    items,
  };
}

// Build the headline stage + label from the resolved milestone flags.
function buildRequestStatus(input: {
  supplierPriced: boolean;
  customerPricingPct: number | null;
  poIssued: boolean;
  poItemIds: number[];
  deliveredPct: number | null;
  failed: boolean;
  expiryDate?: string | null;
}): CustomerRfqRequestStatus {
  const {
    supplierPriced,
    customerPricingPct,
    poIssued,
    poItemIds,
    deliveredPct,
    failed,
    expiryDate,
  } = input;

  let stage = "received";
  let label = "طلب وارد";

  if (poIssued) {
    if (failed) {
      // Items were rejected (at delivery or supplier receipt) and NONE were
      // delivered → the request did not succeed.
      stage = "failed";
      label = "فشل";
    } else if (deliveredPct != null && deliveredPct > 0) {
      stage = "delivered";
      label = deliveredPct >= 100 ? "نجح بالكامل" : `نجح ${deliveredPct}%`;
    } else {
      stage = "po_issued";
      label = "صدر أمر شراء";
    }
  } else if (customerPricingPct != null && customerPricingPct > 0) {
    stage = "customer_priced";
    label = customerPricingPct >= 100 ? "مُسعَّر بالكامل" : `مُسعَّر ${customerPricingPct}%`;
  } else if (supplierPriced) {
    stage = "supplier_priced";
    label = "مُسعَّر من المورد";
  } else if (hasExpired(expiryDate ?? null)) {
    // The close date passed with no item priced (no supplier offer, no customer
    // price, no PO) — the request failed without ever progressing.
    stage = "expired";
    label = "منتهي (فشل)";
  }

  return {
    stage,
    label,
    supplierPriced,
    customerPricingPct,
    poIssued,
    poItemIds,
    deliveredPct,
    failed,
  };
}

function serialize(r: typeof customerRfqsTable.$inferSelect, itemCount: number) {
  return {
    id: r.id,
    internalNo: r.internalNo,
    customerId: r.customerId,
    customerName: r.customerName,
    customerRfqNo: r.customerRfqNo,
    numberAutoGenerated: r.numberAutoGenerated,
    entryDate: r.entryDate,
    expiryDate: r.expiryDate,
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

// GET /customer-rfq — list with optional search
router.get("/customer-rfq", requireAuth, async (req, res): Promise<void> => {
  const { search, status } = req.query as Record<string, string>;

  const rows = await db
    .select({ rfq: customerRfqsTable })
    .from(customerRfqsTable)
    .orderBy(desc(customerRfqsTable.createdAt));

  let filtered = rows;
  if (status) filtered = filtered.filter((r) => r.rfq.status === status);
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.rfq.internalNo.toLowerCase().includes(s) ||
        r.rfq.customerRfqNo.toLowerCase().includes(s) ||
        r.rfq.customerName.toLowerCase().includes(s),
    );
  }

  const ids = filtered.map((r) => r.rfq.id);

  // Batch-load the items of every listed RFQ so we can compute the per-RFQ
  // request status without N+1 queries. We fetch: the items themselves (for the
  // customer-pricing share + partNo/lineItem for the supplier-price lookup),
  // the per-item counts, the approved offer_items links, and the PO/delivery
  // rollups — all keyed by customerRfqId.
  const allItems =
    ids.length > 0
      ? await db
          .select()
          .from(customerRfqItemsTable)
          .where(inArray(customerRfqItemsTable.customerRfqId, ids))
      : [];
  const itemsByRfq = new Map<number, (typeof allItems)[number][]>();
  for (const it of allItems) {
    const arr = itemsByRfq.get(it.customerRfqId) ?? [];
    arr.push(it);
    itemsByRfq.set(it.customerRfqId, arr);
  }
  const countMap = new Map<number, number>();
  for (const [rfqId, arr] of itemsByRfq) countMap.set(rfqId, arr.length);

  // 2) supplier-priced: which customer_rfq_item_ids have an approved offer_item.
  // List path uses only the FK-linked batch query — the per-item legacy
  // fallback is O(N) and would hang the page for large lists.
  const allItemIds = allItems.map((i) => i.id);
  const supplierPricedItemIds =
    allItemIds.length > 0
      ? await resolveSupplierPricedItemIds(
          allItems.map((i) => ({ id: i.id, partNo: i.partNo, lineItem: i.lineItem })),
          false,
        )
      : new Set<number>();

  // 4) PO issued + delivered share across all listed RFQs (single query).
  let poRowsByItem = new Map<
    number,
    {
      qty: string | null;
      totalDeliveredQty: string | null;
      totalRejectedByCustomerQty: string | null;
      deliveryStatus: string;
    }
  >();
  const supplierRejectedItemIds = new Set<number>();
  const cpoIdToRfqItem = new Map<number, number>();
  if (allItemIds.length > 0) {
    const poRows = await db
      .select({
        customerRfqItemId: customerPoItemsTable.customerRfqItemId,
        customerPoItemId: customerPoItemsTable.id,
        totalDeliveredQty: customerPoItemsTable.totalDeliveredQty,
        totalRejectedByCustomerQty: customerPoItemsTable.totalRejectedByCustomerQty,
        deliveryStatus: customerPoItemsTable.deliveryStatus,
        qty: customerPoItemsTable.qty,
      })
      .from(customerPoItemsTable)
      .where(
        and(
          inArray(customerPoItemsTable.customerRfqItemId, allItemIds),
          isNotNull(customerPoItemsTable.customerRfqItemId),
        ),
      );
    const cpoItemIds: number[] = [];
    for (const r of poRows) {
      if (r.customerRfqItemId == null) continue;
      cpoIdToRfqItem.set(r.customerPoItemId, r.customerRfqItemId);
      const existing = poRowsByItem.get(r.customerRfqItemId);
      if (!existing) {
        poRowsByItem.set(r.customerRfqItemId, {
          qty: r.qty,
          totalDeliveredQty: r.totalDeliveredQty,
          totalRejectedByCustomerQty: r.totalRejectedByCustomerQty,
          deliveryStatus: r.deliveryStatus,
        });
      }
      cpoItemIds.push(r.customerPoItemId);
    }
    if (cpoItemIds.length > 0) {
      const supplierRows = await db
        .select({
          customerPoItemId: purchaseOrderItemsTable.customerPoItemId,
          lineStatus: purchaseOrderItemsTable.lineStatus,
          acceptedQty: purchaseOrderItemsTable.totalAcceptedQty,
        })
        .from(purchaseOrderItemsTable)
        .where(inArray(purchaseOrderItemsTable.customerPoItemId, cpoItemIds));
      for (const s of supplierRows) {
        if (s.customerPoItemId == null) continue;
        const accepted = s.acceptedQty ? Number(s.acceptedQty) : 0;
        if (s.lineStatus === "rejected" && accepted <= 0) {
          const rfqItemId = cpoIdToRfqItem.get(s.customerPoItemId);
          if (rfqItemId != null) supplierRejectedItemIds.add(rfqItemId);
        }
      }
    }
  }

  res.json(
    filtered.map((r) => {
      const rfqItems = itemsByRfq.get(r.rfq.id) ?? [];
      const status = computeListRequestStatus(
        rfqItems,
        supplierPricedItemIds,
        poRowsByItem,
        supplierRejectedItemIds,
        r.rfq.expiryDate,
      );
      return { ...serialize(r.rfq, countMap.get(r.rfq.id) ?? 0), requestStatus: status };
    }),
  );
});

// Lighter per-RFQ request-status builder for the list view: takes the already-
// batched items + the supplier-priced id set + the PO/delivery map. Mirrors the
// milestone logic of computeRequestStatusForRfq but without re-querying.
function computeListRequestStatus(
  rfqItems: Array<{ id: number; unitPrice: string | null }>,
  supplierPricedItemIds: Set<number>,
  poRowsByItem: Map<
    number,
    {
      qty: string | null;
      totalDeliveredQty: string | null;
      totalRejectedByCustomerQty: string | null;
      deliveryStatus: string;
    }
  >,
  supplierRejectedItemIds: Set<number>,
  expiryDate: string | null,
): CustomerRfqRequestStatus {
  const totalItems = rfqItems.length;
  const supplierPriced = rfqItems.some((i) => supplierPricedItemIds.has(i.id));

  let customerPricingPct: number | null = null;
  if (totalItems > 0) {
    const priced = rfqItems.filter((i) => i.unitPrice != null && Number(i.unitPrice) > 0).length;
    customerPricingPct = Math.round((priced / totalItems) * 100);
  }

  let poIssued = false;
  let poItemIds: number[] = [];
  let deliveredPct: number | null = null;
  let failed = false;
  const poItems = rfqItems.filter((i) => poRowsByItem.has(i.id));
  if (poItems.length > 0) {
    poIssued = true;
    poItemIds = poItems.map((i) => i.id);
    let deliveredItems = 0;
    let rejectedItems = 0;
    for (const i of poItems) {
      const r = poRowsByItem.get(i.id)!;
      const ordered = r.qty != null ? Number(r.qty) : 0;
      const delivered = r.totalDeliveredQty != null ? Number(r.totalDeliveredQty) : 0;
      // Delivered to customer = success.
      if (r.deliveryStatus === "delivered" || (ordered > 0 && delivered >= ordered)) {
        deliveredItems += 1;
      }
      // Failed = customer rejected the delivery OR the supplier receipt was rejected.
      else if (r.deliveryStatus === "rejected" || supplierRejectedItemIds.has(i.id)) {
        rejectedItems += 1;
      }
    }
    // نجح % counts only successfully delivered items; rejections are NOT success.
    deliveredPct = Math.round((deliveredItems / poItems.length) * 100);
    failed = deliveredItems === 0 && rejectedItems > 0;
  }

  return buildRequestStatus({
    supplierPriced,
    customerPricingPct,
    poIssued,
    poItemIds,
    deliveredPct,
    failed,
    expiryDate,
  });
}

// GET /customer-rfq/numbers — all customer RFQ numbers (for the supplier-RFQ
// import combobox). Lets users pick a DB customer RFQ number instead of only
// Google-Sheet numbers; the lookup endpoint then fetches its items (DB first,
// sheet fallback).
router.get("/customer-rfq/numbers", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select({ customerRfqNo: customerRfqsTable.customerRfqNo })
    .from(customerRfqsTable)
    .orderBy(desc(customerRfqsTable.createdAt));
  res.json({ rfqNumbers: rows.map((r) => r.customerRfqNo) });
});

// GET /customer-rfq/sheet-view — a flat, denormalized view that reproduces the
// old single-sheet (Google Sheets "DATA" tab) layout: one row per customer
// RFQ line item, with the matching customer PO columns joined in the SAME row
// (poNo/poDate/poQty/poPrice) when a PO was issued for that item. The buyer
// name lives on the customer RFQ (employee at the customer's company). This is
// a read-only mirror of the legacy sheet, kept current as new data is entered.
//
// Query params: ?search=&limit=&offset=&<col>Exclude=v1,v2 (Excel-style)

// Columns that can be filtered/excluded via the autofilter. Order matches the
// sheet layout. Each entry maps a query-param name to the row field it reads.
const SHEET_FILTER_COLUMNS: { param: string; field: keyof EnrichedSheetRow }[] = [
  { param: "lineItem", field: "lineItem" },
  { param: "partNo", field: "partNo" },
  { param: "description", field: "description" },
  { param: "uom", field: "uom" },
  { param: "customerRfqNo", field: "customerRfqNo" },
  { param: "customerName", field: "customerName" },
  { param: "entryDate", field: "entryDate" },
  { param: "expiryDate", field: "expiryDate" },
  { param: "buyerName", field: "buyerName" },
  { param: "poNo", field: "poNo" },
  { param: "poDate", field: "poDate" },
  { param: "rfqQty", field: "rfqQty" },
  { param: "rfqUnitPrice", field: "rfqUnitPrice" },
  { param: "poQty", field: "poQty" },
  { param: "poUnitPrice", field: "poUnitPrice" },
  // flagReason is a computed column (rejection reason + cost overrun), not a
  // raw DB field — see computeFlagReason. Registered so the facets endpoint
  // lists its distinct values and the per-column filter applies to it.
  { param: "flagReason", field: "flagReason" },
];

type SheetRow = Awaited<ReturnType<typeof loadSheetRowsRaw>>[number];
// A SheetRow enriched with the computed flagReason — the shape loadSheetRows
// returns and the sheet-view/facets handlers consume.
type EnrichedSheetRow = SheetRow & { flagReason: string | null };

// Compute the red-flag reason for a row: "رفض التسليم: <reason>" when the
// customer delivery was rejected, and/or "تجاوزت التكلفة: ..." when the actual
// supplier cost exceeded the PO (supply-order) price. Returns null when the
// row is clean. `rejectionReasonByPoItemId` maps poItemId → latest reason.
function computeFlagReason(
  row: SheetRow,
  rejectionReasonByPoItemId: Map<number, string>,
): string | null {
  const reasons: string[] = [];
  if (row.deliveryStatus === "cancelled" && row.poItemId != null) {
    // Item was removed from (or cancelled with) its customer PO — the red
    // styling + previously recorded reasons (rejection/highlight) carry over.
    reasons.push("إلغي");
  } else if (row.deliveryStatus === "rejected" && row.poItemId != null) {
    reasons.push(`رفض التسليم: ${rejectionReasonByPoItemId.get(row.poItemId) ?? "رفض العميل"}`);
  }
  if (row.poFinalActualCost != null && row.poReferencePrice != null) {
    const actual = Number(row.poFinalActualCost);
    const poPrice = Number(row.poReferencePrice);
    if (isFinite(actual) && isFinite(poPrice) && poPrice > 0 && actual > poPrice + 1e-9) {
      reasons.push(
        `تجاوزت التكلفة: الفعلي ${formatQty(row.poFinalActualCost)} > أمر التوريد ${formatQty(row.poReferencePrice)}`,
      );
    }
  }
  return reasons.length > 0 ? reasons.join(" — ") : null;
}

async function loadSheetRowsRaw() {
  return (
    db
      .select({
        rfqItemId: customerRfqItemsTable.id,
        lineItem: customerRfqItemsTable.lineItem,
        partNo: customerRfqItemsTable.partNo,
        description: customerRfqItemsTable.description,
        uom: customerRfqItemsTable.uom,
        rfqQty: customerRfqItemsTable.qty,
        rfqUnitPrice: customerRfqItemsTable.unitPrice,
        customerRfqId: customerRfqsTable.id,
        customerRfqNo: customerRfqsTable.customerRfqNo,
        customerName: customerRfqsTable.customerName,
        entryDate: customerRfqsTable.entryDate,
        expiryDate: customerRfqsTable.expiryDate,
        buyerName: customerRfqsTable.buyerName,
        poItemId: customerPoItemsTable.id,
        poNo: customerPosTable.customerPoNo,
        poDate: customerPosTable.poDate,
        poQty: customerPoItemsTable.qty,
        poUnitPrice: customerPoItemsTable.unitPrice,
        deliveryStatus: customerPoItemsTable.deliveryStatus,
        // Manual highlight set on the customer PO line (admin/accountant):
        // row tint + note appended to the «السبب» column in the response.
        highlightColor: customerPoItemsTable.highlightColor,
        highlightNote: customerPoItemsTable.highlightNote,
        // Linked supplier PO item (for the cost-overrun check).
        poFinalActualCost: purchaseOrderItemsTable.finalActualCost,
        poReferencePrice: purchaseOrderItemsTable.referencePrice,
      })
      .from(customerRfqItemsTable)
      .innerJoin(customerRfqsTable, eq(customerRfqItemsTable.customerRfqId, customerRfqsTable.id))
      .leftJoin(
        customerPoItemsTable,
        eq(customerPoItemsTable.customerRfqItemId, customerRfqItemsTable.id),
      )
      .leftJoin(customerPosTable, eq(customerPoItemsTable.customerPoId, customerPosTable.id))
      .leftJoin(
        purchaseOrderItemsTable,
        eq(purchaseOrderItemsTable.customerPoItemId, customerPoItemsTable.id),
      )
      // Chronological by the visible request date (entryDate, a YYYY-MM-DD text
      // field → lexicographic == chronological). Oldest request = row 1 (top),
      // newest at the bottom; createdAt + item id are stable tie-breakers.
      // Postgres ASC puts NULL entryDate last (undated requests sink to bottom).
      .orderBy(
        asc(customerRfqsTable.entryDate),
        asc(customerRfqsTable.createdAt),
        asc(customerRfqItemsTable.id),
      )
  );
}

// Parse a column filter value list from the query string. The frontend sends
// the selected values as a JSON array (robust to commas or any character inside
// a value — e.g. a description "Widget, Blue" or a flagReason containing a
// comma). For backward compat, a plain comma-separated string is still accepted.
function parseValueList(raw: string): string[] {
  const s = raw.trim();
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v)).filter((v) => v.length > 0);
      }
    } catch {
      // fall through to comma-split
    }
  }
  return s
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

// Load all sheet rows and apply the Excel-style filters: a global OR `search`
// across the main text columns, plus per-column INCLUDE or EXCLUDE lists.
// `<col>Include=v1,v2` → show ONLY those values (empty → show none). Takes
// precedence over Exclude. `<col>Exclude=v1,v2` → hide those values. When
// `exceptColumn` is set, that column's filter is skipped — used by the
// facets endpoint so the filtered dropdown still lists every value the column
// could show once the OTHER columns are applied (Excel behavior).
// Returns rows enriched with the computed `flagReason` so the «السبب» column
// can be filtered/faceted like any other (it is not a raw DB field).
async function loadSheetRows(
  query: Record<string, string>,
  exceptColumn?: string,
): Promise<EnrichedSheetRow[]> {
  const rows = await loadSheetRowsRaw();

  // Batch-load the latest rejected-delivery reason per poItemId across ALL raw
  // rows (needed to compute flagReason). One query, regardless of pagination.
  const allPoItemIds = rows.map((r) => r.poItemId).filter((id): id is number => id != null);
  const rejectionReasonByPoItemId = new Map<number, string>();
  if (allPoItemIds.length > 0) {
    const rejectedRows = await db
      .select({
        customerPoItemId: customerPoItemDeliveriesTable.customerPoItemId,
        reason: customerPoItemDeliveriesTable.rejectionReason,
        createdAt: customerPoItemDeliveriesTable.createdAt,
      })
      .from(customerPoItemDeliveriesTable)
      .where(
        and(
          inArray(customerPoItemDeliveriesTable.customerPoItemId, allPoItemIds),
          eq(customerPoItemDeliveriesTable.deliveryStatus, "rejected"),
        ),
      )
      .orderBy(desc(customerPoItemDeliveriesTable.createdAt));
    for (const r of rejectedRows) {
      if (!rejectionReasonByPoItemId.has(r.customerPoItemId)) {
        rejectionReasonByPoItemId.set(r.customerPoItemId, r.reason ?? "رفض العميل");
      }
    }
  }

  // Enrich once with the computed flagReason so filtering + facets share it.
  let filtered: EnrichedSheetRow[] = rows.map((r) => ({
    ...r,
    flagReason: computeFlagReason(r, rejectionReasonByPoItemId),
  }));

  const search = query.search;
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        (r.lineItem ?? "").toLowerCase().includes(s) ||
        (r.partNo ?? "").toLowerCase().includes(s) ||
        (r.description ?? "").toLowerCase().includes(s) ||
        r.customerRfqNo.toLowerCase().includes(s) ||
        r.customerName.toLowerCase().includes(s) ||
        (r.poNo ?? "").toLowerCase().includes(s),
    );
  }

  for (const { param, field } of SHEET_FILTER_COLUMNS) {
    if (param === exceptColumn) continue;
    const includeRaw = query[`${param}Include`];
    if (includeRaw !== undefined) {
      // Include mode: show only these values. An empty list shows nothing.
      const includeSet = new Set(parseValueList(includeRaw));
      filtered = filtered.filter((r) => {
        const v = r[field];
        const cell = v == null ? "" : String(v);
        return includeSet.has(cell);
      });
      continue;
    }
    const excludeRaw = query[`${param}Exclude`];
    if (!excludeRaw) continue;
    const excludeSet = new Set(parseValueList(excludeRaw));
    if (excludeSet.size === 0) continue;
    filtered = filtered.filter((r) => {
      const v = r[field];
      const cell = v == null ? "" : String(v);
      return !excludeSet.has(cell);
    });
  }

  return filtered;
}

router.get("/customer-rfq/sheet-view", requireAuth, async (req, res): Promise<void> => {
  const { limit: limitQ, offset: offsetQ } = req.query as Record<string, string>;
  const limit = Math.min(Math.max(parseInt(limitQ || "100", 10) || 100, 1), 500);
  const offset = Math.max(parseInt(offsetQ || "0", 10) || 0, 0);

  const filtered = await loadSheetRows(req.query as Record<string, string>);
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);

  res.json({
    total,
    limit,
    offset,
    rows: page.map((r) => {
      // The «السبب» column = computed flags (rejection/cost-overrun) plus the
      // manually-set highlight note (appended with —).
      const flagReason = [r.flagReason, r.highlightNote].filter((s) => s != null).join(" — ") || null;
      return {
        rfqItemId: r.rfqItemId,
        lineItem: r.lineItem,
        partNo: r.partNo,
        description: r.description,
        uom: r.uom,
        rfqQty: formatQty(r.rfqQty),
        rfqUnitPrice: formatQty(r.rfqUnitPrice),
        customerRfqId: r.customerRfqId,
        customerRfqNo: r.customerRfqNo,
        customerName: r.customerName,
        entryDate: r.entryDate,
        expiryDate: r.expiryDate,
        buyerName: r.buyerName,
        poItemId: r.poItemId,
        poNo: r.poNo,
        poDate: r.poDate,
        poQty: formatQty(r.poQty),
        poUnitPrice: formatQty(r.poUnitPrice),
        flagged: flagReason != null,
        flagReason,
        highlightColor: r.highlightColor ?? null,
      };
    }),
  });
});

// GET /customer-rfq/sheet-view/facets — Excel-style autofilter dropdown values.
// Returns the distinct values (with counts) for one column, computed AFTER
// applying every OTHER column's filters — so the dropdown lists exactly the
// values that could still appear. Used by the per-column filter popover.
router.get("/customer-rfq/sheet-view/facets", requireAuth, async (req, res): Promise<void> => {
  const { column } = req.query as Record<string, string>;
  if (!column || !SHEET_FILTER_COLUMNS.some((c) => c.param === column)) {
    res.status(400).json({ error: "Invalid or missing column" });
    return;
  }
  const field = SHEET_FILTER_COLUMNS.find((c) => c.param === column)!.field;
  const filtered = await loadSheetRows(req.query as Record<string, string>, column);

  const counts = new Map<string, number>();
  for (const r of filtered) {
    // For «السبب», facet values must match the rendered cell: computed flag +
    // highlight note merged, exactly like the sheet-view response.
    const v =
      field === "flagReason"
        ? ([r.flagReason, r.highlightNote].filter((s) => s != null).join(" — ") || null)
        : r[field];
    const key = v == null ? "" : String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const values = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "ar"));

  res.json({ column, values });
});

// POST /customer-rfq — create a customer RFQ
router.post("/customer-rfq", requireAuth, async (req, res): Promise<void> => {
  const {
    customerId,
    customerName,
    customerRfqNo,
    entryDate,
    expiryDate,
    buyerName,
    notes,
    items,
  } = req.body as {
    customerId?: number | null;
    customerName?: string;
    customerRfqNo?: string;
    entryDate?: string;
    expiryDate?: string;
    buyerName?: string;
    notes?: string;
    items?: Array<{
      partNo?: string;
      lineItem?: string;
      description?: string;
      uom?: string;
      qty?: string | number | null;
      unitPrice?: string | number | null;
    }>;
  };

  if (!customerName?.trim()) {
    res.status(400).json({ error: "اسم العميل مطلوب" });
    return;
  }

  // Resolve customerId when the user picked a known customer but didn't pass the id.
  let resolvedCustomerId = customerId ?? null;
  if (!resolvedCustomerId) {
    const [match] = await db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(ilike(customersTable.name, customerName.trim()))
      .limit(1);
    if (match) resolvedCustomerId = match.id;
  }

  // Auto-generate the customer RFQ number when left empty.
  let finalRfqNo = customerRfqNo?.trim() ?? "";
  const autoGenerated = finalRfqNo === "";
  if (autoGenerated) {
    finalRfqNo = await generateInternalNo();
  }

  const internalNo = await generateInternalNo();

  // Resolve the creating employee's name (auto from the logged-in session).
  let employeeName: string | null = null;
  if (req.session.employeeId) {
    const [emp] = await db
      .select({ name: employeesTable.name })
      .from(employeesTable)
      .where(eq(employeesTable.id, req.session.employeeId));
    employeeName = emp?.name ?? null;
  }

  const [rfq] = await db
    .insert(customerRfqsTable)
    .values({
      internalNo,
      customerId: resolvedCustomerId,
      customerName: customerName.trim(),
      customerRfqNo: finalRfqNo,
      numberAutoGenerated: autoGenerated,
      entryDate: entryDate || null,
      expiryDate: expiryDate || null,
      buyerName: buyerName?.trim() || null,
      employeeId: req.session.employeeId ?? null,
      employeeName,
      status: "draft",
      notes: notes?.trim() || null,
    })
    .returning();

  let itemCount = 0;
  if (items && items.length > 0) {
    const validItems = items.filter((it) => (it.partNo?.trim() || it.lineItem?.trim()) && it.qty);
    if (validItems.length > 0) {
      await db.insert(customerRfqItemsTable).values(
        validItems.map((it) => ({
          customerRfqId: rfq.id,
          partNo: it.partNo?.trim() || null,
          // lineItem must contain no spaces — strip them automatically.
          lineItem: it.lineItem ? it.lineItem.replace(/\s+/g, "") : null,
          description: it.description?.trim() || null,
          uom: it.uom?.trim() || null,
          qty: it.qty != null && it.qty !== "" ? String(it.qty) : null,
          unitPrice: it.unitPrice != null && it.unitPrice !== "" ? String(it.unitPrice) : null,
        })),
      );
      itemCount = validItems.length;
    }
  }

  await db.insert(auditLogTable).values({
    action: "customer_rfq.created",
    entityType: "customer_rfq",
    entityId: rfq.id,
    employeeId: req.session.employeeId,
    description: `Created customer RFQ ${internalNo} for ${customerName.trim()}${
      autoGenerated ? ` (number auto-generated: ${finalRfqNo})` : ""
    } with ${itemCount} item(s)`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.status(201).json({ ...serialize(rfq, itemCount) });
});

// GET /customer-rfq/:id — single with items
router.get("/customer-rfq/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db
    .select({ rfq: customerRfqsTable })
    .from(customerRfqsTable)
    .where(eq(customerRfqsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Compute the derived request status (also loads the items for this RFQ).
  const { status: requestStatus, items } = await computeRequestStatusForRfq(id, row.rfq.expiryDate);
  const poItemIdSet = new Set(requestStatus.poItemIds);
  res.json({
    ...serialize(row.rfq, items.length),
    requestStatus,
    items: items.map((i) => ({
      id: i.id,
      customerRfqId: i.customerRfqId,
      partNo: i.partNo,
      lineItem: i.lineItem,
      description: i.description,
      uom: i.uom,
      qty: formatQty(i.qty),
      unitPrice: formatQty(i.unitPrice),
      total: computeTotal(i.qty, i.unitPrice),
      // True when this line item already appears on an issued customer PO —
      // the detail page highlights such rows green.
      hasPo: poItemIdSet.has(i.id),
      createdAt: i.createdAt.toISOString(),
    })),
  });
});

// PATCH /customer-rfq/:id — update a draft
router.patch("/customer-rfq/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [existing] = await db.select().from(customerRfqsTable).where(eq(customerRfqsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Admins/managers may fully edit a sent RFQ (the portal gates the edit UI
  // the same way). Everyone else falls back to the narrow prices-only branch.
  const canFullEditSent = req.session.role === "admin" || req.session.role === "manager";
  if (existing.status !== "draft" && !canFullEditSent) {
    // A sent (finalized) customer RFQ is normally immutable. Re-pricing the
    // customer unit prices is allowed in TWO commercial situations (so the
    // operator is never blocked by a forgotten/missing close date):
    //   1. the close date (expiryDate) has arrived (today or earlier), OR
    //   2. at least one item has an approved supplier offer (supplier-priced),
    //      i.e. the commercial event that should open customer pricing happened.
    // This is a prices-only update — header fields and item identity are not
    // touched, item ids (and their offer/PO links) are preserved, and the
    // margin check is NOT re-run (it already passed at finalize; this is a
    // manual re-price, audit-logged).
    const closeReached = closeDateReached(existing.expiryDate);
    const { status: existingStatus } = await computeRequestStatusForRfq(id, existing.expiryDate);
    const supplierPriced = existingStatus.supplierPriced;
    const allowReprice = closeReached || supplierPriced;
    const body = req.body as {
      customerName?: string;
      customerRfqNo?: string;
      entryDate?: string;
      expiryDate?: string;
      buyerName?: string;
      notes?: string;
      status?: string;
      items?: Array<{
        id?: number;
        partNo?: string;
        lineItem?: string;
        unitPrice?: string | number | null;
      }>;
    };
    const headerTouched =
      body.customerName !== undefined ||
      body.customerRfqNo !== undefined ||
      body.entryDate !== undefined ||
      body.expiryDate !== undefined ||
      body.buyerName !== undefined ||
      body.notes !== undefined ||
      body.status !== undefined;
    const pricesOnly =
      allowReprice &&
      !headerTouched &&
      Array.isArray(body.items) &&
      body.items.length > 0 &&
      body.items.every((it) => it.id != null);

    if (!pricesOnly) {
      res.status(400).json({ error: "لا يمكن تعديل طلب تسعير العميل بعد إرساله" });
      return;
    }

    // Update each item's unit_price by id, BUT ONLY when a price was actually
    // provided: the frontend renders one price input per current item and
    // sends null/undefined for anything untouched — a null here must NOT
    // clobber an existing price (the "prices wiped on save" bug on RFQ 2263).
    for (const it of body.items!) {
      if (it.unitPrice == null || it.unitPrice === "") continue;
      await db
        .update(customerRfqItemsTable)
        .set({ unitPrice: String(it.unitPrice) })
        .where(eq(customerRfqItemsTable.id, it.id as number));
    }
    await db.insert(auditLogTable).values({
      action: "customer_rfq.reprice",
      entityType: "customer_rfq",
      entityId: id,
      employeeId: req.session.employeeId,
      description: `Re-priced sent customer RFQ (reason: ${
        supplierPriced ? "supplier-priced" : "close-date-reached"
      }). ${body.items?.length ?? 0} item(s) updated.`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    const [updated] = await db.select().from(customerRfqsTable).where(eq(customerRfqsTable.id, id));
    const { status: requestStatus, items: itemRows } = await computeRequestStatusForRfq(
      id,
      updated.expiryDate,
    );
    const poItemIdSet = new Set(requestStatus.poItemIds);
    res.json({
      ...serialize(updated, itemRows.length),
      requestStatus,
      items: itemRows.map((i) => ({
        id: i.id,
        customerRfqId: i.customerRfqId,
        partNo: i.partNo,
        lineItem: i.lineItem,
        description: i.description,
        uom: i.uom,
        qty: formatQty(i.qty),
        unitPrice: formatQty(i.unitPrice),
        total: computeTotal(i.qty, i.unitPrice),
        hasPo: poItemIdSet.has(i.id),
        createdAt: i.createdAt.toISOString(),
      })),
    });
    return;
  }

  const {
    customerName,
    customerRfqNo,
    entryDate,
    expiryDate,
    buyerName,
    notes,
    status,
    items,
    overrideMarginCheck,
  } = req.body as {
    customerName?: string;
    customerRfqNo?: string;
    entryDate?: string;
    expiryDate?: string;
    buyerName?: string;
    notes?: string;
    status?: string;
    items?: Array<{
      partNo?: string;
      lineItem?: string;
      description?: string;
      uom?: string;
      qty?: string | number | null;
      unitPrice?: string | number | null;
    }>;
    overrideMarginCheck?: boolean;
  };

  const updates: Record<string, unknown> = {};
  if (customerName !== undefined) updates.customerName = customerName.trim();
  if (customerRfqNo !== undefined) {
    const trimmed = customerRfqNo.trim();
    if (trimmed === "") {
      // Number cleared on edit — regenerate an auto number and (re)flag it.
      updates.customerRfqNo = await generateInternalNo();
      updates.numberAutoGenerated = true;
    } else {
      updates.customerRfqNo = trimmed;
      updates.numberAutoGenerated = false;
    }
  }
  if (entryDate !== undefined) updates.entryDate = entryDate || null;
  if (expiryDate !== undefined) updates.expiryDate = expiryDate || null;
  if (buyerName !== undefined) updates.buyerName = buyerName?.trim() || null;
  if (notes !== undefined) updates.notes = notes?.trim() || null;

  // Finalizing (status → sent) requires every item to have a price, and every
  // priced item to clear the margin check against the approved supplier price.
  const validItems = items
    ? items.filter((it) => (it.partNo?.trim() || it.lineItem?.trim()) && it.qty)
    : undefined;

  // Prices preserved across the delete+recreate below, keyed by partNo/lineItem
  // because the request items carry no id (the frontend only fills unitPrice
  // for inputs it rendered and edited). Without this, any untouched item
  // comes back with unit_price = NULL (the "prices wiped on save" bug on the
  // live 2263 RFQ).
  let currentDbItemsForPricing: Array<{ id: number; partNo: string | null; lineItem: string | null; unitPrice: string | null }> | null = null;
  const loadCurrentDbItemsForPricing = async () => {
    if (currentDbItemsForPricing) return currentDbItemsForPricing;
    currentDbItemsForPricing = await db
      .select({
        id: customerRfqItemsTable.id,
        partNo: customerRfqItemsTable.partNo,
        lineItem: customerRfqItemsTable.lineItem,
        unitPrice: customerRfqItemsTable.unitPrice,
      })
      .from(customerRfqItemsTable)
      .where(eq(customerRfqItemsTable.customerRfqId, id));
    return currentDbItemsForPricing;
  };

  if (status === "sent" && validItems !== undefined) {
    const unpriced = validItems.filter(
      (it) => it.unitPrice == null || it.unitPrice === "" || Number(it.unitPrice) <= 0,
    );
    if (unpriced.length > 0) {
      res.status(400).json({ error: "أدخل سعر كل بند قبل تثبيت الطلب" });
      return;
    }

    // Margin check: each customer price (excl tax) must be ≥ 1.06 × the
    // approved supplier price (excl tax) for the matching item. The approved
    // cost is resolved via the customer_rfq_item_id link on rfq_items, with a
    // partNo/lineItem fallback for legacy supplier RFQs. An admin may override
    // (with audit logging); non-admins are blocked.
    const isAdmin = req.session.role === "admin";
    const overriding = overrideMarginCheck === true && isAdmin;

    // Current DB items carry the original ids that rfq_items link to (the
    // delete+recreate below would invalidate those ids, so resolve first).
    // The same rows (with prices) are reused by loadCurrentDbItemsForPricing
    // to preserve unchanged item prices across the recreate.
    const currentDbItems = await loadCurrentDbItemsForPricing();
    const costs = await resolveApprovedCosts(currentDbItems);

    // Map a req.body item to its current DB item id by partNo (priority) then lineItem.
    const findDbId = (it: { partNo?: string; lineItem?: string }): number | null => {
      const p = it.partNo?.trim();
      const l = it.lineItem?.trim();
      if (p) {
        const m = currentDbItems.find((d) => (d.partNo ?? "").trim() === p);
        if (m) return m.id;
      }
      if (l) {
        const m = currentDbItems.find((d) => (d.lineItem ?? "").trim() === l);
        if (m) return m.id;
      }
      return null;
    };

    const violations: string[] = [];
    for (const it of validItems) {
      const dbId = findDbId(it);
      const cost = dbId != null ? (costs.get(dbId) ?? null) : null;
      const customerPrice = Number(it.unitPrice);
      if (cost == null) {
        violations.push(`لا يوجد سعر مورد معتمد للبند (${it.partNo || it.lineItem})`);
      } else if (customerPrice < cost * MARGIN_FACTOR) {
        const minRequired = cost * MARGIN_FACTOR;
        violations.push(
          `سعر البند (${it.partNo || it.lineItem}) ${customerPrice.toFixed(2)} أقل من الحد الأدنى ${minRequired.toFixed(2)} (سعر المورد المعتمد ${cost.toFixed(2)} × 1.06)`,
        );
      }
    }

    if (violations.length > 0 && !overriding) {
      res.status(400).json({
        error: "تعذّر تثبيت الطلب: " + violations.join(" — "),
        marginViolations: violations,
      });
      return;
    }

    if (violations.length > 0 && overriding) {
      await db.insert(auditLogTable).values({
        action: "customer_rfq.margin_override",
        entityType: "customer_rfq",
        entityId: id,
        employeeId: req.session.employeeId,
        description: `Admin overrode margin check on finalize: ${violations.join(" | ")}`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });
    }

    updates.status = "sent";
  } else if (status !== undefined) {
    updates.status = status;
  }

  if (Object.keys(updates).length > 0) {
    await db.update(customerRfqsTable).set(updates).where(eq(customerRfqsTable.id, id));
  }

  // An empty items list is never valid on PATCH — accepting it would
  // delete every item of the RFQ (the "items vanished on save" report on
  // the live 2263 RFQ). Use DELETE /customer-rfq/:id to remove the request.
  if (items !== undefined && (!validItems || validItems.length === 0)) {
    res.status(400).json({ error: "لا يمكن حفظ الطلب بدون بنود" });
    return;
  }
  if (items !== undefined) {
    const preservingPrices = await loadCurrentDbItemsForPricing();
    const preservedPrice = (it: { partNo?: string; lineItem?: string }): string | null => {
      const p = it.partNo?.trim().toLowerCase();
      const l = it.lineItem?.replace(/\s+/g, "").trim().toLowerCase();
      for (const d of preservingPrices) {
        if (p && (d.partNo ?? "").trim().toLowerCase() === p) return d.unitPrice;
        if (l && (d.lineItem ?? "").replace(/\s+/g, "").trim().toLowerCase() === l) return d.unitPrice;
      }
      return null;
    };

    await db.delete(customerRfqItemsTable).where(eq(customerRfqItemsTable.customerRfqId, id));
    await db.insert(customerRfqItemsTable).values(
      validItems!.map((it) => {
        const explicitPrice = it.unitPrice != null && it.unitPrice !== "" ? String(it.unitPrice) : null;
        const price = explicitPrice ?? preservedPrice(it);
        return {
          customerRfqId: id,
          partNo: it.partNo?.trim() || null,
          lineItem: it.lineItem ? it.lineItem.replace(/\s+/g, "") : null,
          description: it.description?.trim() || null,
          uom: it.uom?.trim() || null,
          qty: it.qty != null && it.qty !== "" ? String(it.qty) : null,
          unitPrice: price,
        };
      }),
    );
  }

  // Audit a privileged full edit of an already-sent (finalized) RFQ.
  if (existing.status !== "draft") {
    await db.insert(auditLogTable).values({
      action: "customer_rfq.sent_edit",
      entityType: "customer_rfq",
      entityId: id,
      employeeId: req.session.employeeId,
      description: `Edited sent customer RFQ (role: ${req.session.role ?? "unknown"}).`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
  }

  const [updated] = await db.select().from(customerRfqsTable).where(eq(customerRfqsTable.id, id));
  // Recompute the derived status + per-item PO flag after the update so the UI
  // reflects the new pricing/PO state immediately.
  const { status: requestStatus, items: itemRows } = await computeRequestStatusForRfq(
    id,
    updated.expiryDate,
  );
  const poItemIdSet = new Set(requestStatus.poItemIds);
  res.json({
    ...serialize(updated, itemRows.length),
    requestStatus,
    items: itemRows.map((i) => ({
      id: i.id,
      customerRfqId: i.customerRfqId,
      partNo: i.partNo,
      lineItem: i.lineItem,
      description: i.description,
      uom: i.uom,
      qty: formatQty(i.qty),
      unitPrice: formatQty(i.unitPrice),
      total: computeTotal(i.qty, i.unitPrice),
      hasPo: poItemIdSet.has(i.id),
      createdAt: i.createdAt.toISOString(),
    })),
  });
});

// DELETE /customer-rfq/:id
router.delete("/customer-rfq/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [deleted] = await db
    .delete(customerRfqsTable)
    .where(eq(customerRfqsTable.id, id))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

export default router;

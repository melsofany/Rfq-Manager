import { Router } from "express";
import {
  db,
  customerRfqsTable,
  customerRfqItemsTable,
  customersTable,
  employeesTable,
  rfqTable,
  rfqItemsTable,
  offerItemsTable,
  auditLogTable,
  customerPoItemsTable,
  customerPosTable,
  customerPoItemDeliveriesTable,
  purchaseOrderItemsTable,
} from "@workspace/db";
import { eq, ilike, count, inArray, desc, and, isNull, or, isNotNull, sql, ne } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";

const router = Router();

// VAT rate — must match the rfq module (used to normalize tax-inclusive
// supplier prices to excl-tax for the margin check).
const VAT_RATE = 0.14;
// Required margin: the customer price (excl tax) must be at least this factor
// times the approved supplier price (excl tax) — prevents pricing at a loss.
const MARGIN_FACTOR = 1.06;

// Roles trusted with the actual supplier cost. The customer price is the price
// quoted TO THE CUSTOMER, so anyone else asking the API must never learn what
// the item costs us — not from an error message, not from a deviation figure
// derived from the cost, and not from the audit log either.
//
// PRICING access is a permission (`customer-rfq:price`), not a role: a manager
// can grant it to a specific employee from the employees page. Only `admin` is
// privileged unconditionally; `manager` is granted by default via
// PRICING_ROLE_DEFAULT (mirroring the portal's ROLE_DEFAULTS).
const PRICE_PERM_KEY = "customer-rfq:price";
const PRICING_ROLE_DEFAULT: Record<string, boolean> = { manager: true };

/**
 * Whether an employee may PRICE a customer RFQ (set a unit price / finalize).
 * Mirrors the portal's `resolvePermissions`: an explicit (non-empty) permission
 * map is authoritative; otherwise the role default applies. Kept in sync with
 * `artifacts/rfq-portal/src/lib/permissions.ts`.
 */
export function mayPriceCustomerRfq(
  role: string | undefined | null,
  permissions: Record<string, boolean> | null | undefined,
): boolean {
  if (role === "admin") return true;
  const explicit =
    permissions && typeof permissions === "object" && Object.keys(permissions).length
      ? permissions
      : null;
  if (explicit) return explicit[PRICE_PERM_KEY] === true;
  return PRICING_ROLE_DEFAULT[role ?? ""] === true;
}

/** Load the employee's explicit permission map (null ⇒ use the role default). */
async function loadPricingPermissions(req: any): Promise<Record<string, boolean> | null> {
  const employeeId = req.session?.employeeId;
  if (!employeeId) return null;
  const [emp] = await db
    .select({ permissions: employeesTable.permissions })
    .from(employeesTable)
    .where(eq(employeesTable.id, employeeId));
  return (emp?.permissions as Record<string, boolean> | null) ?? null;
}

/**
 * Whether the requester may PRICE a customer RFQ. Resolves exactly like the
 * portal's `resolvePermissions`: an explicit permission map is authoritative,
 * otherwise the role default applies (manager ✓, admin always ✓). Reads
 * permissions fresh from the employee row so a grant/revoke takes effect without
 * a re-login.
 */
export async function hasPricingAccess(req: any): Promise<boolean> {
  const role = req.session?.role;
  if (role === "admin") return true;
  return mayPriceCustomerRfq(role, await loadPricingPermissions(req));
}

/**
 * Pricing gate. Only admins/managers (or an employee the manager explicitly
 * granted «تسعير طلب العميل») may set/change a customer unit price or finalize
 * (lock) an RFQ — the price quoted to the customer is a management decision.
 * Everyone else keeps full data-entry access (customer, dates, items); any price
 * they submit is dropped rather than honoured.
 */
export async function denyNonPricingRole(req: any, res: any): Promise<boolean> {
  if (await hasPricingAccess(req)) return false;
  res.status(403).json({
    error: "غير مصرح — تسعير طلبات العملاء متاح للمدير أو لمن مُنح صلاحية تسعير طلب العميل",
  });
  return true;
}

// For each customer RFQ item, resolve the approved supplier price (excl tax)
// via the rfq_items.customer_rfq_item_id link, falling back to partNo/lineItem
// matching for legacy supplier RFQs that lack the FK link. Returns a map
// customerItemId -> { costExclTax (min approved) | null, hasApproved }.
//
// The legacy fallback is scoped to supplier RFQs actually created for THIS
// customer RFQ (rfq.customer_rfq_no matches). Passing `customerRfqNo`
// ensures a stale approved price from an unrelated OLD supplier RFQ (same
// partNo/lineItem) never leaks into a fresh customer RFQ that was never sent
// to suppliers — the request-status "supplier-priced" and the margin check
// would otherwise fire without any real pricing request existing.
async function resolveApprovedCosts(
  customerItems: Array<{ id: number; partNo: string | null; lineItem: string | null }>,
  customerRfqNo?: string | null,
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
    // Only supplier RFQs actually created for this customer RFQ qualify for the
    // fallback — a stale approved price on an unrelated old RFQ must not count.

    const scopeCond = customerRfqNo
      ? and(eq(rfqTable.customerRfqNo, customerRfqNo), isNull(rfqItemsTable.customerRfqItemId))
      : isNull(rfqItemsTable.customerRfqItemId);
    const fallback = await db
      .select({ price: offerItemsTable.price, taxIncluded: offerItemsTable.taxIncluded })
      .from(offerItemsTable)
      .innerJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
      .innerJoin(rfqTable, eq(rfqItemsTable.rfqId, rfqTable.id))
      .where(and(matchCond, scopeCond, eq(offerItemsTable.isApproved, true)));
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

// Generate internal customer-RFQ number: CRFQ-YYYY-NNNNNN.
// Uses MAX of existing numbers (not COUNT) so deletions never cause collisions.
async function generateInternalNo(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `CRFQ-${year}-`;
  const [result] = await db
    .select({ maxNo: sql<string | null>`max(${customerRfqsTable.internalNo})` })
    .from(customerRfqsTable)
    .where(sql`${customerRfqsTable.internalNo} like ${prefix + "%"}`);
  let seq = 1;
  if (result?.maxNo) {
    const lastSeq = parseInt(result.maxNo.slice(prefix.length), 10);
    if (!isNaN(lastSeq) && lastSeq > 0) seq = lastSeq + 1;
  }
  return `${prefix}${String(seq).padStart(6, "0")}`;
}

// Enforce uniqueness of the customer RFQ number (رقم طلب تسعير العميل) — which
// same number must not be used by two different customer RFQs. The match is
// case-insensitive; auto-generated numbers are already unique-so. `excludeId`
// lets a PATCH ignore the row this update targets.

async function assertRfqNoIsUnique(rfqNo: string, excludeId?: number): Promise<boolean> {
  const trimmed = rfqNo.trim();
  if (!trimmed) return true;
  const existing = await db
    .select({ id: customerRfqsTable.id })
    .from(customerRfqsTable)
    .where(
      and(
        sql`lower(${customerRfqsTable.customerRfqNo}) = ${trimmed.toLowerCase()}`,
        excludeId !== undefined ? ne(customerRfqsTable.id, excludeId) : undefined,
      ),
    )
    .limit(1);
  return existing.length === 0;
}
function formatQty(qty: string | null): string | null {
  if (qty == null) return null;
  const s = String(qty);
  if (!s.includes(".")) return s;
  const trimmed = s.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" ? "0" : trimmed;
}

// Match a submitted customer-RFQ item (which carries no id) to its stored row,
// by partNo first then lineItem, ignoring case and whitespace. Drives both price
// preservation and the UPDATE-in-place save.
function findItemByKey<
  T extends {
    id: number;
    partNo: string | null;
    lineItem: string | null;
    unitPrice: string | null;
  },
>(rows: T[], it: { partNo?: string; lineItem?: string; description?: string }): T | undefined {
  const key = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, "").trim().toLowerCase();
  const partNo = key(it.partNo);
  const lineItem = key(it.lineItem);
  for (const row of rows) {
    if (partNo && key(row.partNo) === partNo) return row;
    if (lineItem && key(row.lineItem) === lineItem) return row;
  }
  // A row identified only by its description (the form allows that) still needs
  // to match its stored row, or every save would delete + re-insert it and
  // sever its customer-PO / supplier-offer links.
  const description = key(it.description);
  if (description) {
    for (const row of rows) {
      if (key((row as { description?: string | null }).description) === description) return row;
    }
  }
  return undefined;
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
  customerRfqNo?: string | null,
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

  // Legacy fallback: items with no FK link, matched by partNo/lineItem — but
  // ONLY from supplier RFQs actually created for THIS customer RFQ (rfq.customer_rfq_no. A
  // stale approved price on an unrelated old RFQ must not count as "supplier-priced"
  // for a fresh RFQ that was never sent to suppliers. When no customerRfqNo is
  // known (e.g. a sheet-only RFQ without a DB number)the fallback keeps the old
  // unscoped behavior.
  const unlinked = customerItems.filter((ci) => !priced.has(ci.id));
  for (const ci of unlinked) {
    const key = ci.partNo?.trim() || ci.lineItem?.trim();
    if (!key) continue;
    const partMatch = ci.partNo?.trim() ? eq(rfqItemsTable.partNo, ci.partNo.trim()) : null;
    const lineMatch = ci.lineItem?.trim() ? eq(rfqItemsTable.lineItem, ci.lineItem.trim()) : null;
    const matchCond = partMatch && lineMatch ? or(partMatch, lineMatch) : (partMatch ?? lineMatch);
    if (!matchCond) continue;
    const scopeCond = customerRfqNo
      ? and(eq(rfqTable.customerRfqNo, customerRfqNo), isNull(rfqItemsTable.customerRfqItemId))
      : isNull(rfqItemsTable.customerRfqItemId);
    const fallback = await db
      .select({ id: offerItemsTable.id })
      .from(offerItemsTable)
      .innerJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
      .innerJoin(rfqTable, eq(rfqItemsTable.rfqId, rfqTable.id))
      .where(and(matchCond, scopeCond, eq(offerItemsTable.isApproved, true)));
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

// For a single RFQ: load its items + the cross-table milestones and return the
// derived request status. Used by GET /:id (detail) and as a one-off helper.
async function computeRequestStatusForRfq(
  rfqId: number,
  customerRfqNo?: string | null,
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
    true,
    customerRfqNo,
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
// GET /customer-rfq/check-number?value=…&excludeId=… — live uniqueness probe
// used by the "new"/"edit" forms to warn about a duplicate customer RFQ number
// before the user submits. Returns 200 { available: boolean }.value must be
// present (trimmed, case-insensitive match readerplain). An empty value is always.
router.get("/customer-rfq/check-number", requireAuth, async (req, res): Promise<void> => {
  const value = typeof req.query.value === "string" ? req.query.value.trim() : "";
  if (!value) {
    res.json({ available: true });
    return;
  }
  const excludeId =
    req.query.excludeId !== undefined ? parseInt(String(req.query.excludeId), 10) : undefined;
  res.json({
    available: await assertRfqNoIsUnique(value, Number.isFinite(excludeId) ? excludeId : undefined),
  });
});

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

// One row of the flat sheet view. The view is anchored on customer-RFQ items,
// so a customer-PO line with NO customer-RFQ-item link (a PO entered with
// free/manual lines, or a line orphaned before the link-preserving save) would
// otherwise be invisible. Such lines are appended as their own rows with the
// RFQ columns null, so an issued PO is never missing from the sheet.
interface SheetRow {
  rfqItemId: number | null;
  lineItem: string | null;
  partNo: string | null;
  description: string | null;
  uom: string | null;
  rfqQty: string | null;
  rfqUnitPrice: string | null;
  customerRfqId: number | null;
  customerRfqNo: string | null;
  customerName: string | null;
  entryDate: string | null;
  expiryDate: string | null;
  buyerName: string | null;
  poItemId: number | null;
  poNo: string | null;
  poDate: string | null;
  poQty: string | null;
  poUnitPrice: string | null;
  deliveryStatus: string | null;
  highlightColor: string | null;
  highlightNote: string | null;
  poFinalActualCost: string | null;
  poReferencePrice: string | null;
}

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

// The flat sheet view: one row per (customer RFQ item × matching customer PO
// line). The view is anchored on customer RFQ items, so a PO line that cannot
// be matched to any RFQ item — a PO entered with free/manual lines, or a line
// whose item FK was severed before the link-preserving save — is emitted as its
// own row with null RFQ columns. An issued PO is therefore never missing.
async function loadSheetRowsRaw(): Promise<SheetRow[]> {
  // Customer RFQ items with their request header. `createdAt` is kept as the
  // stable tie-breaker the old SQL ordering used.
  const rfqItems = await db
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
      rfqCreatedAt: customerRfqsTable.createdAt,
    })
    .from(customerRfqItemsTable)
    .innerJoin(customerRfqsTable, eq(customerRfqItemsTable.customerRfqId, customerRfqsTable.id));

  // Every customer PO line, with its PO header columns. The PO header must be
  // a LEFT join: removing an item from a PO (PATCH /customer-po/:id) detaches
  // the row (`customer_po_id → NULL`) instead of deleting it, so that its
  // recorded rejection reason and highlight note stay in the sheet. An INNER
  // join silently dropped exactly those detached rows from the sheet — the
  // «items disappeared after removing one from its PO» bug. The row survives
  // with null PO/No/date and deliveryStatus="cancelled" (flagReason «إلغي»).
  const poItems = await db
    .select({
      poItemId: customerPoItemsTable.id,
      customerRfqId: customerPoItemsTable.customerRfqId,
      customerRfqItemId: customerPoItemsTable.customerRfqItemId,
      lineItem: customerPoItemsTable.lineItem,
      partNo: customerPoItemsTable.partNo,
      description: customerPoItemsTable.description,
      uom: customerPoItemsTable.uom,
      poQty: customerPoItemsTable.qty,
      poUnitPrice: customerPoItemsTable.unitPrice,
      deliveryStatus: customerPoItemsTable.deliveryStatus,
      // Manual highlight set on the customer PO line (admin/accountant):
      // row tint + note appended to the «السبب» column in the response.
      highlightColor: customerPoItemsTable.highlightColor,
      highlightNote: customerPoItemsTable.highlightNote,
      poNo: customerPosTable.customerPoNo,
      poDate: customerPosTable.poDate,
    })
    .from(customerPoItemsTable)
    .leftJoin(customerPosTable, eq(customerPoItemsTable.customerPoId, customerPosTable.id));

  // Supplier-PO cost per customer-PO line, for the cost-overrun flag. Read by
  // customer-PO-item id (not a join) so a line ordered again on a later supplier
  // PO cannot multiply the sheet rows.
  const poItemIds = poItems.map((p) => p.poItemId);
  const supplierCosts = poItemIds.length
    ? await db
        .select({
          poItemId: purchaseOrderItemsTable.customerPoItemId,
          finalActualCost: purchaseOrderItemsTable.finalActualCost,
          referencePrice: purchaseOrderItemsTable.referencePrice,
        })
        .from(purchaseOrderItemsTable)
        .where(inArray(purchaseOrderItemsTable.customerPoItemId, poItemIds))
    : [];
  const costByPoItemId = new Map(
    supplierCosts.filter((c) => c.poItemId != null).map((c) => [c.poItemId as number, c]),
  );

  // Match each PO line to its RFQ item: by the item FK, falling back (for lines
  // whose FK was severed, or that were typed by hand against a picked RFQ) to
  // the RFQ header plus the typed partNo, then lineItem. The SQL LEFT JOIN
  // could not express that fallback, which is why such PO lines disappeared.
  const norm = (v: string | null) => (v ?? "").replace(/\s+/g, "").trim().toLowerCase();
  const rfqItemById = new Map(rfqItems.map((i) => [i.rfqItemId, i]));
  const byRfqAndPartNo = new Map<string, (typeof rfqItems)[number]>();
  const byRfqAndLineItem = new Map<string, (typeof rfqItems)[number]>();
  for (const i of rfqItems) {
    const partNo = norm(i.partNo);
    const lineItem = norm(i.lineItem);
    if (partNo) byRfqAndPartNo.set(`${i.customerRfqId}|${partNo}`, i);
    if (lineItem) byRfqAndLineItem.set(`${i.customerRfqId}|${lineItem}`, i);
  }
  const matchRfqItem = (p: (typeof poItems)[number]) => {
    if (p.customerRfqItemId != null) {
      const byId = rfqItemById.get(p.customerRfqItemId);
      if (byId) return byId;
    }
    if (p.customerRfqId == null) return undefined;
    // A line with neither a part number nor a line item cannot be matched to a
    // specific RFQ item, so it stays an RFQ-less row rather than guessing.
    const partNo = norm(p.partNo);
    const lineItem = norm(p.lineItem);
    if (partNo) {
      const byPart = byRfqAndPartNo.get(`${p.customerRfqId}|${partNo}`);
      if (byPart) return byPart;
    }
    if (lineItem) return byRfqAndLineItem.get(`${p.customerRfqId}|${lineItem}`);
    return undefined;
  };

  const poItemsByRfqItemId = new Map<number, typeof poItems>();
  const orphans: typeof poItems = [];
  for (const p of poItems) {
    const item = matchRfqItem(p);
    if (!item) {
      orphans.push(p);
      continue;
    }
    const list = poItemsByRfqItemId.get(item.rfqItemId) ?? [];
    list.push(p);
    poItemsByRfqItemId.set(item.rfqItemId, list);
  }

  // Customer RFQ headers. The view is anchored on RFQ ITEMS, so a request
  // saved with no usable item rows (the entry form only requires a customer
  // name; blank rows are filtered out of the payload) would otherwise appear
  // nowhere. Every header is loaded so such a request still gets one row.
  const rfqHeaders = await db
    .select({
      customerRfqId: customerRfqsTable.id,
      customerRfqNo: customerRfqsTable.customerRfqNo,
      customerName: customerRfqsTable.customerName,
      entryDate: customerRfqsTable.entryDate,
      expiryDate: customerRfqsTable.expiryDate,
      buyerName: customerRfqsTable.buyerName,
    })
    .from(customerRfqsTable);

  const rows: SheetRow[] = [];
  // A dated request sorts before an undated one, then by request date and RFQ
  // id — `ORDER BY entry_date ASC NULLS LAST, created_at, item id` in JS.
  const rfqOrder = [...rfqItems].sort((a, b) => {
    const aDated = a.entryDate ? "0" : "1";
    const bDated = b.entryDate ? "0" : "1";
    if (aDated !== bDated) return aDated < bDated ? -1 : 1;
    if ((a.entryDate ?? "") !== (b.entryDate ?? "")) {
      return (a.entryDate ?? "") < (b.entryDate ?? "") ? -1 : 1;
    }
    if (a.rfqCreatedAt.getTime() !== b.rfqCreatedAt.getTime()) {
      return a.rfqCreatedAt.getTime() - b.rfqCreatedAt.getTime();
    }
    return a.rfqItemId - b.rfqItemId;
  });

  const toRfqRow = (
    i: (typeof rfqItems)[number],
    po: (typeof poItems)[number] | undefined,
  ): SheetRow => {
    const cost = po ? costByPoItemId.get(po.poItemId) : undefined;
    return {
      rfqItemId: i.rfqItemId,
      lineItem: i.lineItem,
      partNo: i.partNo,
      description: i.description,
      uom: i.uom,
      rfqQty: i.rfqQty,
      rfqUnitPrice: i.rfqUnitPrice,
      customerRfqId: i.customerRfqId,
      customerRfqNo: i.customerRfqNo,
      customerName: i.customerName,
      entryDate: i.entryDate,
      expiryDate: i.expiryDate,
      buyerName: i.buyerName,
      poItemId: po?.poItemId ?? null,
      poNo: po?.poNo ?? null,
      poDate: po?.poDate ?? null,
      poQty: po?.poQty ?? null,
      poUnitPrice: po?.poUnitPrice ?? null,
      deliveryStatus: po?.deliveryStatus ?? null,
      highlightColor: po?.highlightColor ?? null,
      highlightNote: po?.highlightNote ?? null,
      poFinalActualCost: cost?.finalActualCost ?? null,
      poReferencePrice: cost?.referencePrice ?? null,
    };
  };

  for (const i of rfqOrder) {
    const linked = poItemsByRfqItemId.get(i.rfqItemId);
    // An RFQ item with no PO yet still gets one row with null PO columns.
    const pos = linked && linked.length > 0 ? linked : [undefined];
    for (const po of pos) rows.push(toRfqRow(i, po));
  }

  // Requests that have no item rows at all: one header-only row (null item +
  // null PO columns) so an empty request is never invisible. Sorted with the
  // same dated-first, then entryDate, then id ordering as the item rows.
  const rfqIdsWithItems = new Set(rfqItems.map((i) => i.customerRfqId));
  const emptyHeaders = rfqHeaders
    .filter((h) => !rfqIdsWithItems.has(h.customerRfqId))
    .sort((a, b) => {
      const aDated = a.entryDate ? "0" : "1";
      const bDated = b.entryDate ? "0" : "1";
      if (aDated !== bDated) return aDated < bDated ? -1 : 1;
      if ((a.entryDate ?? "") !== (b.entryDate ?? "")) {
        return (a.entryDate ?? "") < (b.entryDate ?? "") ? -1 : 1;
      }
      return a.customerRfqId - b.customerRfqId;
    });
  for (const h of emptyHeaders) {
    rows.push({
      rfqItemId: null,
      lineItem: null,
      partNo: null,
      description: null,
      uom: null,
      rfqQty: null,
      rfqUnitPrice: null,
      customerRfqId: h.customerRfqId,
      customerRfqNo: h.customerRfqNo,
      customerName: h.customerName,
      entryDate: h.entryDate,
      expiryDate: h.expiryDate,
      buyerName: h.buyerName,
      poItemId: null,
      poNo: null,
      poDate: null,
      poQty: null,
      poUnitPrice: null,
      deliveryStatus: null,
      highlightColor: null,
      highlightNote: null,
      poFinalActualCost: null,
      poReferencePrice: null,
    });
  }

  // PO lines that reach no RFQ item: emitted last, since they carry no request
  // date to sort by.
  for (const p of orphans) {
    const cost = costByPoItemId.get(p.poItemId);
    rows.push({
      rfqItemId: null,
      lineItem: p.lineItem,
      partNo: p.partNo,
      description: p.description,
      uom: p.uom,
      rfqQty: null,
      rfqUnitPrice: null,
      customerRfqId: p.customerRfqId,
      customerRfqNo: null,
      customerName: null,
      entryDate: null,
      expiryDate: null,
      buyerName: null,
      poItemId: p.poItemId,
      poNo: p.poNo,
      poDate: p.poDate,
      poQty: p.poQty,
      poUnitPrice: p.poUnitPrice,
      deliveryStatus: p.deliveryStatus,
      highlightColor: p.highlightColor,
      highlightNote: p.highlightNote,
      poFinalActualCost: cost?.finalActualCost ?? null,
      poReferencePrice: cost?.referencePrice ?? null,
    });
  }

  return rows;
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
        (r.customerRfqNo ?? "").toLowerCase().includes(s) ||
        (r.customerName ?? "").toLowerCase().includes(s) ||
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
      const flagReason =
        [r.flagReason, r.highlightNote].filter((s) => s != null).join(" — ") || null;
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
        ? [r.flagReason, r.highlightNote].filter((s) => s != null).join(" — ") || null
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
  // A typed customer RFQ number must be unique (case-insensitive) across all
  // customer RFQs.
  if (!autoGenerated && !(await assertRfqNoIsUnique(finalRfqNo))) {
    res.status(400).json({ error: "رقم طلب تسعير العميل مستخدم بالفعل — اختر رقماً آخر" });
    return;
  }
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
    // A row is kept when it identifies the item by ANY of its text fields.
    // The form offers a «توصيف البند» (description) column, so requiring a
    // partNo/lineItem silently discarded description-only rows on save — the
    // item vanished from the request (and from the items sheet view). Mirrors
    // the customer-PO filter.
    const validItems = items.filter(
      (it) => (it.partNo?.trim() || it.lineItem?.trim() || it.description?.trim()) && it.qty,
    );
    if (validItems.length > 0) {
      // Only employees with pricing access may seed a customer price.
      const mayPrice = await hasPricingAccess(req);
      await db.insert(customerRfqItemsTable).values(
        validItems.map((it) => ({
          customerRfqId: rfq.id,
          partNo: it.partNo?.trim() || null,
          // lineItem must contain no spaces — strip them automatically.
          lineItem: it.lineItem ? it.lineItem.replace(/\s+/g, "") : null,
          description: it.description?.trim() || null,
          uom: it.uom?.trim() || null,
          qty: it.qty != null && it.qty !== "" ? String(it.qty) : null,
          unitPrice:
            mayPrice && it.unitPrice != null && it.unitPrice !== "" ? String(it.unitPrice) : null,
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
  const { status: requestStatus, items } = await computeRequestStatusForRfq(
    id,
    row.rfq.customerRfqNo,
    row.rfq.expiryDate,
  );
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
  // Pricing is a management action: only employees with pricing access may send
  // a unit price or drive a status transition (finalize/lock). Data-entry edits
  // (customer, dates, items) stay available to everyone else — but a sent
  // (finalized) RFQ is immutable to them.
  const rawBody = req.body as {
    status?: string;
    items?: Array<{ unitPrice?: string | number | null }>;
  };
  const privileged = await hasPricingAccess(req);
  const pricingIntent =
    rawBody.status !== undefined ||
    (Array.isArray(rawBody.items) &&
      rawBody.items.some(
        (it) => it.unitPrice != null && it.unitPrice !== "" && Number(it.unitPrice) > 0,
      ));
  if (pricingIntent && (await denyNonPricingRole(req, res))) return;
  if (existing.status !== "draft" && !privileged) {
    res.status(400).json({ error: "لا يمكن تعديل طلب تسعير العميل بعد إرساله" });
    return;
  }
  // Admins/managers may edit and re-price a sent (finalized) RFQ at any time:
  // the close date, a missing approved supplier price and a price below the
  // 1.06x floor no longer block them. Header + items are rewritten below, with
  // item prices gathered/preserved by loadCurrentDbItemsForPricing.

  const { customerName, customerRfqNo, entryDate, expiryDate, buyerName, notes, status, items } =
    req.body as {
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
        description?: string;
        uom?: string;
        qty?: string | number | null;
        unitPrice?: string | number | null;
      }>;
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
      // A typed customer RFQ number must stay unique — another RFQ may not use
      // the same number (case-insensitive; this row itself is excluded).
      if (!(await assertRfqNoIsUnique(trimmed, id))) {
        res.status(400).json({ error: "رقم طلب تسعير العميل مستخدم بالفعل — اختر رقماً آخر" });
        return;
      }
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
    ? items.filter(
        (it) => (it.partNo?.trim() || it.lineItem?.trim() || it.description?.trim()) && it.qty,
      )
    : undefined;

  // Prices preserved across the delete+recreate below, keyed by partNo/lineItem
  // because the request items carry no id (the frontend only fills unitPrice
  // for inputs it rendered and edited). Without this, any untouched item
  // comes back with unit_price = NULL (the "prices wiped on save" bug on the
  // live 2263 RFQ).
  let currentDbItemsForPricing: Array<{
    id: number;
    partNo: string | null;
    lineItem: string | null;
    description: string | null;
    unitPrice: string | null;
  }> | null = null;
  const loadCurrentDbItemsForPricing = async () => {
    if (currentDbItemsForPricing) return currentDbItemsForPricing;
    currentDbItemsForPricing = await db
      .select({
        id: customerRfqItemsTable.id,
        partNo: customerRfqItemsTable.partNo,
        lineItem: customerRfqItemsTable.lineItem,
        description: customerRfqItemsTable.description,
        unitPrice: customerRfqItemsTable.unitPrice,
      })
      .from(customerRfqItemsTable)
      .where(eq(customerRfqItemsTable.customerRfqId, id));
    return currentDbItemsForPricing;
  };

  // Locate the stored row a submitted item corresponds to, by partNo then
  // lineItem (the submitted items carry no id). Used both to preserve prices and
  // to UPDATE in place rather than delete+recreate — the row ids are referenced
  // by customer-PO and supplier-offer links.
  const findDbItem = (
    rows: typeof currentDbItemsForPricing,
    it: { partNo?: string; lineItem?: string; description?: string },
  ) => findItemByKey(rows ?? [], it);

  if (status === "sent" && validItems !== undefined) {
    const unpriced = validItems.filter(
      (it) => it.unitPrice == null || it.unitPrice === "" || Number(it.unitPrice) <= 0,
    );
    // Partial pricing is allowed: the customer prices only the items they are
    // ready to quote, and the rest stay unpriced (they can be priced later and
    // the request status shows the «مُسعَّر X%» share). Only a fully unpriced
    // submission is rejected — there would be nothing to finalize.
    if (unpriced.length === validItems.length) {
      res.status(400).json({ error: "أدخل سعر بند واحد على الأقل قبل تثبيت الطلب" });
      return;
    }
    if (unpriced.length > 0) {
      // The audit log is readable by every employee, so it records which items
      // were left unpriced — never any price or supplier cost.
      await db.insert(auditLogTable).values({
        action: "customer_rfq.partial_finalize",
        entityType: "customer_rfq",
        entityId: id,
        employeeId: req.session.employeeId,
        description: `Finalized customer RFQ with unpriced items: ${unpriced
          .map((it) => it.partNo || it.lineItem || it.description)
          .join(" | ")}`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });
    }

    // Margin check: each customer price (excl tax) should be ≥ 1.06 × the
    // approved supplier price (excl tax) for the matching item. The approved
    // cost is resolved via the customer_rfq_item_id link on rfq_items, with a
    // partNo/lineItem fallback for legacy supplier RFQs. Finalizing is a
    // manager action only (denyNonPricingRole above) and the manager is trusted
    // with the cost: an item with no approved supplier price, or priced below
    // the margin floor, still finalizes — the deviation is audit-logged.
    const currentDbItems = await loadCurrentDbItemsForPricing();
    const costs = await resolveApprovedCosts(currentDbItems, existing.customerRfqNo);

    // Map a req.body item to its current DB item id (partNo first, then lineItem).
    const findDbId = (it: { partNo?: string; lineItem?: string }): number | null =>
      findDbItem(currentDbItems, it)?.id ?? null;

    const violations: string[] = [];
    for (const it of validItems) {
      // Unpriced items are intentionally left out of the quote — nothing to
      // check against the margin floor (and the supplier cost must not be
      // probed for them either).
      if (it.unitPrice == null || it.unitPrice === "" || Number(it.unitPrice) <= 0) continue;
      const dbId = findDbId(it);
      const cost = dbId != null ? (costs.get(dbId) ?? null) : null;
      // Both notes deliberately omit the numbers: the audit log is readable by
      // every employee, and the supplier cost must never surface there.
      if (cost == null) {
        violations.push(`بند بلا سعر مورد معتمد (${it.partNo || it.lineItem})`);
      } else if (Number(it.unitPrice) < cost * MARGIN_FACTOR) {
        violations.push(`سعر أقل من الحد الأدنى للهامش (${it.partNo || it.lineItem})`);
      }
    }

    if (violations.length > 0) {
      await db.insert(auditLogTable).values({
        action: "customer_rfq.margin_deviation",
        entityType: "customer_rfq",
        entityId: id,
        employeeId: req.session.employeeId,
        description: `Finalized customer RFQ with margin deviations: ${violations.join(" | ")}`,
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

  // An admin/manager on a sent RFQ follows the full-edit branch even for a
  // reprice (they skip the pricesOnly gate above). When the request items are
  // id-only (each carries id + at most unitPrice — no partNo/lineItem/qty),
  // the intent is reprice, not replace: update prices by id and skip the
  // delete+recreate below. Otherwise a full item replacement with an empty
  // list would delete every row (the 2263 items-vanished bug), so reject it.
  const itemsAreIdOnly =
    items !== undefined &&
    items.length > 0 &&
    items.every(
      (it) =>
        it.id != null &&
        it.partNo === undefined &&
        it.lineItem === undefined &&
        it.qty === undefined,
    );
  if (itemsAreIdOnly) {
    for (const it of items!) {
      if (it.unitPrice == null || it.unitPrice === "") continue; // untouched — keep the stored price
      await db
        .update(customerRfqItemsTable)
        .set({ unitPrice: String(it.unitPrice) })
        .where(eq(customerRfqItemsTable.id, it.id as number));
    }
  }
  if (items !== undefined && !itemsAreIdOnly && (!validItems || validItems.length === 0)) {
    res.status(400).json({ error: "لا يمكن حفظ الطلب بدون بنود" });
    return;
  }
  if (items !== undefined && !itemsAreIdOnly) {
    // Items are UPDATED in place where possible instead of deleted and
    // re-inserted: `customer_po_items.customer_rfq_item_id` and
    // `rfq_items.customer_rfq_item_id` reference these ids, so recreating them
    // would sever every existing customer-PO / supplier-offer link (the PO then
    // vanished from the items sheet view).
    const existingRows = await loadCurrentDbItemsForPricing();
    const keptIds = new Set<number>();
    const toInsert: Array<{
      customerRfqId: number;
      partNo: string | null;
      lineItem: string | null;
      description: string | null;
      uom: string | null;
      qty: string | null;
      unitPrice: string | null;
    }> = [];
    for (const it of validItems!) {
      const explicitPrice =
        privileged && it.unitPrice != null && it.unitPrice !== "" ? String(it.unitPrice) : null;
      const existing = findDbItem(existingRows, it);
      const price = explicitPrice ?? existing?.unitPrice ?? null;
      const fields = {
        partNo: it.partNo?.trim() || null,
        lineItem: it.lineItem ? it.lineItem.replace(/\s+/g, "") : null,
        description: it.description?.trim() || null,
        uom: it.uom?.trim() || null,
        qty: it.qty != null && it.qty !== "" ? String(it.qty) : null,
        unitPrice: price,
      };
      if (existing && !keptIds.has(existing.id)) {
        keptIds.add(existing.id);
        await db
          .update(customerRfqItemsTable)
          .set(fields)
          .where(eq(customerRfqItemsTable.id, existing.id));
      } else {
        toInsert.push({ customerRfqId: id, ...fields });
      }
    }
    // Items the operator removed are deleted LAST, so the PO-link cleanup runs
    // once the surviving rows are already updated.
    const removedIds = existingRows.map((d) => d.id).filter((rid) => !keptIds.has(rid));
    if (removedIds.length > 0) {
      await db.delete(customerRfqItemsTable).where(inArray(customerRfqItemsTable.id, removedIds));
    }
    if (toInsert.length > 0) {
      await db.insert(customerRfqItemsTable).values(toInsert);
    }
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
    updated.customerRfqNo,
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

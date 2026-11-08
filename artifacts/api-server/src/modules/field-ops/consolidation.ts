/**
 * تجميع الأصناف المتكررة — presentation-only consolidation.
 *
 * The representative must see ONE row for a product that appears on several
 * supplier purchase orders, with the total and the full allocation across the
 * original POs — never three rows that look like three different products.
 *
 * Two invariants this module must never break:
 *  1. NOTHING is merged on a hunch. Grouping uses the project's own identity
 *     engine (`classificationIdentityKey`): part number → catalog line-item →
 *     description signature. An item with no usable identity is its OWN group.
 *  2. The source rows are never altered. Each group keeps every original
 *     `poItemId` with its own PO number, quantity and customer-PO allocation, so
 *     traceability (Supplier PO Item → Customer PO Item → Qty) survives the
 *     display grouping.
 */

import { classificationIdentityKey } from "../rfq/item-identity";

/** One supplier PO line, as loaded by the route (never mutated here). */
export interface PickupLine {
  poItemId: number;
  poId: number;
  poNo: string;
  supplierId: number | null;
  itemId: string | null;
  lineItem: string | null;
  partNo: string | null;
  description: string;
  uom: string | null;
  /** Ordered quantity on this line. */
  qty: number;
  /** Accepted quantity already received on this line. */
  acceptedQty: number;
  /** Ordered minus accepted — what is still outstanding on this line. */
  remainingQty: number;
  lineStatus: string;
  /** Customer PO number(s) this line's quantity is allocated to, when known. */
  customerPoNos: string[];
  /** Customer PO line ids this line is linked to (allocation detail). */
  customerPoItemIds: number[];
}

export interface ConsolidatedGroup {
  /** Stable key for the group; never reused across different identities. */
  groupKey: string;
  /** How the identity was established, for transparency in the UI. */
  matchBasis: "itemId" | "partNo" | "lineItem" | "description" | "unique";
  displayName: string;
  partNo: string | null;
  itemId: string | null;
  lineItem: string | null;
  uom: string | null;
  totalRequiredQty: number;
  totalAcceptedQty: number;
  totalRemainingQty: number;
  /** Per-PO allocation — the original rows, never merged. */
  allocations: PickupLine[];
}

/**
 * The grouping key for a line.
 *
 * Priority (per the operational rules): Item ID → Part Number → catalog line
 * item → description signature. Only an exact, canonical match groups two
 * lines. A line with no usable identity gets a key unique to itself, so two
 * unrelated items that merely read alike stay separate.
 */
export function groupKeyFor(line: PickupLine): {
  key: string;
  basis: ConsolidatedGroup["matchBasis"];
} {
  const itemId = (line.itemId ?? "").trim();
  if (itemId) return { key: `item:${itemId}`, basis: "itemId" };

  const identity = classificationIdentityKey({
    partNo: line.partNo,
    description: line.description,
    lineItem: line.lineItem,
  });
  if (identity) {
    if (identity.startsWith("pn:")) return { key: identity, basis: "partNo" };
    if (identity.startsWith("li:")) return { key: identity, basis: "lineItem" };
    return { key: identity, basis: "description" };
  }

  // No usable identity: this line is its own group. Never merge on "looks similar".
  return { key: `poitem:${line.poItemId}`, basis: "unique" };
}

/** Round to 4 decimals to match the DB NUMERIC(15,4) without float dust. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Group lines into consolidated items. Pure and order-stable: the first line's
 * display fields win, and allocations keep the input order.
 */
export function consolidatePickupLines(lines: PickupLine[]): ConsolidatedGroup[] {
  const groups = new Map<string, ConsolidatedGroup>();
  for (const line of lines) {
    const { key, basis } = groupKeyFor(line);
    const existing = groups.get(key);
    if (existing) {
      existing.allocations.push(line);
      existing.totalRequiredQty = round4(existing.totalRequiredQty + line.qty);
      existing.totalAcceptedQty = round4(existing.totalAcceptedQty + line.acceptedQty);
      existing.totalRemainingQty = round4(existing.totalRemainingQty + line.remainingQty);
      continue;
    }
    groups.set(key, {
      groupKey: key,
      matchBasis: basis,
      displayName: line.description,
      partNo: line.partNo,
      itemId: line.itemId,
      lineItem: line.lineItem,
      uom: line.uom,
      totalRequiredQty: round4(line.qty),
      totalAcceptedQty: round4(line.acceptedQty),
      totalRemainingQty: round4(line.remainingQty),
      allocations: [line],
    });
  }
  return [...groups.values()];
}

/** The distinct customer PO numbers touched by a group. */
export function customerPoNosOf(group: ConsolidatedGroup): string[] {
  return [...new Set(group.allocations.flatMap((a) => a.customerPoNos))];
}

/**
 * Whether a line still has something left to receive.
 *
 * A line is outstanding while its accepted quantity is below the ordered one.
 * This single rule drives two behaviours that must never disagree: the mobile
 * list hides completed lines, and the receipt handler decides between
 * `received` and `partially_received`. Duplicating the comparison in either
 * place is how a confirmed task ends up looking outstanding forever.
 */
export function hasOutstandingQty(orderedQty: number | null, acceptedQty: number): boolean {
  const ordered = orderedQty ?? 0;
  return acceptedQty < ordered - 1e-6;
}

/** How many distinct supplier POs a group spans. */
export function supplierPoCount(group: ConsolidatedGroup): number {
  return new Set(group.allocations.map((a) => a.poNo)).size;
}

/** One customer and the distinct purchase orders that carry delivery work. */
export interface CustomerDeliveryGroup {
  /** Customer id when known, otherwise null. */
  customerId: number | null;
  customerName: string | null;
  customerPoIds: number[];
  status: "delivered" | "pending";
}

/**
 * Collapse delivery assignments onto ONE row per customer.
 *
 * A customer with three purchase orders must appear as a single square, not
 * three cards that look like three different customers.
 *
 * Identity is the customer id. A customer PO entered without an id (the portal
 * allows a name-only customer) falls back to its customer NAME so its work is
 * still grouped — dropping it would make a real delivery vanish from the list.
 * An assignment with neither id nor name cannot be grouped and is dropped,
 * because guessing would merge unrelated customers.
 *
 * `status` is "delivered" only when EVERY assignment for the customer is
 * delivered; one outstanding order keeps the customer in progress.
 */
export function groupAssignmentsByCustomer(
  assignments: {
    customerPoId: number | null;
    status: string;
    customerId: number | null;
    customerName: string | null;
  }[],
): CustomerDeliveryGroup[] {
  const byKey = new Map<
    string,
    { customerId: number | null; name: string | null; poIds: Set<number>; statuses: Set<string> }
  >();
  for (const a of assignments) {
    if (a.customerPoId == null) continue;
    const name = a.customerName?.trim() || null;
    if (a.customerId == null && name == null) continue;
    const key = a.customerId != null ? `id:${a.customerId}` : `name:${name}`;
    const entry = byKey.get(key) ?? {
      customerId: a.customerId,
      name,
      poIds: new Set<number>(),
      statuses: new Set<string>(),
    };
    entry.poIds.add(a.customerPoId);
    entry.statuses.add(a.status);
    byKey.set(key, entry);
  }
  return [...byKey.values()].map((entry) => ({
    customerId: entry.customerId,
    customerName: entry.name,
    customerPoIds: [...entry.poIds],
    status:
      entry.statuses.size > 0 && [...entry.statuses].every((s) => s === "delivered")
        ? "delivered"
        : "pending",
  }));
}

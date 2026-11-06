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

/** How many distinct supplier POs a group spans. */
export function supplierPoCount(group: ConsolidatedGroup): number {
  return new Set(group.allocations.map((a) => a.poNo)).size;
}

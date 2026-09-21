/**
 * Shared PO-line linking — ربط بند أمر شراء المورد ببند أمر شراء العميل
 *
 * A supplier PO line (`purchase_order_items`) fulfils a customer PO line
 * (`customer_po_items`) through `customer_po_item_id`. That foreign key is
 * missing on every legacy line, on every line created from a Google-Sheets
 * lookup, and on any line entered free-hand — so every module that reads cost,
 * delivery or receipt by that key alone silently sees nothing for the majority
 * of real data.
 *
 * This is the ONE match ladder all of them share, in order of certainty:
 *
 *   1. the explicit FK                               (exact)
 *   2. supplier PO `sheetPoNo` ↔ customer PO `customerPoNo`, then `lineItem`
 *   3. …same PO match, then `partNo`
 *   4. …same PO match, then description
 *
 * Step 1 is authoritative. Steps 2–4 rely on the PO numbers agreeing, which is
 * the same convention `resolveCustomerPoItemId` (communications) and
 * `resolvePoIssuedIds` (customer-po) already use. `unambiguous: false` means
 * several customer-PO lines matched equally well, so a caller that PERSISTS the
 * link must skip it — guessing there would attach a receipt to the wrong line.
 */
import { db, customerPosTable, customerPoItemsTable, purchaseOrdersTable } from "@workspace/db";

export type MatchBasis = "fk" | "number_lineItem" | "number_partNo" | "number_description" | null;

export interface ResolvedPoLink {
  customerPoItemId: number | null;
  /** Which rung of the ladder produced the match. */
  basis: MatchBasis;
  /** False when two or more lines matched equally well. */
  unambiguous: boolean;
}

const NONE: ResolvedPoLink = { customerPoItemId: null, basis: null, unambiguous: false };

/** Normalise a line/part identifier for cross-table matching. */
export function normKey(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

export interface CustomerPoLineRef {
  id: number;
  lineItem: string | null;
  partNo: string | null;
  description: string | null;
}

/**
 * Pure form of the ladder, for callers that have already loaded the candidate
 * customer-PO lines (batch paths, tests). `lines` must all belong to the
 * customer PO identified by the supplier PO's number.
 */
export function matchCustomerPoItem(
  line: { lineItem: string | null; partNo: string | null; description: string | null },
  lines: CustomerPoLineRef[],
): ResolvedPoLink {
  const by = (extract: (l: CustomerPoLineRef) => string | null) => {
    const key = normKey(extract(line as CustomerPoLineRef));
    if (!key) return [];
    return lines.filter((l) => normKey(extract(l)) === key);
  };

  const byLineItem = by((l) => l.lineItem);
  if (byLineItem.length > 0) {
    return byLineItem.length === 1
      ? { customerPoItemId: byLineItem[0].id, basis: "number_lineItem", unambiguous: true }
      : { customerPoItemId: byLineItem[0].id, basis: "number_lineItem", unambiguous: false };
  }
  const byPartNo = by((l) => l.partNo);
  if (byPartNo.length > 0) {
    return byPartNo.length === 1
      ? { customerPoItemId: byPartNo[0].id, basis: "number_partNo", unambiguous: true }
      : { customerPoItemId: byPartNo[0].id, basis: "number_partNo", unambiguous: false };
  }
  const byDescription = by((l) => l.description);
  if (byDescription.length > 0) {
    return byDescription.length === 1
      ? { customerPoItemId: byDescription[0].id, basis: "number_description", unambiguous: true }
      : { customerPoItemId: byDescription[0].id, basis: "number_description", unambiguous: false };
  }
  return NONE;
}

/**
 * Resolve, for every supplier PO line in one batch, which customer-PO line it
 * fulfils. Batched on purpose: reads all customer POs + their lines + the
 * supplier PO headers once, then matches in memory — so a list endpoint never
 * issues a query per line.
 *
 * Lines that already carry the FK are returned as-is; the fallback is only run
 * for the rest, so callers can persist exactly the rows it resolved.
 */
export async function resolveCustomerPoLinks(
  supplierLines: {
    id: number;
    poId: number;
    customerPoItemId: number | null;
    lineItem: string | null;
    partNo: string | null;
    description: string | null;
  }[],
): Promise<{ linkByLineId: Map<number, ResolvedPoLink>; resolvedByLineId: Map<number, number> }> {
  const linkByLineId = new Map<number, ResolvedPoLink>();
  const resolvedByLineId = new Map<number, number>();
  if (supplierLines.length === 0) return { linkByLineId, resolvedByLineId };

  for (const l of supplierLines) {
    if (l.customerPoItemId != null) {
      linkByLineId.set(l.id, {
        customerPoItemId: l.customerPoItemId,
        basis: "fk",
        unambiguous: true,
      });
    }
  }

  const unlinked = supplierLines.filter((l) => l.customerPoItemId == null);
  if (unlinked.length === 0) return { linkByLineId, resolvedByLineId };

  const poHeaders = await db
    .select({ id: purchaseOrdersTable.id, sheetPoNo: purchaseOrdersTable.sheetPoNo })
    .from(purchaseOrdersTable);
  const poNoById = new Map(poHeaders.map((h) => [h.id, h.sheetPoNo]));
  const anyLinkedPoId = new Set(
    unlinked.map((l) => l.poId).filter((id) => normKey(poNoById.get(id)) !== ""),
  );
  if (anyLinkedPoId.size === 0) return { linkByLineId, resolvedByLineId };

  const customerPos = await db
    .select({ id: customerPosTable.id, customerPoNo: customerPosTable.customerPoNo })
    .from(customerPosTable);
  const customerPoIdsByNo = new Map<string, number[]>();
  for (const po of customerPos) {
    const key = normKey(po.customerPoNo);
    if (!key) continue;
    customerPoIdsByNo.set(key, [...(customerPoIdsByNo.get(key) ?? []), po.id]);
  }

  const customerItems = await db
    .select({
      id: customerPoItemsTable.id,
      customerPoId: customerPoItemsTable.customerPoId,
      lineItem: customerPoItemsTable.lineItem,
      partNo: customerPoItemsTable.partNo,
      description: customerPoItemsTable.description,
    })
    .from(customerPoItemsTable);
  const linesByCustomerPo = new Map<number, CustomerPoLineRef[]>();
  for (const it of customerItems) {
    if (it.customerPoId == null) continue;
    const list = linesByCustomerPo.get(it.customerPoId) ?? [];
    list.push(it);
    linesByCustomerPo.set(it.customerPoId, list);
  }

  for (const line of unlinked) {
    // The supplier PO's sheetPoNo doubles as the customer PO number — the
    // operator looks the customer PO up when raising the supplier order.
    const candidateIds = customerPoIdsByNo.get(normKey(poNoById.get(line.poId))) ?? [];
    let best: ResolvedPoLink = NONE;
    for (const cpoId of candidateIds) {
      const match = matchCustomerPoItem(line, linesByCustomerPo.get(cpoId) ?? []);
      if (!match.customerPoItemId) continue;
      if (match.unambiguous) {
        best = match;
        break;
      }
      // Ambiguous across this PO: keep it only if nothing better shows up.
      if (!best.customerPoItemId) best = match;
    }
    linkByLineId.set(line.id, best);
    if (best.customerPoItemId != null) resolvedByLineId.set(line.id, best.customerPoItemId);
  }

  return { linkByLineId, resolvedByLineId };
}

/**
 * Invert the ladder into a customer-PO-line → supplier-line map, for callers
 * that JOIN the two tables and therefore miss every FK-less line. An explicit
 * FK wins over a number-based match; among number-based matches the first
 * unambiguous one wins. The supplier line must expose `id` and `customerPoItemId`.
 */
export async function supplierLineByCustomerItem<
  T extends {
    id: number;
    poId: number;
    customerPoItemId: number | null;
    lineItem: string | null;
    partNo: string | null;
    description: string | null;
  },
>(supplierLines: T[]): Promise<Map<number, T>> {
  const { linkByLineId } = await resolveCustomerPoLinks(supplierLines);
  const out = new Map<number, T>();
  for (const line of supplierLines) {
    const link = linkByLineId.get(line.id);
    if (!link?.customerPoItemId) continue;
    const current = out.get(link.customerPoItemId);
    if (!current) {
      out.set(link.customerPoItemId, line);
      continue;
    }
    // Prefer the line that actually carries the FK over a derived match.
    if (current.customerPoItemId == null && line.customerPoItemId != null) {
      out.set(link.customerPoItemId, line);
    }
  }
  return out;
}

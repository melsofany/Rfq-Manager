/**
 * Database side of RFQ ↔ PO line allocations. The matching rules live in
 * shared/rfq-links.ts; this file loads rows, calls those rules and writes
 * allocations. Everything here is internal: nothing in this module is for
 * supplier-facing output.
 */
import { eq, or, inArray } from "drizzle-orm";
import {
  db,
  rfqTable,
  rfqItemsTable,
  rfqPoAllocationsTable,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  customerPoItemsTable,
} from "@workspace/db";
import {
  matchRfqItem,
  computeQuantityBreakdown,
  isActivePoLine,
  type PoLineForLink,
  type RfqItemForLink,
  type RfqLinkResult,
  type QuantityBreakdown,
} from "../../shared/rfq-links";

/** Anything that can run queries: the top-level db or a transaction. */
export type Executor = Pick<typeof db, "select" | "insert">;

const num = (v: string | null | undefined): number | null =>
  v == null || v === "" ? null : Number(v);

/** Find RFQs whose internal number or customer number equals the typed value. */
export async function findRfqsByNumber(ex: Executor, number: string) {
  const n = number.trim();
  if (!n) return [];
  return ex
    .select({
      id: rfqTable.id,
      internalRfqNo: rfqTable.internalRfqNo,
      customerRfqNo: rfqTable.customerRfqNo,
      customerRfqDate: rfqTable.customerRfqDate,
    })
    .from(rfqTable)
    .where(or(eq(rfqTable.internalRfqNo, n), eq(rfqTable.customerRfqNo, n)));
}

/**
 * Items of one RFQ with the quantity still available for purchase on each.
 * Remaining = RFQ line qty − allocations from active PO lines.
 */
export async function loadRfqItemsWithRemaining(
  ex: Executor,
  rfqId: number,
): Promise<RfqItemForLink[]> {
  const items = await ex.select().from(rfqItemsTable).where(eq(rfqItemsTable.rfqId, rfqId));
  if (items.length === 0) return [];

  const allocRows = await ex
    .select({
      rfqItemId: rfqPoAllocationsTable.rfqItemId,
      allocatedQty: rfqPoAllocationsTable.allocatedQty,
      lineStatus: purchaseOrderItemsTable.lineStatus,
      poStatus: purchaseOrdersTable.status,
    })
    .from(rfqPoAllocationsTable)
    .innerJoin(
      purchaseOrderItemsTable,
      eq(rfqPoAllocationsTable.poItemId, purchaseOrderItemsTable.id),
    )
    .innerJoin(purchaseOrdersTable, eq(purchaseOrderItemsTable.poId, purchaseOrdersTable.id))
    .where(
      inArray(
        rfqPoAllocationsTable.rfqItemId,
        items.map((i) => i.id),
      ),
    );

  return items.map((it) => {
    const qty = num(it.qty);
    const purchased = allocRows
      .filter((a) => a.rfqItemId === it.id)
      .filter((a) => isActivePoLine({ status: a.poStatus }, { lineStatus: a.lineStatus }))
      .reduce((s, a) => s + Number(a.allocatedQty), 0);
    return {
      id: it.id,
      itemId: it.itemId,
      lineItem: it.lineItem,
      partNo: it.partNo,
      description: it.description,
      uom: it.uom,
      qty,
      remainingQty: qty == null ? null : Math.round((qty - purchased) * 10000) / 10000,
    };
  });
}

export type PoLineRfqOutcome =
  | { kind: "none"; reason: "no_rfq_found" | "rfq_has_no_items" }
  | { kind: "ambiguous_rfq"; rfqs: Awaited<ReturnType<typeof findRfqsByNumber>> }
  | { kind: "matched"; rfqId: number; rfqNo: string; result: RfqLinkResult };

/**
 * Work out which RFQ line a supplier PO line belongs to, given the RFQ number
 * the user typed for that line.
 */
export async function resolvePoLineRfq(
  ex: Executor,
  line: PoLineForLink,
  rfqNumber: string,
): Promise<PoLineRfqOutcome> {
  const rfqs = await findRfqsByNumber(ex, rfqNumber);
  if (rfqs.length === 0) return { kind: "none", reason: "no_rfq_found" };
  if (rfqs.length > 1) return { kind: "ambiguous_rfq", rfqs };
  const items = await loadRfqItemsWithRemaining(ex, rfqs[0].id);
  if (items.length === 0) return { kind: "none", reason: "rfq_has_no_items" };
  return {
    kind: "matched",
    rfqId: rfqs[0].id,
    rfqNo: rfqs[0].internalRfqNo,
    result: matchRfqItem(line, items),
  };
}

/**
 * Store one allocation. The line's full quantity is allocated; any excess over
 * the remaining RFQ quantity is reported as a warning rather than blocked.
 */
export async function createAllocation(
  ex: Executor,
  args: {
    rfqItemId: number;
    poItemId: number;
    qty: number;
    matchBasis: string;
    confidence: "auto" | "confirmed";
  },
): Promise<void> {
  await ex
    .insert(rfqPoAllocationsTable)
    .values({
      rfqItemId: args.rfqItemId,
      poItemId: args.poItemId,
      allocatedQty: String(args.qty),
      matchBasis: args.matchBasis,
      confidence: args.confidence,
    })
    // Same pair already linked: keep the existing row.
    .onConflictDoNothing();
}

/**
 * Quantities for one RFQ line, including the customer line it serves when one
 * exists. Requested quantity comes from the customer PO line when present,
 * otherwise from the RFQ line itself. Delivered quantity comes from the
 * customer PO line's total_delivered_qty.
 */
export async function getRfqItemQuantities(
  ex: Executor,
  rfqItemId: number,
): Promise<
  | { found: false }
  | {
      found: true;
      basis: "customer_po_line" | "rfq_line";
      customerPoItemId: number | null;
      quantities: QuantityBreakdown;
    }
> {
  const [rfqItem] = await ex.select().from(rfqItemsTable).where(eq(rfqItemsTable.id, rfqItemId));
  if (!rfqItem) return { found: false };

  let requested = num(rfqItem.qty);
  let basis: "customer_po_line" | "rfq_line" = "rfq_line";
  let customerPoItemId: number | null = null;
  let delivered: number | null = null;

  const cust = await ex
    .select({
      id: customerPoItemsTable.id,
      qty: customerPoItemsTable.qty,
      totalDeliveredQty: customerPoItemsTable.totalDeliveredQty,
    })
    .from(customerPoItemsTable)
    .where(eq(customerPoItemsTable.customerRfqItemId, rfqItem.id));
  if (cust.length > 0) {
    customerPoItemId = cust[0].id;
    requested = num(cust[0].qty) ?? requested;
    delivered = num(cust[0].totalDeliveredQty);
    basis = "customer_po_line";
  }

  const allocRows = await ex
    .select({
      allocatedQty: rfqPoAllocationsTable.allocatedQty,
      lineStatus: purchaseOrderItemsTable.lineStatus,
      poStatus: purchaseOrdersTable.status,
      accepted: purchaseOrderItemsTable.totalAcceptedQty,
    })
    .from(rfqPoAllocationsTable)
    .innerJoin(
      purchaseOrderItemsTable,
      eq(rfqPoAllocationsTable.poItemId, purchaseOrderItemsTable.id),
    )
    .innerJoin(purchaseOrdersTable, eq(purchaseOrderItemsTable.poId, purchaseOrdersTable.id))
    .where(eq(rfqPoAllocationsTable.rfqItemId, rfqItem.id));

  const quantities = computeQuantityBreakdown({
    requestedQty: requested,
    allocations: allocRows.map((a) => ({
      qty: Number(a.allocatedQty),
      active: isActivePoLine({ status: a.poStatus }, { lineStatus: a.lineStatus }),
    })),
    // Received from suppliers, approximated by accepted quantity on the
    // allocated PO lines. Exact per-allocation receipts are a follow-up.
    receivedQty: allocRows.reduce((s, a) => s + (num(a.accepted) ?? 0), 0),
    deliveredQty: delivered,
  });

  return { found: true, basis, customerPoItemId, quantities };
}

export interface RfqLinkInput {
  itemId?: string | null;
  lineItem?: string | null;
  partNo?: string | null;
  description: string;
  uom?: string | null;
  qty?: string | number | null;
  rfqNumber?: string | null;
  rfqItemId?: number | null;
}

export interface RfqLinkReport {
  /** Index of the line in the request body. */
  lineIndex: number;
  poItemId: number;
  /** linked: stored now. suggested: needs the creator to confirm. unresolved: nothing matched. */
  status: "linked" | "suggested" | "unresolved";
  rfqItemId: number | null;
  basis: string | null;
  warnings: string[];
  candidates: { rfqItemId: number; basis: string | null; uomMatch: boolean }[];
  /** Internal RFQ number the line was matched to, for display. */
  rfqNo?: string;
  /** Present when a customer RFQ number matches more than one RFQ. */
  rfqChoices?: { id: number; internalRfqNo: string; customerRfqNo: string }[];
  reason?: string;
}

/**
 * Link the PO lines just inserted by POST /po to RFQ lines, using the RFQ
 * number or RFQ line id the user gave for each line. Automatic links are stored.
 * Suggestions are returned and stored only after the creator confirms them.
 */
export async function linkNewPoItemsToRfq(
  ex: Executor,
  inserted: { id: number }[],
  lines: RfqLinkInput[],
): Promise<RfqLinkReport[]> {
  const reports: RfqLinkReport[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const poItemId = inserted[i]?.id;
    if (poItemId == null) continue;
    const qtyNum = line.qty != null && line.qty !== "" ? Number(line.qty) : null;

    if (line.rfqItemId) {
      const [ri] = await ex
        .select({ id: rfqItemsTable.id })
        .from(rfqItemsTable)
        .where(eq(rfqItemsTable.id, line.rfqItemId));
      if (!ri) {
        reports.push({
          lineIndex: i,
          poItemId,
          status: "unresolved",
          rfqItemId: null,
          basis: null,
          warnings: [],
          candidates: [],
          reason: "rfq_item_not_found",
        });
        continue;
      }
      await createAllocation(ex, {
        rfqItemId: ri.id,
        poItemId,
        qty: qtyNum ?? 0,
        matchBasis: "explicit",
        confidence: "confirmed",
      });
      reports.push({
        lineIndex: i,
        poItemId,
        status: "linked",
        rfqItemId: ri.id,
        basis: "explicit",
        warnings: [],
        candidates: [],
      });
      continue;
    }

    if (!line.rfqNumber?.trim()) continue;

    const poLine: PoLineForLink = {
      itemId: line.itemId || null,
      lineItem: line.lineItem || null,
      partNo: line.partNo || null,
      description: line.description.trim(),
      uom: line.uom || null,
      qty: qtyNum,
    };
    const outcome = await resolvePoLineRfq(ex, poLine, line.rfqNumber);

    if (outcome.kind === "none") {
      reports.push({
        lineIndex: i,
        poItemId,
        status: "unresolved",
        rfqItemId: null,
        basis: null,
        warnings: [],
        candidates: [],
        reason: outcome.reason,
      });
      continue;
    }
    if (outcome.kind === "ambiguous_rfq") {
      reports.push({
        lineIndex: i,
        poItemId,
        status: "unresolved",
        rfqItemId: null,
        basis: null,
        warnings: [],
        candidates: [],
        reason: "rfq_number_ambiguous",
        rfqChoices: outcome.rfqs.map((r) => ({
          id: r.id,
          internalRfqNo: r.internalRfqNo,
          customerRfqNo: r.customerRfqNo,
        })),
      });
      continue;
    }

    const { result, rfqNo } = outcome;
    const candidates = result.candidates.map((c) => ({
      rfqItemId: c.rfqItemId,
      basis: c.basis,
      uomMatch: c.uomMatch,
    }));
    if (result.status === "auto" && result.rfqItemId != null && result.basis) {
      await createAllocation(ex, {
        rfqItemId: result.rfqItemId,
        poItemId,
        qty: qtyNum ?? 0,
        matchBasis: result.basis,
        confidence: "auto",
      });
      reports.push({
        lineIndex: i,
        poItemId,
        status: "linked",
        rfqItemId: result.rfqItemId,
        basis: result.basis,
        warnings: result.warnings,
        candidates,
        rfqNo,
      });
    } else {
      reports.push({
        lineIndex: i,
        poItemId,
        status: result.status === "none" ? "unresolved" : "suggested",
        rfqItemId: null,
        basis: result.basis,
        warnings: result.warnings,
        candidates,
        rfqNo,
        reason: result.status === "none" ? "no_matching_line" : undefined,
      });
    }
  }
  return reports;
}

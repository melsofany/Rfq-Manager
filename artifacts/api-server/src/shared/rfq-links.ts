/**
 * RFQ ↔ supplier PO line linking (طلب التسعير ↔ بند أمر الشراء).
 *
 * Pure rules, no database access. Routes load the rows and call these.
 *
 * Rules agreed for this module:
 *   - Textual similarity alone never links. Only exact keys link automatically:
 *     line_item, then part_no, then item_id, after trim + lowercase.
 *     A description-only match is always a suggestion.
 *   - Units must agree when both sides have one. A mismatch turns an automatic
 *     link into a suggestion with a warning.
 *   - Quantities never block. Exceeding the remaining RFQ quantity, or buying
 *     less than the customer asked for, produces a warning.
 *   - Purchased quantity counts only active PO lines (not cancelled).
 *   - RFQ numbers (internal or customer) are internal. They must never appear
 *     in any document, email or sheet sent to a supplier.
 */

export type MatchBasis = "lineItem" | "partNo" | "itemId" | "description" | null;

export type RfqLinkWarning =
  | "ambiguous"
  | "uom_mismatch"
  | "qty_exceeds_remaining"
  | "no_match"
  | "over_purchased"
  | "under_purchased";

export interface PoLineForLink {
  itemId: string | null;
  lineItem: string | null;
  partNo: string | null;
  description: string | null;
  uom: string | null;
  qty: number | null;
}

export interface RfqItemForLink extends PoLineForLink {
  id: number;
  /** Quantity still available for purchase on this RFQ line, if known. */
  remainingQty?: number | null;
}

export interface RfqLinkCandidate {
  rfqItemId: number;
  basis: MatchBasis;
  uomMatch: boolean;
}

export interface RfqLinkResult {
  /** auto: safe to store now. suggested: the creator must confirm. none: no link. */
  status: "auto" | "suggested" | "none";
  /** Set only when status is "auto". */
  rfqItemId: number | null;
  basis: MatchBasis;
  candidates: RfqLinkCandidate[];
  warnings: RfqLinkWarning[];
}

/** Normalise an identifier for comparison. Empty string means "no value". */
export function normKey(v: string | null | undefined): string {
  return (v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Normalise a unit of measure. Kept separate so unit aliases can be added here. */
export function normUom(v: string | null | undefined): string {
  return normKey(v);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

const KEYS = ["lineItem", "partNo", "itemId"] as const;

/**
 * Decide how a supplier PO line relates to the candidate RFQ lines of one RFQ.
 * Candidates must already be limited to the RFQ the user selected.
 */
export function matchRfqItem(line: PoLineForLink, candidates: RfqItemForLink[]): RfqLinkResult {
  const warnings: RfqLinkWarning[] = [];

  let matched: RfqItemForLink[] = [];
  let basis: MatchBasis = null;
  for (const key of KEYS) {
    const want = normKey(line[key]);
    if (!want) continue;
    const hits = candidates.filter((c) => normKey(c[key]) === want);
    if (hits.length > 0) {
      matched = hits;
      basis = key;
      break;
    }
  }

  if (matched.length === 0) {
    const want = normKey(line.description);
    if (want) {
      // A line_item that is present on both sides and differs is a strong
      // negative signal, so such candidates cannot be suggested by description.
      const lineWant = normKey(line.lineItem);
      matched = candidates.filter((c) => {
        const lineHave = normKey(c.lineItem);
        if (lineWant && lineHave && lineWant !== lineHave) return false;
        return normKey(c.description) === want;
      });
      if (matched.length > 0) basis = "description";
    }
  }

  if (matched.length === 0) {
    warnings.push("no_match");
    return { status: "none", rfqItemId: null, basis: null, candidates: [], warnings };
  }

  const scored: RfqLinkCandidate[] = matched.map((c) => {
    const a = normUom(line.uom);
    const b = normUom(c.uom);
    const uomMatch = !a || !b || a === b;
    return { rfqItemId: c.id, basis, uomMatch };
  });

  for (const c of matched) {
    if (c.remainingQty != null && line.qty != null && line.qty > c.remainingQty) {
      warnings.push("qty_exceeds_remaining");
      break;
    }
  }

  if (matched.length > 1) {
    warnings.push("ambiguous");
    return { status: "suggested", rfqItemId: null, basis, candidates: scored, warnings };
  }

  if (basis === "description") {
    return { status: "suggested", rfqItemId: null, basis, candidates: scored, warnings };
  }

  if (!scored[0].uomMatch) {
    warnings.push("uom_mismatch");
    return { status: "suggested", rfqItemId: null, basis, candidates: scored, warnings };
  }

  return { status: "auto", rfqItemId: scored[0].rfqItemId, basis, candidates: scored, warnings };
}

/** A PO line counts toward purchased quantity unless it or its PO is cancelled. */
export function isActivePoLine(
  po: { status: string | null },
  line: { lineStatus: string | null },
): boolean {
  return po.status !== "cancelled" && line.lineStatus !== "cancelled";
}

export interface QuantityBreakdownInput {
  requestedQty: number | null;
  /** Allocations to this customer line, each flagged with whether its PO line is active. */
  allocations: { qty: number; active: boolean }[];
  receivedQty?: number | null;
  deliveredQty?: number | null;
}

export interface QuantityBreakdown {
  requested: number;
  purchased: number;
  remainingToPurchase: number;
  received: number;
  delivered: number;
  warnings: RfqLinkWarning[];
}

/**
 * Quantities for one customer line. Purchased is the sum of active allocations.
 * Remaining can be negative, which means over-purchase.
 */
export function computeQuantityBreakdown(input: QuantityBreakdownInput): QuantityBreakdown {
  const requested = input.requestedQty ?? 0;
  const purchased = round4(
    input.allocations.filter((a) => a.active).reduce((sum, a) => sum + a.qty, 0),
  );
  const remaining = round4(requested - purchased);
  const warnings: RfqLinkWarning[] = [];
  if (purchased > requested) warnings.push("over_purchased");
  if (remaining > 0) warnings.push("under_purchased");
  return {
    requested: round4(requested),
    purchased,
    remainingToPurchase: remaining,
    received: round4(input.receivedQty ?? 0),
    delivered: round4(input.deliveredQty ?? 0),
    warnings,
  };
}

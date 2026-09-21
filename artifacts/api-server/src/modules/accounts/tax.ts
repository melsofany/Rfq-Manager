/**
 * Accounts Module — حسابات الضرائب المصرية (Egyptian tax helpers)
 *
 * Shared helpers for the Egyptian VAT (ضريبة القيمة المضافة، القانون 67 لسنة
 * 2016) and withholding tax (خصم تحت حساب المورد) calculations used by the
 * accounts routes. The rates come from the `tax_settings` table (editable in
 * the UI) and default to the statutory 14% VAT / 3% withholding.
 */

export interface TaxSettingsRow {
  vatRate: string;
  withholdingRate: string;
  withholdingRateServices: string;
  withholdingRatePurchases: string;
}

/** Numeric rate as a number (e.g. "14" → 14). Falls back to a sane default. */
export function rateOf(v: string | null | undefined, fallback: number): number {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

/**
 * Strip VAT (VAT-inclusive → net) then compute the VAT amount on the net base.
 *   net   = gross / (1 + vat%)
 *   vat   = gross − net       (= net × vat%)
 */
export function vatComponents(amountIncl: number, vatRate: number): { net: number; vat: number } {
  if (vatRate <= 0) return { net: amountIncl, vat: 0 };
  const net = amountIncl / (1 + vatRate / 100);
  return { net, vat: amountIncl - net };
}

/** VAT on a net (VAT-exclusive) base: net × vat%. */
export function vatOnNet(net: number, vatRate: number): number {
  return (net * vatRate) / 100;
}

/**
 * One row of the realized-margin rule: the selling side of a customer-PO line
 * plus whatever supplier cost is known for it.
 */
export interface MarginInput {
  sellQty: number | null;
  sellUnitPrice: number | null;
  /** Quantity actually accepted from the supplier (null until a receipt exists). */
  acceptedQty: number | null;
  /** Supplier unit cost, possibly VAT-inclusive (see `taxIncluded`). */
  finalActualCost: number | null;
  taxIncluded: boolean | null | undefined;
  /** Sum of PO line charges (نقل/شحن/جمارك/…) to fold into the cost. */
  charges?: number;
}

/** A computed margin line, with nulls wherever an input was missing. */
export interface MarginResult {
  revenue: number | null;
  cost: number | null;
  margin: number | null;
  marginPct: number | null;
  isLoss: boolean;
}

/**
 * THE realized-margin rule — the single implementation every screen must use.
 *
 *   revenue = sellQty × sellUnitPrice
 *   cost    = acceptedQty × netOfTax(finalActualCost) + charges
 *   margin  = revenue − cost
 *
 * Two invariants that used to drift between copies of this formula:
 *   • Cost is realized on the ACCEPTED quantity only, and is null until the
 *     supplier actually delivered — an ordered-but-unreceived line has no
 *     accounting cost.
 *   • The supplier cost is normalized to a VAT-exclusive basis, because the
 *     selling price always is; comparing the two raw reported false losses.
 *
 * `charges` is optional so callers that do not surface per-line charges still
 * share the rest of the rule.
 */
export function marginOf(line: MarginInput, vatRate: number): MarginResult {
  const revenue =
    line.sellQty != null && line.sellUnitPrice != null
      ? round2(line.sellQty * line.sellUnitPrice)
      : null;
  const charges = line.charges ?? 0;
  const unitCost =
    line.finalActualCost != null ? netOfTax(line.finalActualCost, line.taxIncluded, vatRate) : null;
  const cost =
    line.acceptedQty != null && unitCost != null
      ? round2(line.acceptedQty * unitCost + charges)
      : null;
  const margin = revenue != null && cost != null ? round2(revenue - cost) : null;
  const marginPct =
    margin != null && revenue !== null && revenue !== 0 ? round2((margin / revenue) * 100) : null;
  return { revenue, cost, margin, marginPct, isLoss: margin != null && margin < 0 };
}

/**
 * Normalize a price/cost to its VAT-exclusive basis. A tax-inclusive amount has
 * the embedded VAT stripped; a tax-exclusive one (or an unknown/null flag) is
 * returned untouched. This is the single convention every margin computation
 * must apply so a tax-inclusive supplier cost is never compared against a
 * VAT-exclusive selling price.
 */
export function netOfTax(
  amount: number,
  taxIncluded: boolean | null | undefined,
  vatRate: number,
): number {
  return taxIncluded ? vatComponents(amount, vatRate).net : amount;
}

/** Rounding to 2 decimal places (currency precision for tax reporting). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

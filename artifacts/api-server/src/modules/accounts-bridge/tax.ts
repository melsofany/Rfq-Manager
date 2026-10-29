/**
 * جسر الحسابات — قواعد الضرائب المصرية (bridge tax rules)
 *
 * The Egyptian tax arithmetic the bridge applies when it turns an RFQ event
 * into an Odoo document. It is deliberately pure and dependency-free so the
 * rules can be unit-tested without Odoo or a database.
 *
 *   VAT (ض.ق.م.)        — Law 67/2016, standard rate 14%. Applied to the NET
 *                        (VAT-exclusive) base. On a VAT-INCLUSIVE amount the
 *                        net is `gross / 1.14` and the VAT is the remainder.
 *   Withholding (خصم تحت حساب المورد) — 3% on the net supply value, deducted
 *                        from the vendor bill so the company pays the supplier
 *                        net − withholding and remits the withholding itself.
 *
 * These are the SAME rules the legacy accounts module used
 * (`modules/accounts/tax.ts`), restated here so the bridge has no dependency on
 * the module that is being deprecated. If the statutory rates change, the
 * values come from `tax_settings` — this file only holds the defaults.
 */

export const DEFAULT_VAT_RATE = 14;
export const DEFAULT_WITHHOLDING_RATE = 3;

export interface TaxRates {
  vatRate: number;
  withholdingRate: number;
}

export const DEFAULT_TAX_RATES: TaxRates = {
  vatRate: DEFAULT_VAT_RATE,
  withholdingRate: DEFAULT_WITHHOLDING_RATE,
};

/** Round to 2 decimals (currency precision) without float drift. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Coerce a NUMERIC column / body value to a number, falling back on garbage.
 *
 * `null`/`undefined`/`""` must NOT become 0: a NULL rate column would silently
 * turn 14% VAT into 0% VAT. They take the fallback instead.
 */
export function rateOf(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return isFinite(n) && n >= 0 ? n : fallback;
}

/** Resolve the effective rates from an optional tax_settings row. */
export function ratesFrom(
  row?: {
    vatRate?: unknown;
    withholdingRate?: unknown;
  } | null,
): TaxRates {
  return {
    vatRate: rateOf(row?.vatRate, DEFAULT_VAT_RATE),
    withholdingRate: rateOf(row?.withholdingRate, DEFAULT_WITHHOLDING_RATE),
  };
}

export interface VatComponents {
  /** VAT-exclusive base. */
  net: number;
  /** VAT amount on the net base. */
  vat: number;
  /** net + vat (equals the original amount when it was inclusive). */
  gross: number;
}

/**
 * Split an amount into net + VAT.
 *
 *   inclusive = false → `net` IS the base; vat = net × rate.
 *   inclusive = true  → `net` = amount / (1 + rate); vat = amount − net.
 *
 * The rounding is applied to `net` first and `vat` derived by subtraction, so
 * `net + vat` reproduces the original amount exactly (no lost cent).
 */
export function vatComponents(amount: number, vatRate: number, inclusive: boolean): VatComponents {
  if (vatRate <= 0) return { net: round2(amount), vat: 0, gross: round2(amount) };
  if (inclusive) {
    const net = round2(amount / (1 + vatRate / 100));
    const vat = round2(amount - net);
    return { net, vat, gross: round2(amount) };
  }
  const net = round2(amount);
  const vat = round2((net * vatRate) / 100);
  return { net, vat, gross: round2(net + vat) };
}

/** Withholding on a net supply value: net × 3%. */
export function withholdingOn(net: number, withholdingRate: number): number {
  if (withholdingRate <= 0) return 0;
  return round2((net * withholdingRate) / 100);
}

/**
 * The vendor-bill total: what the company actually pays the supplier.
 *
 *   gross            = net + VAT            (what the supplier invoiced)
 *   withholding      = net × 3%             (kept back and remitted)
 *   payableToSupplier = gross − withholding
 */
export interface VendorBillTotals {
  net: number;
  vat: number;
  gross: number;
  withholding: number;
  payableToSupplier: number;
}

export function vendorBillTotals(
  amount: number,
  rates: TaxRates = DEFAULT_TAX_RATES,
  inclusive = false,
): VendorBillTotals {
  const { net, vat, gross } = vatComponents(amount, rates.vatRate, inclusive);
  const withholding = withholdingOn(net, rates.withholdingRate);
  return { net, vat, gross, withholding, payableToSupplier: round2(gross - withholding) };
}

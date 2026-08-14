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
export function vatComponents(
  amountIncl: number,
  vatRate: number,
): { net: number; vat: number } {
  if (vatRate <= 0) return { net: amountIncl, vat: 0 };
  const net = amountIncl / (1 + vatRate / 100);
  return { net, vat: amountIncl - net };
}

/** VAT on a net (VAT-exclusive) base: net × vat%. */
export function vatOnNet(net: number, vatRate: number): number {
  return (net * vatRate) / 100;
}

/** Rounding to 2 decimal places (currency precision for tax reporting). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

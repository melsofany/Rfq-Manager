/**
 * VAT handling for PO lines.
 *
 * A supplier quote can be VAT-exclusive or VAT-inclusive. When the quote is
 * VAT-exclusive and the buyer ticks «شامل الضريبة» on the line, the PO price
 * must become the quoted price plus 14%. Unticking restores the quoted price.
 * Quotes that were already VAT-inclusive are left alone.
 */

export const VAT_RATE = 0.14;

export interface VatAwareLine {
  unitPrice: string;
  taxIncluded: boolean;
  /** Price the supplier quoted, before any VAT adjustment (string as typed). */
  quotedPrice?: string | null;
  /** Whether the supplier's quote already included VAT. */
  quotedTaxIncluded?: boolean | null;
}

/** Add 14% VAT to a price string, rounded to 2 decimals. */
export function addVat(price: string): string {
  const n = parseFloat(price);
  if (!Number.isFinite(n)) return price;
  return (Math.round(n * (1 + VAT_RATE) * 100) / 100).toFixed(2);
}

/** Whether this line's price should move when the tax checkbox is toggled. */
function adjustsForVat<T extends VatAwareLine>(line: T): boolean {
  return line.quotedTaxIncluded === false && !!line.quotedPrice;
}

/**
 * Apply a tax checkbox change to a line, keeping the price consistent with it.
 * Returns a new object; the input is not mutated.
 */
export function applyTaxToggle<T extends VatAwareLine>(line: T, taxIncluded: boolean): T {
  if (!adjustsForVat(line) || taxIncluded === line.taxIncluded) {
    return { ...line, taxIncluded };
  }
  return {
    ...line,
    taxIncluded,
    unitPrice: taxIncluded ? addVat(line.quotedPrice as string) : (line.quotedPrice as string),
  };
}

/**
 * Whether a price the buyer typed on a tax-marked line needs confirming.
 * It does when the line is an adjusted one (VAT-exclusive quote, tax ticked) and
 * the typed amount differs from the automatic quoted+14% value.
 */
export function needsVatConfirm<T extends VatAwareLine>(line: T, typed: string): boolean {
  const n = parseFloat(typed);
  if (!line.taxIncluded || !adjustsForVat(line) || !Number.isFinite(n) || n <= 0) return false;
  // Compare against the amount the line currently shows for its quote (quoted + 14%).
  return parseFloat(addVat(line.quotedPrice as string)) !== n;
}

/**
 * Apply the buyer's answer to the confirmation.
 * - exclusive: the typed amount is VAT-exclusive, so it becomes the new base and 14% is added.
 * - not exclusive: the typed amount is already VAT-inclusive and is kept as typed; the line
 *   is then treated as inclusive so no further automatic VAT is applied.
 */
export function applyManualPrice<T extends VatAwareLine>(
  line: T,
  typed: string,
  exclusive: boolean,
): T {
  if (exclusive) {
    return { ...line, unitPrice: addVat(typed), quotedPrice: typed, quotedTaxIncluded: false };
  }
  return { ...line, unitPrice: typed, quotedPrice: typed, quotedTaxIncluded: true };
}

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

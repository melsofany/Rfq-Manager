/**
 * Which PO lines may appear on an outbound document.
 *
 * A cancelled line is not an order: the supplier was told (over WhatsApp) that
 * the line is cancelled, so a PDF that still prints it contradicts the
 * cancellation and invites an invoice for goods nobody wants. Receipt states
 * (`fulfilled`, `rejected`, `postponed`, `partial`) DO belong on the document —
 * those lines were genuinely ordered.
 *
 * One rule, one place: the PDF route, the dispatch builder, the representative
 * notification and the PDF generator itself all read `isCancelledLine`, so a new
 * path cannot silently disagree about what an order contains.
 */
export const CANCELLED_LINE_STATUS = "cancelled";

export function isCancelledLine(status?: string | null): boolean {
  return status === CANCELLED_LINE_STATUS;
}

/** The lines that may be printed / dispatched / notified as ordered. */
export function activePoLines<T extends { lineStatus?: string | null }>(lines: T[]): T[] {
  return lines.filter((l) => !isCancelledLine(l.lineStatus));
}

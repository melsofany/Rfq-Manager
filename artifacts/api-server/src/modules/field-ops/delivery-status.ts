/**
 * حالة تسليم أمر شراء العميل — computed from the state of its lines.
 *
 * The PO status is NEVER stored as a separate truth: it is derived from the
 * lines every time, so a line delivered or rejected through any path (portal,
 * WhatsApp, mobile app) moves the order to the right status without a second
 * update that could drift out of sync.
 */

/** One customer-PO line, as reduced for the status decision. */
export interface DeliveryLineState {
  /** Ordered quantity on the line. */
  orderedQty: number;
  /** Quantity the supplier actually delivered and the customer accepted. */
  deliveredQty: number;
  /** Quantity the customer refused. */
  rejectedQty: number;
  /** Hard ceiling: what was received from the supplier (falls back to ordered). */
  acceptedFromSupplier: number | null;
}

export type PoDeliveryStatus = "completed" | "in_progress" | "fully_rejected";

/** Human label for the status chip. */
export const PO_DELIVERY_STATUS_LABEL: Record<PoDeliveryStatus, string> = {
  completed: "مكتمل التسليم",
  in_progress: "تحت التسليم",
  fully_rejected: "مرفوض بالكامل",
};

/** How much of one line still has to be settled (delivered or rejected). */
export function lineRemaining(line: DeliveryLineState): number {
  const ceiling = line.acceptedFromSupplier != null ? line.acceptedFromSupplier : line.orderedQty;
  return Math.max(0, ceiling - line.deliveredQty - line.rejectedQty);
}

/**
 * Derive the purchase-order delivery status.
 *
 * - Every line settled and at least one delivered  → مكتمل التسليم
 * - Every line settled and nothing delivered       → مرفوض بالكامل
 * - Anything still outstanding                     → تحت التسليم
 *
 * A mix of delivered and rejected lines is "in_progress" until the rejected
 * lines are themselves settled — an order is never called complete while a line
 * still has quantity to settle.
 */
export function computePoDeliveryStatus(lines: DeliveryLineState[]): PoDeliveryStatus {
  if (!lines.length) return "in_progress";
  const anyRemaining = lines.some((l) => lineRemaining(l) > 1e-6);
  if (anyRemaining) return "in_progress";
  const anyDelivered = lines.some((l) => l.deliveredQty > 1e-6);
  return anyDelivered ? "completed" : "fully_rejected";
}

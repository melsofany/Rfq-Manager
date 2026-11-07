/**
 * Settlement state for the mobile supplier cards — no amounts, only the state
 * the representative actually needs:
 *   unpaid — غير مسدد · partial — سداد جزئي · paid — مسدد.
 *
 * The finance module keys a request by (po_id, supplier_id); a pair with no
 * request row was never queued for payment, so it is unpaid by definition.
 */
import { db, financePaymentRequestsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

export type PaymentStatus = "unpaid" | "partial" | "paid";

export async function paymentStatusByPair(
  pairs: { poId: number; supplierId: number }[],
): Promise<Map<string, PaymentStatus>> {
  const out = new Map<string, PaymentStatus>();
  for (const p of pairs) out.set(`${p.poId}:${p.supplierId}`, "unpaid");
  if (pairs.length === 0) return out;

  const rows = await db
    .select({
      poId: financePaymentRequestsTable.poId,
      supplierId: financePaymentRequestsTable.supplierId,
      status: financePaymentRequestsTable.status,
    })
    .from(financePaymentRequestsTable)
    .where(inArray(financePaymentRequestsTable.poId, [...new Set(pairs.map((p) => p.poId))]));

  for (const r of rows) {
    const key = `${r.poId}:${r.supplierId}`;
    if (!out.has(key)) continue;
    out.set(key, r.status as PaymentStatus);
  }
  return out;
}

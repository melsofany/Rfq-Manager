/**
 * جسر الحسابات — إعادة تشغيل حدث فاشل (replay a failed sync)
 *
 * Maps a stored sync row back to the RFQ event that produced it and re-runs the
 * sync. Replaying a SYNCED event is a no-op by construction — the store returns
 * `alreadySynced` and Odoo is never called — so a retry can never duplicate a
 * document. This is what the `POST /accounts/sync/replay/:id` endpoint uses.
 */

import {
  syncSupplierReceipt,
  syncCustomerDelivery,
  syncExpense,
  syncCustomerPayment,
} from "./events";
import type { SyncResult } from "./service";

export async function replayEvent(
  eventType: string,
  sourceTable: string,
  sourceId: number,
): Promise<SyncResult> {
  switch (eventType) {
    case "supplier_receipt":
      return syncSupplierReceipt(sourceId);
    case "customer_delivery":
      // The COGS half is stored under its own source table; the invoice half is
      // the one carrying the RFQ source id, so replaying the delivery re-runs
      // both (the COGS call is nested inside `syncCustomerDelivery`).
      return syncCustomerDelivery(sourceId);
    case "expense":
      return syncExpense(sourceId);
    case "customer_payment":
      return syncCustomerPayment(sourceId);
    case "cancellation":
      return {
        eventKey: `${eventType}:${sourceTable}:${sourceId}`,
        status: "skipped",
        error: "إعادة الإلغاء تتطلب بيانات الحركة الأصلية — أعد الإرسال من مصدر الحدث",
      };
    default:
      return {
        eventKey: `${eventType}:${sourceTable}:${sourceId}`,
        status: "failed",
        error: `نوع حدث غير معروف: ${eventType}`,
      };
  }
}

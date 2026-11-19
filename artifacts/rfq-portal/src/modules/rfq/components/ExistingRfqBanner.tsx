import { AlertTriangle, ExternalLink } from "lucide-react";
import { Link } from "wouter";

export interface ExistingRfq {
  id: number;
  internalRfqNo: string;
  status: string;
  itemCount: number;
  duplicates: number;
}

/**
 * Warns that this customer number already has an RFQ, and links to it.
 *
 * Sending the same request again is routine (a missed supplier, a lapsed
 * closing date). Creating a second RFQ splits the offers across two rows, so
 * the comparison and analysis each see a fragment — measured: 29 duplicated
 * numbers, one with 5 rows and 55 sends.
 */
export function ExistingRfqBanner({
  existing,
  customerRfqNo,
}: {
  existing: ExistingRfq;
  customerRfqNo: string;
}) {
  return (
    <div
      data-testid="existing-rfq-banner"
      className="bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded-lg p-4 flex items-start gap-3"
    >
      <AlertTriangle className="text-amber-600 shrink-0 mt-0.5" size={18} />
      <div className="text-sm space-y-2 flex-1">
        <p className="font-semibold text-amber-900 dark:text-amber-200">
          يوجد طلب تسعير لهذا الرقم بالفعل
        </p>
        <p className="text-amber-800 dark:text-amber-300">
          الرقم <span className="font-mono">{customerRfqNo.trim()}</span> مرتبط بالطلب{" "}
          <span className="font-mono font-semibold">{existing.internalRfqNo}</span> (
          {existing.itemCount} بند
          {existing.duplicates > 1 ? ` · ${existing.duplicates} طلبات مكررة` : ""}). سيُضاف الإرسال
          إلى نفس الطلب، وستظهر كل العروض والتحليلات في مكان واحد — بدل إنشاء طلب منفصل يشتّت
          المقارنة.
        </p>
        <Link
          href={`/rfq/${existing.id}`}
          className="inline-flex items-center gap-1.5 text-amber-900 dark:text-amber-200 font-medium underline"
        >
          فتح الطلب القائم
          <ExternalLink size={13} />
        </Link>
      </div>
    </div>
  );
}

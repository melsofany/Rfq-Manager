import { useState, useEffect } from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRfq,
  useListSuppliers,
  useListCategories,
  useSendRfqToSuppliers,
  useGetRfqSentLog,
  getGetRfqQueryKey,
  getListSuppliersQueryKey,
  getGetRfqSentLogQueryKey,
  getListCategoriesQueryKey,
  type SendRfqInput,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { SupplierPicker } from "../components/SupplierPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft,
  Send,
  CheckCircle2,
  XCircle,
  MinusCircle,
  MessageCircle,
  Mail,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";

type SendResult = {
  supplierId: number;
  supplierName: string;
  status: string;
  reason: string | null;
  email?: { status: string; error?: string | null };
  whatsapp?: { status: string; error?: string | null };
};

export default function SendRfqPage() {
  const { id } = useParams<{ id: string }>();
  const rfqId = parseInt(id, 10);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [closeDate, setCloseDate] = useState("");
  const [sendResults, setSendResults] = useState<SendResult[] | null>(null);

  // ── نافذة تأكيد إعادة الإرسال ─────────────────────────────────────────────
  const [showResendConfirm, setShowResendConfirm] = useState(false);
  const [resendSupplierNames, setResendSupplierNames] = useState<string[]>([]);

  const { data: dbCategories = [] } = useListCategories({
    query: { queryKey: getListCategoriesQueryKey() },
  });

  const { data: rfq } = useGetRfq(rfqId, {
    query: { queryKey: getGetRfqQueryKey(rfqId), enabled: !!rfqId },
  });
  const { data: suppliers } = useListSuppliers(undefined, {
    query: { queryKey: getListSuppliersQueryKey() },
  });

  // ── تحميل سجل الإرسال لهذا الطلب ─────────────────────────────────────────
  const { data: sentLog = [] } = useGetRfqSentLog(rfqId, {
    query: { queryKey: getGetRfqSentLogQueryKey(rfqId), enabled: !!rfqId },
  });

  // مجموعة معرّفات الموردين الذين أُرسل إليهم هذا الطلب من قبل
  const alreadySentIds = new Set(sentLog.map((s) => s.supplierId));

  // ── تعبئة تاريخ الإغلاق تلقائياً من تاريخ انتهاء الطلب ──────────────────────
  // تاريخ انتهاء الطلب مأخوذ من تاريخ انتهاء طلب تسعير العميل، فيُحمل هنا
  // كتاريخ إغلاق افتراضي عند الإرسال للموردين حتى يُغلق الطلب تلقائياً.
  useEffect(() => {
    if (!rfq?.expiresAt || closeDate) return;
    const d = rfq.expiresAt.slice(0, 10);
    if (d) setCloseDate(d);
  }, [rfq?.expiresAt, closeDate]);

  const sendMutation = useSendRfqToSuppliers({
    mutation: {
      onSuccess: (data: { details?: SendResult[]; sent?: number } | unknown) => {
        queryClient.invalidateQueries({ queryKey: getGetRfqSentLogQueryKey(rfqId) });
        queryClient.invalidateQueries({ queryKey: getGetRfqQueryKey(rfqId) });
        const details = (data as { details?: SendResult[] })?.details;
        if (details?.length) {
          setSendResults(details);
        } else {
          navigate(`/rfq/${rfqId}`);
        }
      },
    },
  });

  // ── منطق الإرسال مع التحقق من الإرسال المسبق ─────────────────────────────
  const doSend = (force: boolean) => {
    sendMutation.mutate({
      id: rfqId,
      data: {
        supplierIds: Array.from(selectedIds),
        closeDate: closeDate || undefined,
        // force مدعوم في الـ backend لإعادة الإرسال
        ...(force ? { force: true } : {}),
      } as SendRfqInput,
    });
  };

  const handleSend = () => {
    if (!selectedIds.size) return;

    // الموردون المحددون الذين أُرسل إليهم هذا الطلب من قبل
    const alreadySentSelected = Array.from(selectedIds).filter((sid) => alreadySentIds.has(sid));

    if (alreadySentSelected.length > 0) {
      // اجمع أسماء الموردين المسبق إرسالهم
      const names = alreadySentSelected
        .map((sid) => suppliers?.find((s) => s.id === sid)?.name ?? `#${sid}`)
        .filter(Boolean);
      setResendSupplierNames(names);
      setShowResendConfirm(true);
      return;
    }

    // لا يوجد إرسال مسبق — أرسل مباشرة
    doSend(false);
  };

  const handleConfirmResend = () => {
    setShowResendConfirm(false);
    doSend(true);
  };

  // عدد الموردين المحددين الذين أُرسل إليهم مسبقاً
  const selectedAlreadySentCount = Array.from(selectedIds).filter((sid) =>
    alreadySentIds.has(sid),
  ).length;

  // ── Results view ──────────────────────────────────────────────────────────
  if (sendResults) {
    const waFailed = sendResults.filter((r) => r.whatsapp?.status === "failed");
    const waOk = sendResults.filter((r) => r.whatsapp?.status === "sent");
    const noPhone = sendResults.filter((r) => r.whatsapp?.status === "no_phone");

    return (
      <Layout>
        <div className="p-4 sm:p-6 max-w-3xl space-y-5">
          <div className="flex items-center gap-3">
            <Link href={`/rfq/${rfqId}`}>
              <a className="text-muted-foreground hover:text-foreground">
                <ArrowLeft size={18} />
              </a>
            </Link>
            <h1 className="text-xl font-bold text-foreground">نتيجة الإرسال</h1>
          </div>

          {/* Summary */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-green-700">{waOk.length}</p>
              <p className="text-xs text-green-600 mt-0.5">واتساب أُرسل ✓</p>
            </div>
            <div
              className={`border rounded-lg p-3 text-center ${waFailed.length ? "bg-red-50 border-red-200" : "bg-muted/30 border-border"}`}
            >
              <p
                className={`text-2xl font-bold ${waFailed.length ? "text-red-700" : "text-muted-foreground"}`}
              >
                {waFailed.length}
              </p>
              <p
                className={`text-xs mt-0.5 ${waFailed.length ? "text-red-600" : "text-muted-foreground"}`}
              >
                واتساب فشل ✗
              </p>
            </div>
            <div className="bg-muted/30 border border-border rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-muted-foreground">{noPhone.length}</p>
              <p className="text-xs text-muted-foreground mt-0.5">بدون رقم هاتف</p>
            </div>
          </div>

          {/* Per-supplier detail */}
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border bg-muted/20">
              <p className="text-sm font-medium text-foreground">تفاصيل كل مورد</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-right">
                    <th className="px-4 py-2 text-muted-foreground text-xs font-medium">المورد</th>
                    <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-center">
                      <span className="flex items-center justify-center gap-1">
                        <MessageCircle size={12} /> واتساب
                      </span>
                    </th>
                    <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-center">
                      <span className="flex items-center justify-center gap-1">
                        <Mail size={12} /> إيميل
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sendResults.map((r) => (
                    <tr key={r.supplierId} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 font-medium text-foreground">{r.supplierName}</td>
                      <td className="px-4 py-3 text-center">
                        {r.whatsapp?.status === "sent" && (
                          <span className="inline-flex items-center gap-1 text-green-600 text-xs">
                            <CheckCircle2 size={13} /> أُرسل
                          </span>
                        )}
                        {r.whatsapp?.status === "failed" && (
                          <div>
                            <span className="inline-flex items-center gap-1 text-red-600 text-xs">
                              <XCircle size={13} /> فشل
                            </span>
                            {r.whatsapp.error && (
                              <p className="text-[10px] text-red-500 mt-0.5 max-w-xs break-all">
                                {r.whatsapp.error}
                              </p>
                            )}
                          </div>
                        )}
                        {r.whatsapp?.status === "no_phone" && (
                          <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
                            <MinusCircle size={13} /> بدون رقم
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {r.email?.status === "sent" && (
                          <span className="inline-flex items-center gap-1 text-green-600 text-xs">
                            <CheckCircle2 size={13} /> أُرسل
                          </span>
                        )}
                        {r.email?.status === "failed" && (
                          <span className="inline-flex items-center gap-1 text-red-600 text-xs">
                            <XCircle size={13} /> فشل
                          </span>
                        )}
                        {r.email?.status === "no_email" && (
                          <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
                            <MinusCircle size={13} /> بدون إيميل
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={() => navigate(`/rfq/${rfqId}`)}>
              <ArrowLeft size={14} className="ml-1" /> العودة لطلب التسعير
            </Button>
          </div>
        </div>
      </Layout>
    );
  }

  // ── Send form ─────────────────────────────────────────────────────────────
  return (
    <Layout>
      <div className="p-4 sm:p-6 max-w-4xl space-y-5">
        <div className="flex items-center gap-3">
          <Link href={`/rfq/${rfqId}`}>
            <a className="text-muted-foreground hover:text-foreground">
              <ArrowLeft size={18} />
            </a>
          </Link>
          <div>
            <h1 className="text-xl font-bold text-foreground">إرسال طلب التسعير للموردين</h1>
            {rfq && <p className="text-muted-foreground text-sm font-mono">{rfq.internalRfqNo}</p>}
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg p-5">
          <div className="flex items-end gap-4">
            <div className="space-y-1.5">
              <Label>
                تاريخ الإغلاق{" "}
                <span className="text-muted-foreground font-normal text-xs">
                  (يُؤخذ من تاريخ انتهاء طلب تسعير العميل)
                </span>
              </Label>
              <Input
                type="date"
                value={closeDate}
                onChange={(e) => setCloseDate(e.target.value)}
                className="w-48"
                min={new Date().toISOString().split("T")[0]}
              />
            </div>
            <p className="text-muted-foreground text-xs pb-2">
              لن يستطيع الموردون تقديم عروضهم بعد هذا التاريخ، ويُغلق الطلب عند الإرسال.
            </p>
          </div>
        </div>

        {/* تنبيه الإرسال المسبق في الاختيار الحالي */}
        {selectedAlreadySentCount > 0 && (
          <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" />
            <span>
              <strong>{selectedAlreadySentCount}</strong>{" "}
              {selectedAlreadySentCount === 1
                ? "مورد محدد سبق إرسال هذا الطلب إليه"
                : "موردين محددين سبق إرسال هذا الطلب إليهم"}{" "}
              — سيُطلب التأكيد قبل إعادة الإرسال.
            </span>
          </div>
        )}

        <SupplierPicker
          categories={dbCategories}
          suppliers={suppliers ?? []}
          selectedIds={selectedIds}
          onChange={setSelectedIds}
          alreadySentIds={alreadySentIds}
        />

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {selectedIds.size} مورد محدد
            {selectedAlreadySentCount > 0 && (
              <span className="text-amber-600 mr-1">
                ({selectedAlreadySentCount} أُرسل إليهم مسبقاً)
              </span>
            )}
          </p>
          <div className="flex flex-col-reverse sm:flex-row gap-3 sm:self-end">
            <Link href={`/rfq/${rfqId}`}>
              <a className="inline-flex items-center px-4 py-2 text-sm rounded border border-border text-muted-foreground hover:text-foreground">
                إلغاء
              </a>
            </Link>
            <Button
              onClick={handleSend}
              disabled={!selectedIds.size || sendMutation.isPending}
              className="gap-1.5"
            >
              <Send size={14} />
              {sendMutation.isPending
                ? "جاري الإرسال..."
                : `إرسال لـ ${selectedIds.size} مورد${selectedIds.size !== 1 ? "ين" : ""}`}
            </Button>
          </div>
        </div>

        {sendMutation.isError && (
          <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
            حدث خطأ أثناء الإرسال. يرجى المحاولة مجدداً.
          </div>
        )}
      </div>

      {/* ── نافذة تأكيد إعادة الإرسال ───────────────────────────────────────── */}
      {showResendConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowResendConfirm(false);
          }}
        >
          <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            {/* أيقونة التحذير */}
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                <AlertTriangle size={20} className="text-amber-600" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  إعادة إرسال طلب التسعير؟
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  {resendSupplierNames.length === 1
                    ? "المورد التالي سبق إرسال هذا الطلب إليه:"
                    : `الموردون التاليون (${resendSupplierNames.length}) سبق إرسال هذا الطلب إليهم:`}
                </p>
              </div>
            </div>

            {/* قائمة الموردين */}
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 max-h-48 overflow-y-auto">
              <ul className="space-y-1">
                {resendSupplierNames.map((name, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm text-amber-800">
                    <RefreshCw size={11} className="text-amber-500 shrink-0" />
                    {name}
                  </li>
                ))}
              </ul>
            </div>

            <p className="text-xs text-muted-foreground">
              إذا وافقت، سيُرسَل طلب التسعير مرة أخرى لهؤلاء الموردين وسيحصلون على رابط تسعير جديد.
            </p>

            {/* أزرار */}
            <div className="flex gap-3 justify-end pt-1">
              <Button
                variant="outline"
                onClick={() => setShowResendConfirm(false)}
                disabled={sendMutation.isPending}
              >
                إلغاء
              </Button>
              <Button
                onClick={handleConfirmResend}
                disabled={sendMutation.isPending}
                className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white"
              >
                {sendMutation.isPending ? (
                  <>جاري الإرسال...</>
                ) : (
                  <>
                    <Send size={13} />
                    إرسال على أي حال
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}

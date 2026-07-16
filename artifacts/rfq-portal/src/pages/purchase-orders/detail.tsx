import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getListPurchaseOrdersQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { ArrowLeft, Download, Loader2, Send, CheckCircle2, XCircle, Mail, MessageCircle, Link2, Link2Off } from "lucide-react";

interface PoDetail {
  id: number;
  internalPoNo: string;
  sheetPoNo: string;
  receiverName: string | null;
  receiverPhone: string | null;
  status: string;
  employeeId: number | null;
  employeeName: string | null;
  rfqId: number | null;
  linkedRfq: { id: number; internalRfqNo: string; status: string } | null;
  notes: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

interface PoItem {
  id: number;
  poId: number;
  supplierId: number | null;
  supplierName: string | null;
  itemId: string | null;
  lineItem: string | null;
  partNo: string | null;
  description: string;
  uom: string | null;
  qty: number | null;
  referencePrice: number | null;
}

interface RfqOption {
  id: number;
  internalRfqNo: string;
  customerRfqNo: string;
  status: string;
}

interface DispatchResult {
  supplierId: number;
  supplierName: string;
  emailSent: boolean;
  emailError: string | null;
  whatsappSent: boolean;
  whatsappError: string | null;
}

interface DispatchResponse {
  poNo: string;
  results: DispatchResult[];
}

function usePoDetail(id: number) {
  return useQuery<PoDetail>({
    queryKey: ["po", id],
    queryFn: async () => {
      const res = await fetch(`/api/po/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch PO");
      return res.json();
    },
    enabled: !isNaN(id),
  });
}

function usePoItems(id: number) {
  return useQuery<PoItem[]>({
    queryKey: ["po-items", id],
    queryFn: async () => {
      const res = await fetch(`/api/po/${id}/items`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch PO items");
      return res.json();
    },
    enabled: !isNaN(id),
  });
}

function useRfqOptions() {
  return useQuery<RfqOption[]>({
    queryKey: ["rfq-options-for-po"],
    queryFn: async () => {
      const res = await fetch("/api/rfq", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch RFQs");
      const all: RfqOption[] = await res.json();
      // Show SENT and QUOTED RFQs (eligible to be linked)
      return all.filter((r) => r.status === "SENT" || r.status === "QUOTED");
    },
  });
}

// Group items by supplier
function groupBySupplier(items: PoItem[]): Map<string, { supplierId: number | null; supplierName: string | null; items: PoItem[] }> {
  const map = new Map<string, { supplierId: number | null; supplierName: string | null; items: PoItem[] }>();
  for (const item of items) {
    const key = item.supplierId != null ? `supplier-${item.supplierId}` : "no-supplier";
    if (!map.has(key)) {
      map.set(key, { supplierId: item.supplierId, supplierName: item.supplierName, items: [] });
    }
    map.get(key)!.items.push(item);
  }
  return map;
}

function fmt(v: number | null | undefined): string {
  if (v == null) return "—";
  return String(v);
}

export default function PurchaseOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id ?? "", 10);
  const queryClient = useQueryClient();

  const { data: po, isLoading: poLoading } = usePoDetail(id);
  const { data: items, isLoading: itemsLoading } = usePoItems(id);
  const { data: rfqOptions } = useRfqOptions();

  const [dispatching, setDispatching] = useState(false);
  const [dispatchResult, setDispatchResult] = useState<DispatchResponse | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const [showLinkPanel, setShowLinkPanel] = useState(false);
  const [selectedRfqId, setSelectedRfqId] = useState<string>("");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const grouped = items ? groupBySupplier(items) : new Map();
  const suppliersWithId = [...grouped.values()].filter((g) => g.supplierId != null);

  const handleDispatch = async () => {
    setDispatching(true);
    setDispatchResult(null);
    setDispatchError(null);
    try {
      const res = await fetch(`/api/po/${id}/dispatch`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) {
        setDispatchError(data.error ?? "Dispatch failed");
      } else {
        setDispatchResult(data as DispatchResponse);
        queryClient.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
        queryClient.invalidateQueries({ queryKey: ["po", id] });
      }
    } catch {
      setDispatchError("Network error — could not reach the server.");
    } finally {
      setDispatching(false);
    }
  };

  const handleLinkRfq = async () => {
    const rfqId = selectedRfqId ? parseInt(selectedRfqId, 10) : null;
    setLinking(true);
    setLinkError(null);
    try {
      const res = await fetch(`/api/po/${id}/link-rfq`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rfqId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLinkError(data.error ?? "فشل الربط");
      } else {
        queryClient.invalidateQueries({ queryKey: ["po", id] });
        queryClient.invalidateQueries({ queryKey: ["rfq"] });
        queryClient.invalidateQueries({ queryKey: ["rfq-options-for-po"] });
        setShowLinkPanel(false);
        setSelectedRfqId("");
      }
    } catch {
      setLinkError("خطأ في الشبكة");
    } finally {
      setLinking(false);
    }
  };

  const downloadPdf = (supplierId: number, supplierName: string) => {
    const a = document.createElement("a");
    a.href = `/api/po/${id}/pdf/${supplierId}`;
    a.download = `PO-${po?.internalPoNo ?? id}-${supplierName}.pdf`;
    a.click();
  };

  if (poLoading || itemsLoading) {
    return (
      <Layout>
        <div className="p-8 flex items-center justify-center text-muted-foreground text-sm gap-2">
          <Loader2 size={16} className="animate-spin" /> Loading...
        </div>
      </Layout>
    );
  }

  if (!po) {
    return (
      <Layout>
        <div className="p-8 text-center text-muted-foreground text-sm">Purchase order not found.</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-4 sm:p-6 max-w-5xl space-y-5">

        {/* Back + title */}
        <div className="flex items-center gap-3">
          <Link href="/purchase-orders">
            <a className="text-muted-foreground hover:text-foreground"><ArrowLeft size={18} /></a>
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-foreground font-mono">{po.internalPoNo}</h1>
              <StatusBadge status={po.status} />
            </div>
            <p className="text-muted-foreground text-sm">Sheet PO: {po.sheetPoNo} · {new Date(po.createdAt).toLocaleDateString()}</p>
          </div>
          <Button
            onClick={handleDispatch}
            disabled={dispatching || suppliersWithId.length === 0}
            className="gap-2 flex-shrink-0"
          >
            {dispatching ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            {dispatching ? "إرسال..." : "إرسال للموردين"}
          </Button>
        </div>

        {/* PO meta */}
        <div className="bg-card border border-border rounded-lg p-4 grid sm:grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">المسؤول</p>
            <p className="font-medium">{po.employeeName ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">المستلم</p>
            <p className="font-medium">
              {po.receiverName ?? "—"}
              {po.receiverPhone && <span className="text-muted-foreground ml-1">· {po.receiverPhone}</span>}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">ملاحظات</p>
            <p className="font-medium">{po.notes ?? "—"}</p>
          </div>
        </div>

        {/* RFQ Link section */}
        <div className="bg-card border border-border rounded-lg p-4 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">طلب التسعير المرتبط</p>
              {po.linkedRfq ? (
                <div className="flex items-center gap-2">
                  <Link href={`/rfq/${po.linkedRfq.id}`}>
                    <a className="font-medium text-primary hover:underline font-mono">{po.linkedRfq.internalRfqNo}</a>
                  </Link>
                  <StatusBadge status={po.linkedRfq.status} />
                </div>
              ) : (
                <p className="text-muted-foreground italic">غير مرتبط بطلب تسعير</p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 flex-shrink-0"
              onClick={() => { setShowLinkPanel(!showLinkPanel); setLinkError(null); setSelectedRfqId(""); }}
            >
              {po.linkedRfq ? <Link2Off size={14} /> : <Link2 size={14} />}
              {po.linkedRfq ? "تغيير الربط" : "ربط بطلب تسعير"}
            </Button>
          </div>

          {showLinkPanel && (
            <div className="mt-4 pt-4 border-t border-border space-y-3">
              <p className="text-xs text-muted-foreground">اختر طلب التسعير لربطه بهذا الأمر — سيتحول الطلب تلقائياً إلى حالة <strong>SUCCESS</strong></p>
              <div className="flex gap-2">
                <select
                  className="flex-1 text-sm border border-border rounded-md px-3 py-1.5 bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                  value={selectedRfqId}
                  onChange={(e) => setSelectedRfqId(e.target.value)}
                >
                  <option value="">— اختر طلب تسعير —</option>
                  {(rfqOptions ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.internalRfqNo} ({r.customerRfqNo}) — {r.status}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  disabled={!selectedRfqId || linking}
                  onClick={handleLinkRfq}
                  className="gap-1"
                >
                  {linking ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
                  ربط
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowLinkPanel(false)}>إلغاء</Button>
              </div>
              {linkError && <p className="text-xs text-red-600">{linkError}</p>}
            </div>
          )}
        </div>

        {/* Dispatch result */}
        {dispatchError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {dispatchError}
          </div>
        )}
        {dispatchResult && (
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border bg-muted/20 text-xs font-medium text-muted-foreground">
              نتيجة الإرسال — {po.internalPoNo}
            </div>
            <div className="divide-y divide-border">
              {dispatchResult.results.map((r) => (
                <div key={r.supplierId} className="px-4 py-3 flex items-center gap-4 text-sm">
                  <span className="font-medium flex-1">{r.supplierName}</span>
                  <span className="flex items-center gap-1 text-xs">
                    <Mail size={12} />
                    {r.emailSent
                      ? <CheckCircle2 size={14} className="text-green-600" />
                      : <XCircle size={14} className="text-red-500" />}
                    <span className={r.emailSent ? "text-green-700" : "text-red-600"}>
                      {r.emailSent ? "تم الإيميل" : (r.emailError ?? "لا يوجد إيميل")}
                    </span>
                  </span>
                  <span className="flex items-center gap-1 text-xs">
                    <MessageCircle size={12} />
                    {r.whatsappSent
                      ? <CheckCircle2 size={14} className="text-green-600" />
                      : <XCircle size={14} className="text-red-500" />}
                    <span className={r.whatsappSent ? "text-green-700" : "text-red-600"}>
                      {r.whatsappSent ? "تم واتساب" : (r.whatsappError ?? "لا يوجد هاتف")}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Items grouped by supplier */}
        {[...grouped.entries()].map(([key, group]) => (
          <div key={key} className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">
                  {group.supplierName ?? <span className="text-muted-foreground italic">لم يتم تحديد المورد</span>}
                </span>
                <span className="text-xs text-muted-foreground">({group.items.length} صنف{group.items.length !== 1 ? "" : ""})</span>
              </div>
              {group.supplierId != null && (
                <button
                  type="button"
                  onClick={() => downloadPdf(group.supplierId!, group.supplierName ?? "Supplier")}
                  className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
                  title="تحميل PDF لهذا المورد"
                >
                  <Download size={13} /> PDF
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left bg-muted/10">
                    <th className="px-3 py-2 text-muted-foreground font-medium">#</th>
                    <th className="px-3 py-2 text-muted-foreground font-medium">رقم القطعة</th>
                    <th className="px-3 py-2 text-muted-foreground font-medium">الوصف</th>
                    <th className="px-3 py-2 text-muted-foreground font-medium text-center">الكمية</th>
                    <th className="px-3 py-2 text-muted-foreground font-medium text-center">الوحدة</th>
                    <th className="px-3 py-2 text-muted-foreground font-medium text-right">سعر الوحدة</th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((item, idx) => (
                    <tr key={item.id} className="border-b border-border last:border-0 hover:bg-muted/10">
                      <td className="px-3 py-2 text-muted-foreground">{item.lineItem ?? idx + 1}</td>
                      <td className="px-3 py-2">{item.partNo ?? "—"}</td>
                      <td className="px-3 py-2 max-w-[260px]">{item.description}</td>
                      <td className="px-3 py-2 text-center font-medium">{fmt(item.qty)}</td>
                      <td className="px-3 py-2 text-center">{item.uom ?? "—"}</td>
                      <td className="px-3 py-2 text-right font-medium">{fmt(item.referencePrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {(!items || items.length === 0) && (
          <div className="bg-card border border-border rounded-lg p-8 text-center text-muted-foreground text-sm">
            لا توجد أصناف في أمر الشراء هذا.
          </div>
        )}
      </div>
    </Layout>
  );
}

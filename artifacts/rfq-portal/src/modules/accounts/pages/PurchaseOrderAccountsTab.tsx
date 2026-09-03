import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PackageCheck, Truck, RefreshCw, ArrowUpRight } from "lucide-react";

interface CustomerPoRow {
  id: number;
  internalPoNo: string;
  customerPoNo: string;
  customerName: string | null;
  poDate: string | null;
  status: string;
  itemCount: number;
  fulfillmentStatus?: {
    stage: string;
    deliveredPct: number | null;
    receivedItems: number | null;
    deliveredItems: number;
    totalItems: number;
  } | null;
}

interface SupplierPoRow {
  id: number;
  internalPoNo: string;
  sheetPoNo: string;
  receiverName: string | null;
  status: string;
  itemCount: number;
  createdAt: string;
}

const FULFILLMENT_LABEL: Record<string, string> = {
  draft: "مسودة",
  sent: "مرسل للعميل",
  po_issued: "صدر أمر شراء للمورد",
  ready_to_deliver: "جاهز للتسليم",
  delivered: "جارٍ التنفيذ",
  fulfilled: "تم تنفيذه",
};

const PO_STATUS_LABEL: Record<string, string> = {
  draft: "مسودة",
  sent: "مرسل",
  cancelled: "ملغي",
};

function fmtDate(d: string | null): string {
  if (!d) return "—";
  return d.slice(0, 10);
}

function useFetch<T>(url: string): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(url, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) {
          let msg = "فشل التحميل";
          try { msg = (await r.json() ).error ?? msg; } catch { /* ignore */ }
          throw new Error(msg);
        }
        return r.json() as Promise<T>;
      })
      .then((d) => {
        if (!cancelled) { setData(d); setLoading(false); }
      })
      .catch((e: Error) => {
        if (!cancelled) { setError(e.message); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, [url, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

function stageTone(stage: string): string {
  switch (stage) {
    case "fulfilled": return "bg-green-50 text-green-700";
    case "delivered": return "bg-indigo-50 text-indigo-700";
    case "ready_to_deliver": return "bg-cyan-50 text-cyan-700";
    case "po_issued": return "bg-blue-50 text-blue-700";
    case "sent": return "bg-amber-50 text-amber-700";
    default: return "bg-muted text-muted-foreground";
  }
}

function CustPoSubTab() {
  const { data, loading, error, reload } = useFetch<CustomerPoRow[]>("/api/customer-po");
  const [onlyProgress, setOnlyProgress] = useState(true);

  const rows = useMemo(() => {
    if (!data) return [];
    if (!onlyProgress) return data;
    return data.filter((r) =>
      r.fulfillmentStatus != null && (r.fulfillmentStatus.deliveredPct ?? 0) > 0,
    );
  }, [data, onlyProgress]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          أوامر شراء العملاء — لا يظهر أمر الشراء هنا إلا بعد بدء تسليمه للعميل. يمكنك إظهار الكل للإدارة الكاملة.
        </p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={onlyProgress}
              onChange={(e) => setOnlyProgress(e.target.checked)}
              className="accent-primary"
            />
            بعد التسليم فقط
          </label>
          <button
            type="button"
            onClick={reload}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            <RefreshCw size={12} />
            تحديث
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">جارٍ التحميل...</p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          لا توجد أوامر شراء عملاء {onlyProgress ? "تم تسليمها" : ""}؟
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                <th className="px-3 py-2 text-right font-medium">رقم الأمر</th>
                <th className="px-3 py-2 text-right font-medium">العميل</th>
                <th className="px-3 py-2 text-right font-medium">تاريخ الأمر</th>
                <th className="px-3 py-2 text-right font-medium">البنود</th>
                <th className="px-3 py-2 text-right font-medium">التسليم</th>
                <th className="px-3 py-2 text-right font-medium">الحالة</th>
                <th className="px-3 py-2 text-right font-medium">عرض</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.internalPoNo}</div>
                    <div className="text-xs text-muted-foreground">{r.customerPoNo}</div>
                  </td>
                  <td className="px-3 py-2">{r.customerName ?? "—"}</td>
                  <td className="px-3 py-2">{fmtDate(r.poDate)}</td>
                  <td className="px-3 py-2">{r.itemCount}</td>
                  <td className="px-3 py-2">
                    {r.fulfillmentStatus ? (
                      <div className="space-y-1">
                        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-emerald-500"
                            style={{ width: `${r.fulfillmentStatus.deliveredPct ?? 0}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {r.fulfillmentStatus.deliveredItems}/{r.fulfillmentStatus.totalItems} بنود مسلّمة · مستلم {r.fulfillmentStatus.receivedItems ?? 0}
                        </span>
                      </div>
                    ) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${r.fulfillmentStatus ? stageTone(r.fulfillmentStatus.stage) : "bg-muted text-muted-foreground"}`}>
                      {r.fulfillmentStatus ? (FULFILLMENT_LABEL[r.fulfillmentStatus.stage] ?? r.fulfillmentStatus.stage) : r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/customer-po/${r.id}`}>
                      <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                        تفاصيل <ArrowUpRight size={12} />
                      </a>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SupplierPoSubTab() {
  const { data: poList, loading: poLoading, error: poError, reload: reloadPo } = useFetch<SupplierPoRow[]>("/api/po");
  const [progressByPo, setProgressByPo] = useState<Record<string, { total: number; received: number; rejected: number; suppliers: string[] }>>({});
  const [onlyReceived, setOnlyReceived] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/po/progress", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((rows: { poId: number; total: number; received: number; rejected: number; suppliers: string[] }[]) => {
        if (cancelled) return;
        const map: Record<string, { total: number; received: number; rejected: number; suppliers: string[] }> = {};
        for (const r of rows) { map[r.poId] = { total: r.total, received: r.received, rejected: r.rejected, suppliers: r.suppliers }; }
        setProgressByPo(map);
      })
      .catch(() => { if (!cancelled) setProgressByPo({}); });
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => {
    if (!poList) return [];
    if (!onlyReceived) return poList;
    return poList.filter((r) => {
      if (r.status === "cancelled") return false;
      const p = progressByPo[r.id];
      if (!p) return false;
      return p.received > 0;
    });
  }, [poList, progressByPo, onlyReceived]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          أوامر شراء الموردين — لا يظهر أمر الشراء هنا إلا بعد وصوله (الاستلام من المورد). يمكنك إظهار الكل للإدارة الكاملة.

        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={onlyReceived}
              onChange={(e) => setOnlyReceived(e.target.checked)}
              className="accent-primary"
            />
            بعد الاستلام فقط
          </label>
          <button
            type="button"
            onClick={() => { reloadPo(); }}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            <RefreshCw size={12} />
            تحديث
          </button>
        </div>
      </div>

      {poLoading ? (
        <p className="text-sm text-muted-foreground">جارٍ التحميل...</p>
      ) : poError ? (
        <p className="text-sm text-destructive">{poError}</p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          لا توجد أوامر شراء موردين {onlyReceived ? "تم استلامها" : ""}؟
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                <th className="px-3 py-2 text-right font-medium">رقم الأمر</th>
                <th className="px-3 py-2 text-right font-medium">المورد</th>
                <th className="px-3 py-2 text-right font-medium">رقم الورقة</th>
                <th className="px-3 py-2 text-right font-medium">البنود</th>
                <th className="px-3 py-2 text-right font-medium">الاستلام</th>
                <th className="px-3 py-2 text-right font-medium">الحالة</th>
                <th className="px-3 py-2 text-right font-medium">عرض</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const p = progressByPo[r.id];
                const receivedPct = p && p.total > 0 ? Math.round((p.received / p.total) * 100) : 0;
                return (
                  <tr key={r.id} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.internalPoNo}</div>
                      {r.createdAt ? <div className="text-xs text-muted-foreground">{fmtDate(r.createdAt)}</div> : null}
                    </td>
                    <td className="px-3 py-2">{p && p.suppliers.length ? p.suppliers.join("، ") : r.receiverName ?? "—"}</td>
                    <td className="px-3 py-2">{r.sheetPoNo}</td>
                    <td className="px-3 py-2">{r.itemCount}</td>
                    <td className="px-3 py-2">
                      {p ? (
                        <div className="space-y-1">
                          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-emerald-500"
                              style={{ width: `${receivedPct}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {p.received}/{p.total} مستلم {p.rejected > 0 ? `· ${p.rejected} مرفوض` : ""}
                          </span>
                        </div>
                      ) : "في انتظار الاستلام"}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${r.status === "cancelled" ? "bg-red-50 text-red-700" : p && p.received > 0 ? "bg-green-50 text-green-700" : "bg-muted text-muted-foreground"}`}>
                        {r.status === "cancelled" ? (PO_STATUS_LABEL.cancelled) : p && p.received > 0 ? "تم الاستلام" : (PO_STATUS_LABEL[r.status] ?? r.status)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/purchase-orders/${r.id}`}>
                        <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                          تفاصيل <ArrowUpRight size={12} />
                        </a>
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function PurchaseOrderAccountsTab() {
  const [sub, setSub] = useState<string>("customer");

  return (
    <Tabs value={sub} onValueChange={setSub}>
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="customer" className="text-xs gap-1.5">
          <PackageCheck size={14} />
          أوامر شراء العملاء
        </TabsTrigger>
        <TabsTrigger value="supplier" className="text-xs gap-1.5">
          <Truck size={14} />
          أوامر شراء الموردين
        </TabsTrigger>
      </TabsList>

      <TabsContent value="customer" className="mt-4">
        <CustPoSubTab />
      </TabsContent>
      <TabsContent value="supplier" className="mt-4">
        <SupplierPoSubTab />
      </TabsContent>
    </Tabs>
  );
}

import { useState } from "react";
import { PageHeader, Loading, ErrorState, DataTable, StatCard } from "../components/ui";
import { useBridgeQuery, bridgePost, egp, type SyncStatus } from "../lib/bridge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

const STATUS_LABEL: Record<string, string> = {
  synced: "تمت",
  failed: "فاشلة",
  pending: "معلّقة",
};

/**
 * حالة المزامنة — every failed RFQ→Odoo sync, with its error and a retry.
 *
 * This is the UI for `GET /accounts/sync-status`. Retrying a SYNCED event is a
 * no-op by construction (the bridge skips events that already carry an Odoo id),
 * so the retry button can never create a duplicate document.
 */
export default function SyncStatusTab() {
  const { data, isLoading, error, reload } = useBridgeQuery<SyncStatus>("/accounts/sync-status");
  const [retrying, setRetrying] = useState<number | null>(null);

  async function retry(id: number) {
    setRetrying(id);
    try {
      const result = await bridgePost<{ status: string; odooId?: number }>(
        `/accounts/sync/replay/${id}`,
      );
      if (result.status === "synced") toast.success("تمت إعادة المزامنة بنجاح");
      else if (result.status === "skipped")
        toast.info("الحدث مُزامَن بالفعل — لم يُنشأ مستند مكرر");
      else toast.error("لم تكتمل المزامنة");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "تعذرت إعادة المحاولة");
    } finally {
      setRetrying(null);
    }
  }

  if (isLoading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="حالة المزامنة"
        subtitle="كل عملية فاشلة في ربط RFQ بـ Odoo، مع سبب الفشل وإعادة المحاولة"
        actions={
          <Button size="sm" variant="outline" onClick={reload} className="gap-1.5">
            <RefreshCw size={14} /> تحديث
          </Button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="إجمالي الأحداث" value={data.counts.total} />
        <StatCard label="تمت المزامنة" value={data.counts.synced} tone="positive" />
        <StatCard
          label="فاشلة"
          value={data.counts.failed}
          tone={data.counts.failed > 0 ? "negative" : "default"}
        />
        <StatCard label="معلّقة" value={data.counts.pending} tone="warning" />
      </div>

      <Card className="p-4 space-y-2">
        <div className="font-medium text-sm">حالة اتصال Odoo</div>
        {data.odoo.ok ? (
          <Badge variant="outline" className="text-emerald-600">
            متصل {data.odoo.version ? `— ${data.odoo.version}` : ""}
          </Badge>
        ) : (
          <div className="text-xs text-red-600">
            غير متصل — {data.odoo.error ?? "تحقق من إعدادات ODOO_*"}
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          نسب الضرائب: ض.ق.م. {data.rates.vatRate}% — خصم تحت حساب المورد{" "}
          {data.rates.withholdingRate}%
        </div>
      </Card>

      <Card className="p-4 space-y-3">
        <div className="font-medium text-sm text-red-600">
          العمليات الفاشلة ({data.failures.length})
        </div>
        <DataTable
          columns={[
            { key: "event", label: "الحدث" },
            { key: "type", label: "النوع", width: "150px" },
            { key: "attempts", label: "المحاولات", align: "end", width: "100px" },
            { key: "error", label: "السبب" },
            { key: "action", label: "", width: "110px" },
          ]}
          rows={data.failures.map((f) => [
            f.eventKey,
            f.eventType,
            f.attempts,
            <span key={f.id} className="text-red-600 text-xs">
              {f.lastError ?? "—"}
            </span>,
            <Button
              key={`btn-${f.id}`}
              size="sm"
              variant="outline"
              disabled={retrying === f.id}
              onClick={() => retry(f.id)}
              className="gap-1 h-7"
            >
              <RefreshCw size={12} className={retrying === f.id ? "animate-spin" : ""} /> إعادة
            </Button>,
          ])}
          empty="لا توجد عمليات فاشلة"
        />
      </Card>

      <Card className="p-4 space-y-3">
        <div className="font-medium text-sm">أحدث الأحداث</div>
        <DataTable
          columns={[
            { key: "event", label: "الحدث" },
            { key: "type", label: "النوع", width: "150px" },
            { key: "status", label: "الحالة", width: "100px" },
            { key: "odoo", label: "مستند Odoo" },
          ]}
          rows={data.recent.map((r) => [
            r.eventKey,
            r.eventType,
            <Badge
              key={r.id}
              variant={
                r.status === "synced"
                  ? "default"
                  : r.status === "failed"
                    ? "destructive"
                    : "outline"
              }
            >
              {STATUS_LABEL[r.status] ?? r.status}
            </Badge>,
            r.odooId ? `${r.odooModel} #${r.odooId}` : "—",
          ])}
          empty="لا توجد أحداث بعد"
        />
      </Card>
    </div>
  );
}

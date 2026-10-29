import { StatCard, PageHeader, Loading, ErrorState, NotConfigured } from "../components/ui";
import { useBridgeQuery, egp, type SyncStatus } from "../lib/bridge";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface DashboardPayload {
  company: { name: string; currency: string; country: string } | null;
  receivables: { total: number; overdue: number; count: number };
  payables: { total: number; overdue: number; count: number };
  sales: { count: number; untaxed: number; tax: number; total: number; residual: number };
  purchases: { count: number; untaxed: number; tax: number; total: number; residual: number };
  payments: { collected: number; paid: number };
}

/** لوحة الحسابات — key totals, read live from Odoo. */
export default function DashboardTab() {
  const { data, isLoading, error, notConfigured, reload } = useBridgeQuery<DashboardPayload>(
    "/accounts/odoo/dashboard",
  );
  const sync = useBridgeQuery<SyncStatus>("/accounts/sync-status");

  if (notConfigured) return <NotConfigured onRetry={reload} />;
  if (isLoading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <ErrorState message="لا توجد بيانات" onRetry={reload} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="لوحة الحسابات"
        subtitle={
          data.company
            ? `${data.company.name} — العملة ${data.company.currency || "—"} — ${data.company.country || "—"}`
            : "المصدر: Odoo"
        }
        actions={
          sync.data?.odoo.ok ? (
            <Badge variant="outline" className="text-emerald-600">
              Odoo متصل
            </Badge>
          ) : (
            <Badge variant="outline" className="text-amber-600">
              Odoo غير متاح
            </Badge>
          )
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="المبيعات (بدون ضريبة)"
          value={egp(data.sales.untaxed)}
          hint={`${data.sales.count} فاتورة`}
        />
        <StatCard label="ض.ق.م. مخرجات" value={egp(data.sales.tax)} tone="warning" />
        <StatCard
          label="المشتريات (بدون ضريبة)"
          value={egp(data.purchases.untaxed)}
          hint={`${data.purchases.count} فاتورة`}
        />
        <StatCard label="ض.ق.م. مدخلات" value={egp(data.purchases.tax)} tone="warning" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="مدينون (ذمم مدينة)"
          value={egp(data.receivables.total)}
          hint={`متأخر ${egp(data.receivables.overdue)}`}
          tone={data.receivables.overdue > 0 ? "negative" : "default"}
        />
        <StatCard
          label="دائنون (ذمم دائنة)"
          value={egp(data.payables.total)}
          hint={`متأخر ${egp(data.payables.overdue)}`}
          tone={data.payables.overdue > 0 ? "negative" : "default"}
        />
        <StatCard label="تحصيلات من العملاء" value={egp(data.payments.collected)} tone="positive" />
        <StatCard label="مدفوعات للموردين" value={egp(data.payments.paid)} />
      </div>

      <Card className="p-4">
        <div className="font-medium text-sm mb-3">حالة مزامنة Odoo</div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="إجمالي الأحداث" value={sync.data?.counts.total ?? 0} />
          <StatCard label="تمت المزامنة" value={sync.data?.counts.synced ?? 0} tone="positive" />
          <StatCard
            label="فاشلة"
            value={sync.data?.counts.failed ?? 0}
            tone={(sync.data?.counts.failed ?? 0) > 0 ? "negative" : "default"}
          />
          <StatCard label="معلّقة" value={sync.data?.counts.pending ?? 0} tone="warning" />
        </div>
        {sync.data?.failures.length ? (
          <div className="mt-3 text-xs text-red-600">
            يوجد {sync.data.failures.length} عملية فاشلة — راجع تبويب «حالة المزامنة».
          </div>
        ) : null}
      </Card>
    </div>
  );
}

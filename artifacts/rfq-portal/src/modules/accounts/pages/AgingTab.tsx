import { useState } from "react";
import {
  PageHeader,
  Loading,
  ErrorState,
  NotConfigured,
  DataTable,
  StatCard,
} from "../components/ui";
import { useBridgeQuery, egp, type AgingReport } from "../lib/bridge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";

/** أعمار الديون — receivables and payables aging, bucketed by days past due. */
export default function AgingTab() {
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [applied, setApplied] = useState(asOf);

  const receivables = useBridgeQuery<AgingReport>("/accounts/odoo/aging/receivables", {
    asOf: applied,
  });
  const payables = useBridgeQuery<AgingReport>("/accounts/odoo/aging/payables", { asOf: applied });

  if (receivables.notConfigured || payables.notConfigured) {
    return <NotConfigured onRetry={() => setApplied(asOf)} />;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="أعمار الديون"
        subtitle="من Odoo — الفواتير المرحَّلة غير المسددة"
        actions={
          <div className="flex items-end gap-2">
            <div>
              <label className="text-muted-foreground text-xs block mb-1">حتى تاريخ</label>
              <Input
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                className="h-8 w-40"
              />
            </div>
          </div>
        }
      />

      <Tabs defaultValue="ar">
        <TabsList>
          <TabsTrigger value="ar">ذمم مدينة (عملاء)</TabsTrigger>
          <TabsTrigger value="ap">ذمم دائنة (موردون)</TabsTrigger>
        </TabsList>
        <TabsContent value="ar">
          <AgingView query={receivables} />
        </TabsContent>
        <TabsContent value="ap">
          <AgingView query={payables} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AgingView({ query }: { query: ReturnType<typeof useBridgeQuery<AgingReport>> }) {
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorState message={query.error} onRetry={query.reload} />;
  if (!query.data) return null;
  const d = query.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <StatCard label="إجمالي المستحق" value={egp(d.total)} />
        <StatCard
          label="متأخر"
          value={egp(d.overdue)}
          tone={d.overdue > 0 ? "negative" : "default"}
        />
        <StatCard label="عدد الفواتير" value={d.rows.length} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {d.buckets.map((b) => (
          <StatCard
            key={b.label}
            label={b.label}
            value={egp(b.amount)}
            hint={`${b.count} فاتورة`}
            tone={b.label.includes("90") && b.amount > 0 ? "negative" : "default"}
          />
        ))}
      </div>

      <Card className="p-4">
        <DataTable
          columns={[
            { key: "partner", label: "الطرف" },
            { key: "invoice", label: "الفاتورة", width: "150px" },
            { key: "due", label: "تاريخ الاستحقاق", width: "140px" },
            { key: "days", label: "أيام التأخير", align: "end" },
            { key: "amount", label: "المتبقي", align: "end" },
          ]}
          rows={d.rows.map((r) => [
            r.partner,
            r.invoice,
            r.dueDate || "—",
            r.daysPastDue > 0 ? r.daysPastDue : "—",
            egp(r.residual),
          ])}
          empty="لا توجد أرصدة مستحقة"
        />
      </Card>
    </div>
  );
}

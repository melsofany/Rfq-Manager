import { useState } from "react";
import { PageHeader, Loading, ErrorState, NotConfigured, DataTable } from "../components/ui";
import { useBridgeQuery, egp, type OdooAccount } from "../lib/bridge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const TYPE_LABEL: Record<string, string> = {
  asset_receivable: "أصول — ذمم مدينة",
  asset_cash: "أصول — نقدية",
  asset_current: "أصول — متداولة",
  asset_non_current: "أصول — غير متداولة",
  asset_prepayments: "أصول — مصروفات مقدمة",
  asset_fixed: "أصول — ثابتة",
  liability_payable: "التزامات — ذمم دائنة",
  liability_credit_card: "التزامات — بطاقات",
  liability_current: "التزامات — متداولة",
  liability_non_current: "التزامات — غير متداولة",
  equity: "حقوق ملكية",
  equity_unaffected: "حقوق ملكية — أرباح مدورة",
  income: "إيرادات",
  income_other: "إيرادات أخرى",
  expense: "مصروفات",
  expense_direct_cost: "تكلفة مباشرة",
  expense_depreciation: "إهلاك",
};

/** دليل الحسابات — the Odoo chart of accounts. */
export default function ChartOfAccountsTab() {
  const [filter, setFilter] = useState("");
  const { data, isLoading, error, notConfigured, reload } = useBridgeQuery<{
    accounts: OdooAccount[];
  }>("/accounts/odoo/coa");

  if (notConfigured) return <NotConfigured onRetry={reload} />;
  if (isLoading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const accounts = (data?.accounts ?? []).filter((a) => {
    const q = filter.trim();
    if (!q) return true;
    return a.code.includes(q) || a.name.includes(q);
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="دليل الحسابات"
        subtitle={`من Odoo — ${data?.accounts.length ?? 0} حساب`}
        actions={
          <Input
            placeholder="بحث بالكود أو الاسم…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 max-w-xs"
          />
        }
      />
      <Card className="p-4">
        <DataTable
          columns={[
            { key: "code", label: "الكود", width: "110px" },
            { key: "name", label: "اسم الحساب" },
            { key: "type", label: "النوع" },
            { key: "reconcile", label: "قابل للتسوية", align: "end", width: "120px" },
          ]}
          rows={accounts.map((a) => [
            a.code,
            a.name,
            TYPE_LABEL[a.account_type] ?? a.account_type,
            a.reconcile ? "نعم" : "لا",
          ])}
          empty="لا توجد حسابات مطابقة"
        />
      </Card>
    </div>
  );
}

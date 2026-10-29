import { useState } from "react";
import {
  PageHeader,
  Loading,
  ErrorState,
  NotConfigured,
  DataTable,
  DateRangeBar,
  StatementSectionView,
} from "../components/ui";
import {
  useBridgeQuery,
  egp,
  type IncomeStatement,
  type BalanceSheet,
  type TrialBalanceRow,
} from "../lib/bridge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AlertCircle } from "lucide-react";

function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const from = `${now.getFullYear()}-01-01`;
  const to = now.toISOString().slice(0, 10);
  return { from, to };
}

/**
 * القوائم المالية — income statement, balance sheet and trial balance, all read
 * from Odoo's posted move lines over the selected date range.
 */
export default function FinancialStatementsTab() {
  const [range, setRange] = useState(defaultRange);
  const [applied, setApplied] = useState(defaultRange);
  const params = { from: applied.from, to: applied.to };

  const income = useBridgeQuery<IncomeStatement>(
    "/accounts/odoo/statements/income-statement",
    params,
  );
  const balance = useBridgeQuery<BalanceSheet>("/accounts/odoo/statements/balance-sheet", params);
  const trial = useBridgeQuery<{
    rows: TrialBalanceRow[];
    totalDebit: number;
    totalCredit: number;
  }>("/accounts/odoo/statements/trial-balance", params);

  const anyNotConfigured = income.notConfigured || balance.notConfigured || trial.notConfigured;
  if (anyNotConfigured) return <NotConfigured onRetry={() => setApplied({ ...range })} />;

  const bar = (
    <DateRangeBar
      from={range.from}
      to={range.to}
      onChange={setRange}
      onApply={() => setApplied({ ...range })}
      loading={income.isLoading || balance.isLoading || trial.isLoading}
    />
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="القوائم المالية"
        subtitle="من Odoo — الحركات المرحَّلة فقط"
        actions={bar}
      />

      <Tabs defaultValue="income">
        <TabsList>
          <TabsTrigger value="income">قائمة الدخل</TabsTrigger>
          <TabsTrigger value="balance">الميزانية العمومية</TabsTrigger>
          <TabsTrigger value="trial">ميزان المراجعة</TabsTrigger>
        </TabsList>

        <TabsContent value="income">
          {income.isLoading ? (
            <Loading />
          ) : income.error ? (
            <ErrorState message={income.error} onRetry={income.reload} />
          ) : income.data ? (
            <Card className="p-4 space-y-4">
              <StatementSectionView section={income.data.revenue} totalLabel="إجمالي الإيرادات" />
              <StatementSectionView section={income.data.expenses} totalLabel="إجمالي المصروفات" />
              <div className="flex justify-between text-base font-bold border-t pt-3">
                <span>صافي الربح</span>
                <span className={income.data.netProfit >= 0 ? "text-emerald-600" : "text-red-600"}>
                  {egp(income.data.netProfit)}
                </span>
              </div>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="balance">
          {balance.isLoading ? (
            <Loading />
          ) : balance.error ? (
            <ErrorState message={balance.error} onRetry={balance.reload} />
          ) : balance.data ? (
            <Card className="p-4 space-y-4">
              {!balance.data.balanced ? (
                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <div>
                    الميزانية غير متوازنة بفرق {egp(balance.data.difference)}. الإيرادات والمصروفات
                    تُضاف إلى حقوق الملكية كنتيجة الفترة حتى إقفال السنة.
                  </div>
                </div>
              ) : null}
              <StatementSectionView section={balance.data.assets} totalLabel="إجمالي الأصول" />
              <StatementSectionView
                section={balance.data.liabilities}
                totalLabel="إجمالي الالتزامات"
              />
              <StatementSectionView
                section={balance.data.equity}
                totalLabel="إجمالي حقوق الملكية"
              />
              <div className="flex justify-between text-sm border-t pt-2">
                <span>نتيجة الفترة</span>
                <span>{egp(balance.data.currentPeriodResult)}</span>
              </div>
              <div className="flex justify-between text-base font-bold border-t pt-3">
                <span>إجمالي الالتزامات + حقوق الملكية</span>
                <span>{egp(balance.data.totalLiabilitiesAndEquity)}</span>
              </div>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="trial">
          {trial.isLoading ? (
            <Loading />
          ) : trial.error ? (
            <ErrorState message={trial.error} onRetry={trial.reload} />
          ) : trial.data ? (
            <Card className="p-4 space-y-3">
              <DataTable
                columns={[
                  { key: "code", label: "الكود", width: "90px" },
                  { key: "name", label: "الحساب" },
                  { key: "debit", label: "مدين", align: "end" },
                  { key: "credit", label: "دائن", align: "end" },
                  { key: "balance", label: "الرصيد", align: "end" },
                ]}
                rows={trial.data.rows.map((r) => [
                  r.code,
                  r.name,
                  egp(r.debit),
                  egp(r.credit),
                  egp(r.balance),
                ])}
                empty="لا توجد حركات في هذه الفترة"
              />
              <div className="flex justify-between text-sm font-medium border-t pt-2">
                <span>الإجمالي</span>
                <span>
                  مدين {egp(trial.data.totalDebit)} — دائن {egp(trial.data.totalCredit)}
                </span>
              </div>
            </Card>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}

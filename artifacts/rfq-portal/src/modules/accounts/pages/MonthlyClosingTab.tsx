import { useState } from "react";
import {
  PageHeader,
  Loading,
  ErrorState,
  NotConfigured,
  DataTable,
  StatCard,
} from "../components/ui";
import { useBridgeQuery, egp, type IncomeStatement } from "../lib/bridge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

function lastMonths(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

/**
 * الإقفال الشهري والهوامش — the month's income statement and the margin it
 * implies, computed from Odoo's posted movements. "Closing" here means reading
 * the month's result and confirming the sheet balances; Odoo itself owns the
 * year-end close.
 */
export default function MonthlyClosingTab() {
  const months = lastMonths(12);
  const [month, setMonth] = useState(months[0]);
  const range = monthRange(month);

  const income = useBridgeQuery<IncomeStatement>(
    "/accounts/odoo/statements/income-statement",
    range,
  );
  const balance = useBridgeQuery<{
    balanced: boolean;
    difference: number;
    currentPeriodResult: number;
  }>("/accounts/odoo/statements/balance-sheet", range);

  if (income.notConfigured) return <NotConfigured onRetry={income.reload} />;

  const grossMarginPct =
    income.data && income.data.revenue.total > 0
      ? (income.data.netProfit / income.data.revenue.total) * 100
      : 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="الإقفال الشهري والهوامش"
        subtitle="من Odoo — نتيجة الشهر وهامش الربح"
        actions={
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <Tabs defaultValue="closing">
        <TabsList>
          <TabsTrigger value="closing">الإقفال الشهري</TabsTrigger>
          <TabsTrigger value="margins">الهوامش</TabsTrigger>
        </TabsList>

        <TabsContent value="closing">
          {income.isLoading ? (
            <Loading />
          ) : income.error ? (
            <ErrorState message={income.error} onRetry={income.reload} />
          ) : income.data ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard label="إيرادات الشهر" value={egp(income.data.revenue.total)} />
                <StatCard
                  label="مصروفات الشهر"
                  value={egp(income.data.expenses.total)}
                  tone="warning"
                />
                <StatCard
                  label="نتيجة الشهر"
                  value={egp(income.data.netProfit)}
                  tone={income.data.netProfit >= 0 ? "positive" : "negative"}
                />
                <StatCard
                  label="حالة الميزانية"
                  value={balance.data?.balanced ? "متوازنة" : "غير متوازنة"}
                  tone={balance.data?.balanced ? "positive" : "negative"}
                />
              </div>
              <Card className="p-4">
                <DataTable
                  columns={[
                    { key: "code", label: "الكود", width: "90px" },
                    { key: "name", label: "الحساب" },
                    { key: "amount", label: "المبلغ", align: "end" },
                  ]}
                  rows={[
                    ...income.data.revenue.rows.map((r) => [r.code, r.name, egp(r.balance)]),
                    ...income.data.expenses.rows.map((r) => [r.code, r.name, egp(r.balance)]),
                  ]}
                  empty="لا توجد حركات في هذا الشهر"
                />
              </Card>
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="margins">
          {income.isLoading ? (
            <Loading />
          ) : income.data ? (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <StatCard label="الإيرادات" value={egp(income.data.revenue.total)} />
              <StatCard label="التكلفة والمصروفات" value={egp(income.data.expenses.total)} />
              <StatCard
                label="هامش الربح"
                value={`${grossMarginPct.toFixed(2)}%`}
                tone={grossMarginPct >= 0 ? "positive" : "negative"}
              />
            </div>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}

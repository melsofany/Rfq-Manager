import { useState } from "react";
import {
  PageHeader,
  Loading,
  ErrorState,
  NotConfigured,
  DataTable,
  DateRangeBar,
} from "../components/ui";
import { useBridgeQuery, egp, type OdooMoveLine, type OdooAccount } from "../lib/bridge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";

function partnerName(p: [number, string] | false): string {
  return Array.isArray(p) ? String(p[1]) : "—";
}

/** القيود والدفاتر — journal entries and the general ledger, from Odoo. */
export default function JournalsTab() {
  const now = new Date();
  const [range, setRange] = useState({
    from: `${now.getFullYear()}-01-01`,
    to: now.toISOString().slice(0, 10),
  });
  const [applied, setApplied] = useState(range);
  const [accountFilter, setAccountFilter] = useState("");

  const accounts = useBridgeQuery<{ accounts: OdooAccount[] }>("/accounts/odoo/coa");
  const journals = useBridgeQuery<{
    lines: OdooMoveLine[];
    totalDebit: number;
    totalCredit: number;
  }>("/accounts/odoo/journals", { from: applied.from, to: applied.to });

  if (journals.notConfigured || accounts.notConfigured) {
    return <NotConfigured onRetry={() => setApplied({ ...range })} />;
  }

  const lines = (journals.data?.lines ?? []).filter((l) => {
    if (!accountFilter.trim()) return true;
    const acct = Array.isArray(l.account_id) ? String(l.account_id[1]) : "";
    return acct.includes(accountFilter.trim()) || l.move_name?.includes(accountFilter.trim());
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="القيود والدفاتر"
        subtitle="من Odoo — القيود المحاسبية ودفتر الأستاذ العام"
        actions={
          <DateRangeBar
            from={range.from}
            to={range.to}
            onChange={setRange}
            onApply={() => setApplied({ ...range })}
            loading={journals.isLoading}
          />
        }
      />

      <Tabs defaultValue="journal">
        <TabsList>
          <TabsTrigger value="journal">القيود المحاسبية</TabsTrigger>
          <TabsTrigger value="ledger">دفتر الأستاذ العام</TabsTrigger>
        </TabsList>

        <TabsContent value="journal">
          <Card className="p-4 space-y-3">
            <Input
              placeholder="تصفية برقم القيد أو اسم الحساب…"
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="h-8 max-w-xs"
            />
            {journals.isLoading ? (
              <Loading />
            ) : journals.error ? (
              <ErrorState message={journals.error} onRetry={journals.reload} />
            ) : (
              <>
                <DataTable
                  columns={[
                    { key: "date", label: "التاريخ", width: "110px" },
                    { key: "move", label: "القيد", width: "140px" },
                    { key: "account", label: "الحساب" },
                    { key: "partner", label: "الطرف" },
                    { key: "desc", label: "البيان" },
                    { key: "debit", label: "مدين", align: "end" },
                    { key: "credit", label: "دائن", align: "end" },
                  ]}
                  rows={lines.map((l) => [
                    l.date,
                    l.move_name,
                    Array.isArray(l.account_id) ? String(l.account_id[1]) : "—",
                    partnerName(l.partner_id),
                    l.name,
                    egp(l.debit),
                    egp(l.credit),
                  ])}
                  empty="لا توجد قيود في هذه الفترة"
                />
                <div className="flex justify-between text-sm font-medium border-t pt-2">
                  <span>الإجمالي ({lines.length} سطر)</span>
                  <span>
                    مدين {egp(journals.data?.totalDebit ?? 0)} — دائن{" "}
                    {egp(journals.data?.totalCredit ?? 0)}
                  </span>
                </div>
              </>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="ledger">
          <Card className="p-4 space-y-3">
            <div className="text-xs text-muted-foreground">
              دفتر الأستاذ العام يعرض حركات كل حساب مع رصيده التراكمي خلال الفترة.
            </div>
            {journals.isLoading ? (
              <Loading />
            ) : (
              <LedgerView
                lines={journals.data?.lines ?? []}
                accounts={accounts.data?.accounts ?? []}
              />
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Group the move lines by account and show a running balance per account. */
function LedgerView({ lines, accounts }: { lines: OdooMoveLine[]; accounts: OdooAccount[] }) {
  const byAccount = new Map<number, { name: string; lines: OdooMoveLine[] }>();
  for (const l of lines) {
    if (!Array.isArray(l.account_id)) continue;
    const [id, name] = l.account_id;
    if (!byAccount.has(id)) byAccount.set(id, { name: String(name), lines: [] });
    byAccount.get(id)!.lines.push(l);
  }
  const codeOf = new Map(accounts.map((a) => [a.id, a.code]));

  if (!byAccount.size)
    return <div className="py-10 text-center text-muted-foreground text-sm">لا توجد حركات</div>;

  return (
    <div className="space-y-5">
      {[...byAccount.entries()].map(([id, group]) => {
        let running = 0;
        const sorted = [...group.lines].sort((a, b) => a.date.localeCompare(b.date));
        return (
          <div key={id} className="space-y-2">
            <div className="font-medium text-sm">
              {codeOf.get(id) ?? id} — {group.name}
            </div>
            <DataTable
              columns={[
                { key: "date", label: "التاريخ", width: "110px" },
                { key: "move", label: "القيد", width: "140px" },
                { key: "desc", label: "البيان" },
                { key: "debit", label: "مدين", align: "end" },
                { key: "credit", label: "دائن", align: "end" },
                { key: "balance", label: "الرصيد", align: "end" },
              ]}
              rows={sorted.map((l) => {
                running += l.debit - l.credit;
                return [l.date, l.move_name, l.name, egp(l.debit), egp(l.credit), egp(running)];
              })}
            />
          </div>
        );
      })}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  BookCopy, Scale, CalendarCheck, MoreHorizontal, RefreshCw,
  BookOpen, FileText, Truck, BarChart3, Percent,
} from "lucide-react";
import JournalTab from "./JournalTab";
import ClosingTab from "./ClosingTab";
import ChartOfAccountsTab from "./ChartOfAccountsTab";
import SalesAndCollectionsTab from "./SalesAndCollectionsTab";
import SuppliersTab from "./SuppliersTab";
import ReportsTab from "./ReportsTab";
import TaxesTab from "./TaxesTab";

interface TrialLine {
  code: string;
  nameAr: string;
  type: string;
  debit: string;
  credit: string;
}
interface TrialBalance {
  from: string | null;
  to: string | null;
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
  lines: TrialLine[];
}

function typeLabel(t: string): string {
  switch (t) {
    case "asset": return "أصول";
    case "liability": return "خصوم";
    case "equity": return "حقوق ملكية";
    case "revenue": return "إيرادات";
    case "expense": return "مصروفات";
    default: return t;
  }
}

function useTrialBalance(from: string, to: string): { data: TrialBalance | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<TrialBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    setLoading(true);
    setError(null);
    fetch(`/api/accounts/trial-balance?${qs.toString()}}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json() ).error ?? "فشل التحميل");
        return r.json() as Promise<TrialBalance>;
      })
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e: Error) => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [from, to, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

function TrialBalanceView() {
  const today = new Date();
  const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today.toISOString().slice(0, 10));
  const [appliedFrom, setAppliedFrom] = useState(monthStart);
  const [appliedTo, setAppliedTo] = useState(today.toISOString().slice(0, 10));
  const { data, loading, error, reload } = useTrialBalance(appliedFrom, appliedTo);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">من تاريخ</label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">إلى تاريخ</label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => { setAppliedFrom(from); setAppliedTo(to); }}
        >
          تطبيق
        </Button>
        <Button size="sm" variant="outline" onClick={reload}>
          <RefreshCw size={14} />
          تحديث
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">جارٍ التحميل...</p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : data ? (
        <div className="space-y-4">
          <div className={`flex flex-wrap gap-3 rounded-lg border p-3 text-sm ${data.balanced ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`}>
            <span>إجمالي المدين: {data.totalDebit}</span>
            <span>إجمالي الدائن: {data.totalCredit}</span>
            <span>{data.balanced ? "✓ الميزان متوازن" : "✗ الميزان غير متوازن — راجع القيود"}</span>
          </div>
          {data.lines.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              لا توجد أرصدة في هذه الفترة؟
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                    <th className="px-3 py-2 text-right font-medium">الكود</th>
                    <th className="px-3 py-2 text-right font-medium">الحساب</th>
                    <th className="px-3 py-2 text-right font-medium">النوع</th>
                    <th className="px-3 py-2 text-right font-medium">مدين</th>
                    <th className="px-3 py-2 text-right font-medium">دائن</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l) => (
                    <tr key={l.code} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2">{l.code}</td>
                      <td className="px-3 py-2">{l.nameAr}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{typeLabel(l.type)}</td>
                      <td className="px-3 py-2">{l.debit}</td>
                      <td className="px-3 py-2">{l.credit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function GeneralAccountingTab() {
  return (
    <Tabs defaultValue="journal">
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="journal" className="text-xs gap-1.5">
          <BookCopy size={14} /> قيود اليومية
        </TabsTrigger>
        <TabsTrigger value="trial" className="text-xs gap-1.5">
          <Scale size={14} /> ميزان المراجعة
        </TabsTrigger>
        <TabsTrigger value="closings" className="text-xs gap-1.5">
          <CalendarCheck size={14} /> الإقفال الشهري
        </TabsTrigger>
        <TabsTrigger value="advanced" className="text-xs gap-1.5">
          <MoreHorizontal size={14} /> إدارة متقدمة
        </TabsTrigger>
      </TabsList>

      <TabsContent value="journal" className="mt-4">
        <JournalTab />
      </TabsContent>
      <TabsContent value="trial" className="mt-4">
        <TrialBalanceView />
      </TabsContent>
      <TabsContent value="closings" className="mt-4">
        <ClosingTab />
      </TabsContent>
      <TabsContent value="advanced" className="mt-4">
        <AdvancedSubTabs />
      </TabsContent>
    </Tabs>
  );
}

function AdvancedSubTabs() {
  return (
    <Tabs defaultValue="coa">
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="coa" className="text-xs gap-1.5"><BookOpen size={14} /> دليل الحسابات</TabsTrigger>
        <TabsTrigger value="sales" className="text-xs gap-1.5"><FileText size={14} /> فواتير البيع والتحصيل</TabsTrigger>
        <TabsTrigger value="suppliers" className="text-xs gap-1.5"><Truck size={14} /> فواتير الموردين وخصم تحت حساب المورد</TabsTrigger>
        <TabsTrigger value="reports" className="text-xs gap-1.5"><BarChart3 size={14} /> التقارير المالية</TabsTrigger>
        <TabsTrigger value="taxes" className="text-xs gap-1.5"><Percent size={14} /> الضرائب</TabsTrigger>
      </TabsList>
      <TabsContent value="coa" className="mt-4"><ChartOfAccountsTab /></TabsContent>
      <TabsContent value="sales" className="mt-4"><SalesAndCollectionsTab /></TabsContent>
      <TabsContent value="suppliers" className="mt-4"><SuppliersTab /></TabsContent>
      <TabsContent value="reports" className="mt-4"><ReportsTab /></TabsContent>
      <TabsContent value="taxes" className="mt-4"><TaxesTab /></TabsContent>
    </Tabs>
  );
}
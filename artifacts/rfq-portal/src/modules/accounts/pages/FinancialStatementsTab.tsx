import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Scale, FileBarChart, BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

function fmt(v: string | null | undefined): string {
  if (v == null || v === "") return "-";
  const n = Number(v);
  if (!isFinite(n)) return v;
  return n.toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function FinancialStatementsTab() {
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        القوائم المالية المُجمّعة من دليل الحسابات المرحّلة — ميزان المراجعة، قائمة الدخل، والميزانية العمومية.
      </p>
      <Tabs defaultValue="trial">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="trial" className="text-xs gap-1.5"><Scale size={14} /> ميزان المراجعة</TabsTrigger>
          <TabsTrigger value="income" className="text-xs gap-1.5"><BarChart3 size={14} /> قائمة الدخل</TabsTrigger>
          <TabsTrigger value="balance" className="text-xs gap-1.5"><FileBarChart size={14} /> الميزانية</TabsTrigger>
        </TabsList>
        <TabsContent value="trial" className="mt-4"><TrialBalance /></TabsContent>
        <TabsContent value="income" className="mt-4"><IncomeStatement /></TabsContent>
        <TabsContent value="balance" className="mt-4"><BalanceSheet /></TabsContent>
      </Tabs>
    </div>
  );
}

function TrialBalance() {
  const [data, setData] = useState<{ lines: Array<{ code: string; nameAr: string; type: string; debit: string | null; credit: string | null }>; totalDebit: string | null; totalCredit: string | null; balanced: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    try {
      const r = await fetch(`/api/accounts/trial-balance${qs ? `?${qs}` : ""}`, { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل ميزان المراجعة");
      setData(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل ميزان المراجعة"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div><Label className="text-xs mb-1 block">من تاريخ</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-sm w-40" /></div>
        <div><Label className="text-xs mb-1 block">إلى تاريخ</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-sm w-40" /></div>
        <Button onClick={load} size="sm" className="gap-1.5">تحديث</Button>
      </div>
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        {loading ? <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border bg-muted/30 text-left"><th className="px-3 py-3 text-muted-foreground text-xs">الكود</th><th className="px-3 py-3 text-muted-foreground text-xs">الحساب</th><th className="px-3 py-3 text-muted-foreground text-xs">النوع</th><th className="px-3 py-3 text-muted-foreground text-xs">مدين</th><th className="px-3 py-3 text-muted-foreground text-xs">دائن</th></tr></thead>
              <tbody>
                {(data?.lines ?? []).map((l) => (
                  <tr key={l.code} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-primary">{l.code}</td>
                    <td className="px-3 py-2 text-xs">{l.nameAr}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{l.type}</td>
                    <td className="px-3 py-2 text-xs">{fmt(l.debit)}</td>
                    <td className="px-3 py-2 text-xs">{fmt(l.credit)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/20">
                  <td colSpan={3} className="px-3 py-3 text-xs font-bold text-left">الإجمالي</td>
                  <td className="px-3 py-3 text-xs font-bold">{fmt(data?.totalDebit)}</td>
                  <td className="px-3 py-3 text-xs font-bold">{fmt(data?.totalCredit)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {data && (
          <div className={`px-3 py-2 text-xs font-medium ${data.balanced ? "text-emerald-600 bg-emerald-50" : "text-red-600 bg-red-50"}`}>
            {data.balanced ? "✓ ميزان المراجعة متوازن" : "⚠ ميزان المراجعة غير متوازن"}
          </div>
        )}
      </div>
    </div>
  );
}

function IncomeStatement() {
  const [data, setData] = useState<{ revenue: Array<{ code: string; nameAr: string; amount: string | null }>; expenses: Array<{ code: string; nameAr: string; amount: string | null }>; totalRevenue: string | null; totalExpense: string | null; netProfit: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    try {
      const r = await fetch(`/api/accounts/income-statement${qs ? `?${qs}` : ""}`, { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل قائمة الدخل");
      setData(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل قائمة الدخل"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const profit = Number(data?.netProfit ?? 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div><Label className="text-xs mb-1 block">من تاريخ</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-sm w-40" /></div>
        <div><Label className="text-xs mb-1 block">إلى تاريخ</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-sm w-40" /></div>
        <Button onClick={load} size="sm" className="gap-1.5">تحديث</Button>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Section title="الإيرادات" rows={data?.revenue} total={data?.totalRevenue} tone="profit" loading={loading} />
        <Section title="المصروفات" rows={data?.expenses} total={data?.totalExpense} tone="loss" loading={loading} />
      </div>
      <div className={`bg-card border rounded-lg p-4 flex items-center justify-between ${profit >= 0 ? "border-emerald-300 bg-emerald-50/50" : "border-red-300 bg-red-50/50"}`}>
        <span className="text-sm font-semibold">صافي {profit >= 0 ? "الربح" : "الخسارة"}</span>
        <span className={`text-2xl font-bold ${profit >= 0 ? "text-emerald-600" : "text-red-600"}`}>{fmt(data?.netProfit)}</span>
      </div>
    </div>
  );
}

function BalanceSheet() {
  const [data, setData] = useState<{ assets: Array<{ code: string; nameAr: string; amount: string | null }>; liabilities: Array<{ code: string; nameAr: string; amount: string | null }>; equity: Array<{ code: string; nameAr: string; amount: string | null }>; totalAssets: string | null; totalLiabilities: string | null; totalEquity: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [asOf, setAsOf] = useState("");

  async function load() {
    setLoading(true);
    const qs = asOf ? `?asOf=${asOf}` : "";
    try {
      const r = await fetch(`/api/accounts/balance-sheet${qs}`, { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل الميزانية");
      setData(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل الميزانية"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div><Label className="text-xs mb-1 block">كما في تاريخ</Label><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-8 text-sm w-40" /></div>
        <Button onClick={load} size="sm" className="gap-1.5">تحديث</Button>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Section title="الأصول" rows={data?.assets} total={data?.totalAssets} tone="asset" loading={loading} />
        <Section title="الخصوم" rows={data?.liabilities} total={data?.totalLiabilities} tone="loss" loading={loading} />
        <Section title="حقوق الملكية" rows={data?.equity} total={data?.totalEquity} tone="equity" loading={loading} />
      </div>
      <div className="bg-card border border-border rounded-lg p-4 flex items-center justify-between">
        <span className="text-sm font-semibold">الخصوم + حقوق الملكية</span>
        <span className="text-xl font-bold text-primary">{fmt(String((Number(data?.totalLiabilities ?? 0) + Number(data?.totalEquity ?? 0)).toFixed(2)))}</span>
      </div>
    </div>
  );
}

function Section({ title, rows, total, tone, loading }: { title: string; rows?: Array<{ code: string; nameAr: string; amount: string | null }>; total?: string | null; tone: "profit" | "loss" | "asset" | "equity"; loading: boolean }) {
  const toneClass = tone === "profit" ? "text-emerald-600" : tone === "loss" ? "text-red-600" : tone === "asset" ? "text-blue-600" : "text-purple-600";
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center justify-between">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <span className={`text-xs font-bold ${toneClass}`}>{fmt(total)}</span>
      </div>
      {loading ? <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div> : (rows?.length ?? 0) === 0 ? <div className="p-6 text-center text-muted-foreground text-xs">لا توجد بنود</div> : (
        <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
          <table className="w-full text-sm">
            <tbody>
              {(rows ?? []).map((r) => (
                <tr key={r.code} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-mono text-xs text-primary">{r.code}</td>
                  <td className="px-3 py-2 text-xs">{r.nameAr}</td>
                  <td className="px-3 py-2 text-xs font-medium text-left">{fmt(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

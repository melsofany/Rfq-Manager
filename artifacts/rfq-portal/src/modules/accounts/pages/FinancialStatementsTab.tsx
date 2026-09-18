import { useCallback, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Scale, FileBarChart, BarChart3, Clock } from "lucide-react";
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
        القوائم المالية المُجمّعة من دليل الحسابات المرحّلة — ميزان المراجعة، قائمة الدخل،
        والميزانية العمومية.
      </p>
      <Tabs defaultValue="trial">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="trial" className="text-xs gap-1.5">
            <Scale size={14} /> ميزان المراجعة
          </TabsTrigger>
          <TabsTrigger value="income" className="text-xs gap-1.5">
            <BarChart3 size={14} /> قائمة الدخل
          </TabsTrigger>
          <TabsTrigger value="balance" className="text-xs gap-1.5">
            <FileBarChart size={14} /> الميزانية
          </TabsTrigger>
          <TabsTrigger value="aging" className="text-xs gap-1.5">
            <Clock size={14} /> أعمار الديون
          </TabsTrigger>
        </TabsList>
        <TabsContent value="trial" className="mt-4">
          <TrialBalance />
        </TabsContent>
        <TabsContent value="income" className="mt-4">
          <IncomeStatement />
        </TabsContent>
        <TabsContent value="balance" className="mt-4">
          <BalanceSheet />
        </TabsContent>
        <TabsContent value="aging" className="mt-4">
          <AgingReport />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// أعمار الديون — who owes us / whom we owe, bucketed by how late it is.
// The oldest debt is listed first because that is the order it gets chased in.
function AgingReport() {
  const [kind, setKind] = useState<"receivables" | "payables">("receivables");
  const [asOf, setAsOf] = useState("");
  const [data, setData] = useState<{
    asOf: string;
    buckets: Array<{ bucket: string; label: string; amount: string | null }>;
    total: string | null;
    overdue: string | null;
    count: number;
    rows: Array<{
      id: number;
      documentNo: string | null;
      partyName: string | null;
      documentDate: string | null;
      dueDate: string | null;
      balance: number;
      daysOverdue: number;
      bucket: string;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = asOf ? `?asOf=${asOf}` : "";
    try {
      const r = await fetch(`/api/accounts/aging/${kind}${qs}`, { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل أعمار الديون");
      setData(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل أعمار الديون"));
    } finally {
      setLoading(false);
    }
  }, [kind, asOf]);

  useEffect(() => {
    load();
  }, [load]);

  const bucketTone: Record<string, string> = {
    current: "text-emerald-600",
    d1_30: "text-amber-600",
    d31_60: "text-orange-600",
    d61_90: "text-red-600",
    d90_plus: "text-red-800 dark:text-red-400",
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <Tabs value={kind} onValueChange={(v) => setKind(v as "receivables" | "payables")}>
          <TabsList>
            <TabsTrigger value="receivables" className="text-xs">
              ذمم العملاء (مدينة)
            </TabsTrigger>
            <TabsTrigger value="payables" className="text-xs">
              ذمم الموردين (دائنة)
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div>
          <Label className="text-xs mb-1 block">كما في تاريخ</Label>
          <Input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="h-8 text-sm w-40"
          />
        </div>
        <Button onClick={load} size="sm" className="gap-1.5">
          تحديث
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {(data?.buckets ?? []).map((b) => (
          <div key={b.bucket} className="bg-card border border-border rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground mb-1">{b.label}</p>
            <p className={`text-sm font-bold ${bucketTone[b.bucket] ?? ""}`}>{fmt(b.amount)}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-card border border-border rounded-lg p-3">
          <p className="text-[11px] text-muted-foreground mb-1">إجمالي المديونية</p>
          <p className="text-sm font-bold">{fmt(data?.total)}</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-3">
          <p className="text-[11px] text-muted-foreground mb-1">المتأخر عن السداد</p>
          <p className="text-sm font-bold text-red-600">{fmt(data?.overdue)}</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-3">
          <p className="text-[11px] text-muted-foreground mb-1">عدد المستندات</p>
          <p className="text-sm font-bold">{data?.count ?? 0}</p>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
        ) : (data?.rows?.length ?? 0) === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">لا توجد أرصدة مستحقة</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 border-b border-border">
                <tr>
                  <th className="px-3 py-2 text-right text-xs font-semibold">المستند</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold">
                    {kind === "receivables" ? "العميل" : "المورد"}
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-semibold">تاريخ الاستحقاق</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold">أيام التأخير</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold">الرصيد</th>
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-primary">{r.documentNo}</td>
                    <td className="px-3 py-2 text-xs">{r.partyName}</td>
                    <td className="px-3 py-2 text-xs">{r.dueDate ?? r.documentDate ?? "-"}</td>
                    <td className="px-3 py-2 text-xs">
                      {r.daysOverdue > 0 ? (
                        <span className="text-red-600 font-medium">{r.daysOverdue}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs font-medium">{fmt(String(r.balance))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function TrialBalance() {
  const [data, setData] = useState<{
    lines: Array<{
      code: string;
      nameAr: string;
      type: string;
      debit: string | null;
      credit: string | null;
    }>;
    totalDebit: string | null;
    totalCredit: string | null;
    balanced: boolean;
  } | null>(null);
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
      const r = await fetch(`/api/accounts/trial-balance${qs ? `?${qs}` : ""}`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error("فشل تحميل ميزان المراجعة");
      setData(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل ميزان المراجعة"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load(); /* eslint-disable-next-line */
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div>
          <Label className="text-xs mb-1 block">من تاريخ</Label>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-8 text-sm w-40"
          />
        </div>
        <div>
          <Label className="text-xs mb-1 block">إلى تاريخ</Label>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-8 text-sm w-40"
          />
        </div>
        <Button onClick={load} size="sm" className="gap-1.5">
          تحديث
        </Button>
      </div>
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-3 py-3 text-muted-foreground text-xs">الكود</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs">الحساب</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs">النوع</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs">مدين</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs">دائن</th>
                </tr>
              </thead>
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
                  <td colSpan={3} className="px-3 py-3 text-xs font-bold text-left">
                    الإجمالي
                  </td>
                  <td className="px-3 py-3 text-xs font-bold">{fmt(data?.totalDebit)}</td>
                  <td className="px-3 py-3 text-xs font-bold">{fmt(data?.totalCredit)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {data && (
          <div
            className={`px-3 py-2 text-xs font-medium ${data.balanced ? "text-emerald-600 bg-emerald-50" : "text-red-600 bg-red-50"}`}
          >
            {data.balanced ? "✓ ميزان المراجعة متوازن" : "⚠ ميزان المراجعة غير متوازن"}
          </div>
        )}
      </div>
    </div>
  );
}

function IncomeStatement() {
  const [data, setData] = useState<{
    revenue: Array<{ code: string; nameAr: string; amount: string | null }>;
    expenses: Array<{ code: string; nameAr: string; amount: string | null }>;
    totalRevenue: string | null;
    totalExpense: string | null;
    netProfit: string | null;
  } | null>(null);
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
      const r = await fetch(`/api/accounts/income-statement${qs ? `?${qs}` : ""}`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error("فشل تحميل قائمة الدخل");
      setData(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل قائمة الدخل"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load(); /* eslint-disable-next-line */
  }, []);

  const profit = Number(data?.netProfit ?? 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div>
          <Label className="text-xs mb-1 block">من تاريخ</Label>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-8 text-sm w-40"
          />
        </div>
        <div>
          <Label className="text-xs mb-1 block">إلى تاريخ</Label>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-8 text-sm w-40"
          />
        </div>
        <Button onClick={load} size="sm" className="gap-1.5">
          تحديث
        </Button>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Section
          title="الإيرادات"
          rows={data?.revenue}
          total={data?.totalRevenue}
          tone="profit"
          loading={loading}
        />
        <Section
          title="المصروفات"
          rows={data?.expenses}
          total={data?.totalExpense}
          tone="loss"
          loading={loading}
        />
      </div>
      <div
        className={`bg-card border rounded-lg p-4 flex items-center justify-between ${profit >= 0 ? "border-emerald-300 bg-emerald-50/50" : "border-red-300 bg-red-50/50"}`}
      >
        <span className="text-sm font-semibold">صافي {profit >= 0 ? "الربح" : "الخسارة"}</span>
        <span className={`text-2xl font-bold ${profit >= 0 ? "text-emerald-600" : "text-red-600"}`}>
          {fmt(data?.netProfit)}
        </span>
      </div>
    </div>
  );
}

function BalanceSheet() {
  const [data, setData] = useState<{
    assets: Array<{ code: string; nameAr: string; amount: string | null }>;
    liabilities: Array<{ code: string; nameAr: string; amount: string | null }>;
    equity: Array<{ code: string; nameAr: string; amount: string | null }>;
    totalAssets: string | null;
    totalLiabilities: string | null;
    totalEquity: string | null;
    periodResult?: string | null;
    balanced?: boolean;
    difference?: string | null;
  } | null>(null);
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
  useEffect(() => {
    load(); /* eslint-disable-next-line */
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div>
          <Label className="text-xs mb-1 block">كما في تاريخ</Label>
          <Input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="h-8 text-sm w-40"
          />
        </div>
        <Button onClick={load} size="sm" className="gap-1.5">
          تحديث
        </Button>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Section
          title="الأصول"
          rows={data?.assets}
          total={data?.totalAssets}
          tone="asset"
          loading={loading}
        />
        <Section
          title="الخصوم"
          rows={data?.liabilities}
          total={data?.totalLiabilities}
          tone="loss"
          loading={loading}
        />
        <Section
          title="حقوق الملكية"
          rows={data?.equity}
          total={data?.totalEquity}
          tone="equity"
          loading={loading}
        />
      </div>
      <div className="bg-card border border-border rounded-lg p-4 flex items-center justify-between">
        <span className="text-sm font-semibold">الخصوم + حقوق الملكية</span>
        <span className="text-xl font-bold text-primary">
          {fmt(
            String(
              (Number(data?.totalLiabilities ?? 0) + Number(data?.totalEquity ?? 0)).toFixed(2),
            ),
          )}
        </span>
      </div>
      {data && data.periodResult != null && Number(data.periodResult) !== 0 && (
        <p className="text-xs text-muted-foreground">
          نتيجة أعمال الفترة ({Number(data.periodResult) >= 0 ? "ربح" : "خسارة"}) مُدرجة ضمن حقوق
          الملكية لأنها لم تُرحَّل بعد إلى الأرباح المرحّلة.
        </p>
      )}
      {data && data.balanced === false && (
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg p-3 text-xs text-red-800 dark:text-red-300">
          تحذير: الميزانية غير متوازنة — الفرق {fmt(data.difference)}. راجع القيود غير المتوازنة أو
          الأرصدة الافتتاحية.
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  rows,
  total,
  tone,
  loading,
}: {
  title: string;
  rows?: Array<{ code: string; nameAr: string; amount: string | null }>;
  total?: string | null;
  tone: "profit" | "loss" | "asset" | "equity";
  loading: boolean;
}) {
  const toneClass =
    tone === "profit"
      ? "text-emerald-600"
      : tone === "loss"
        ? "text-red-600"
        : tone === "asset"
          ? "text-blue-600"
          : "text-purple-600";
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center justify-between">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <span className={`text-xs font-bold ${toneClass}`}>{fmt(total)}</span>
      </div>
      {loading ? (
        <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
      ) : (rows?.length ?? 0) === 0 ? (
        <div className="p-6 text-center text-muted-foreground text-xs">لا توجد بنود</div>
      ) : (
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

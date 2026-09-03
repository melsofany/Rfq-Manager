import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { RefreshCw, ArrowUpRight, Wallet } from "lucide-react";

const CATEGORY_META: Record<string, { icon: string; tone: string }> = {
  "كهرباء": { icon: "⚡", tone: "bg-amber-50 text-amber-700" },
  "مياه": { icon: "💧", tone: "bg-blue-50 text-blue-700" },
  "انترنت": { icon: "🌐", tone: "bg-sky-50 text-sky-700" },
  "دومينات واستضافة وخدمات تقنية": { icon: "🖥", tone: "bg-violet-50 text-violet-700" },
  "اشتراكات ودعم فني": { icon: "📋", tone: "bg-purple-50 text-purple-700" },
  "نقل وتنقل": { icon: "🚚", tone: "bg-orange-50 text-orange-700" },
  "اتصالات": { icon: "📞", tone: "bg-teal-50 text-teal-700" },
  "نثريات": { icon: "🧾", tone: "bg-stone-50 text-stone-700" },
  "إيجارات": { icon: "🏢", tone: "bg-indigo-50 text-indigo-700" },
  "صيانة": { icon: "🔧", tone: "bg-cyan-50 text-cyan-700" },
  "مصروفات إدارية": { icon: "🗂", tone: "bg-slate-50 text-slate-700" },
  "رواتب": { icon: "👥", tone: "bg-green-50 text-green-700" },
};

interface ExpenseRow {
  id: number;
  category: string;
  description: string;
  expenseDate: string;
  amount: string;
  notes: string | null;
  employeeName: string | null;
}

interface SummaryRow {
  category: string;
  total: string;
  count: number;
}

function fmtMoney(v: string | number | null): string {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return (isFinite(n) ? n : 0).toLocaleString("en-EG", { maximumFractionDigits: 2 });
}

function useGet<T>(url: string): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(url, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json() ).error ?? "فشل التحميل");
        return r.json() as Promise<T>;
      })
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e: Error) => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [url, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

export default function ExpensesAccountsTab() {
  const { data: summary } = useGet<{ grandTotal: string; byCategory: SummaryRow[] }>("/api/expenses/summary");
  const { data: expenses, loading, error, reload } = useGet<ExpenseRow[]>("/api/expenses");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          المصاريف والتكاليف التشغيلية — كهرباء، انترنت، مياه، دومينات واستضافة، اشتراكات، نقل، نثريات، وخلافه.
 تسجل مصروفات مباشرة بقيد يومية (مدين مصروف، دائن نقدية/بنك).
        </p>
        <div className="flex items-center gap-2">
          <Link href="/expenses">
            <a className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
              صفحة المصاريف الكاملة <ArrowUpRight size={12} />
            </a>
          </Link>
          <button
            type="button"
            onClick={reload}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            <RefreshCw size={12} />
            تحديث
          </button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div className="col-span-2 rounded-lg border border-border bg-card p-4 flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">إجمالي المصاريف</p>
            <p className="text-xl font-bold text-foreground">{summary ? fmtMoney(summary.grandTotal) : "—"}</p>
          </div>
          <Wallet size={22} className="text-primary" />
        </div>
        <div className="col-span-2 rounded-lg border border-border bg-card p-4 flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">عدد الفئات</p>
            <p className="text-xl font-bold text-foreground">{summary ? summary.byCategory.length : "—"}</p>
          </div>
          <RefreshCw size={18} className="text-muted-foreground" />
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {summary.byCategory.map((c) => {
            const meta = CATEGORY_META[c.category] ?? { icon: "📎", tone: "bg-muted text-muted-foreground" };
            return (
              <div key={c.category} className="rounded-lg border border-border bg-card p-3 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${meta.tone}`}>
                    <span>{meta.icon}</span>
                    {c.category}
                  </span>
                  <span className="text-xs text-muted-foreground">{c.count}</span>
                </div>
                <p className="text-base font-semibold text-foreground">{fmtMoney(c.total)}</p>
              </div>
            );
          })}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">جارٍ التحميل...</p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : expenses && expenses.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          لا توجد مصاريف مسجلة حتى الآن؟
        </div>
      ) : expenses ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                <th className="px-3 py-2 text-right font-medium">التاريخ</th>
                <th className="px-3 py-2 text-right font-medium">الفئة</th>
                <th className="px-3 py-2 text-right font-medium">البيان</th>
                <th className="px-3 py-2 text-right font-medium">المبلغ</th>
                <th className="px-3 py-2 text-right font-medium">المُدخل</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2">{e.expenseDate?.slice(0, 10) ?? "—"}</td>
                  <td className="px-3 py-2">{e.category}</td>
                  <td className="px-3 py-2">{e.description}</td>
                  <td className="px-3 py-2 font-medium">{fmtMoney(e.amount)}</td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">{e.employeeName ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
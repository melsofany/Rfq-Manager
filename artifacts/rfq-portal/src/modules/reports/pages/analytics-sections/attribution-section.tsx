import { useState, useEffect, useCallback } from "react";
import { Trophy } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

// ────────────────── overview types ──────────────────

export interface AttributedCategoryRow {
  categoryId: number | null;
  categoryName: string | null;
  items: number;
}
export interface AttributedEmployeeRow {
  employeeId: number;
  employeeName: string;
  attributedItems: number;
  convertedItems: number;
  achievementRate: number;
  categories: AttributedCategoryRow[];
}
export interface AttributedResponse {
  employees: AttributedEmployeeRow[];
  totals: {
    frozenItems: number;
    attributedItems: number;
    convertedItems: number;
    unattributedItems: number;
    employeesCount: number;
  };
}

export function AttributionAchievementSection() {
  const [data, setData] = useState<AttributedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sp = new URLSearchParams();
      if (from) sp.set("from", from);
      if (to) sp.set("to", to);
      const res = await fetch(`/api/analytics/procurement/attributed?${sp.toString()}`, {
        credentials: "include",
      });
      if (res.ok) setData((await res.json()) as AttributedResponse);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل إنجاز الموظفين"));
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = data?.totals;
  const rows = data?.employees ?? [];
  const overallRate =
    totals && totals.attributedItems
      ? Math.round((totals.convertedItems / totals.attributedItems) * 1000) / 10
      : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-base text-foreground flex items-center gap-2">
            <Trophy size={18} className="text-teal-500" />
            إنجاز الموظفين — من أحضر السعر الفائز
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            البند يُحسب لصاحب السعر الفائز (العرض المعتمد، أو من أرسل العرض إن لم يوجد اعتماد) لحظة
            إصدار أمر شراء العميل. نسبة الإنجاز = المحوّل لأمر شراء ÷ المنسوب.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label className="block text-[11px] text-muted-foreground">من</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] text-muted-foreground">إلى</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            />
          </div>
          {(from || to) && (
            <button
              onClick={() => {
                setFrom("");
                setTo("");
              }}
              className="text-xs text-muted-foreground hover:text-foreground h-8 px-2"
            >
              مسح
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-gradient-to-br from-teal-500/10 to-emerald-600/5 border border-teal-500/20 rounded-lg p-3">
          <p className="text-[11px] text-muted-foreground">إجمالي البنود المنسوبة</p>
          <p className="text-xl font-bold text-teal-600 mt-0.5">{totals?.attributedItems ?? 0}</p>
        </div>
        <div className="bg-gradient-to-br from-emerald-500/10 to-green-600/5 border border-emerald-500/20 rounded-lg p-3">
          <p className="text-[11px] text-muted-foreground">بنود تحوّلت لأمر شراء العميل</p>
          <p className="text-xl font-bold text-emerald-600 mt-0.5">{totals?.convertedItems ?? 0}</p>
        </div>
        <div className="bg-gradient-to-br from-amber-500/10 to-orange-600/5 border border-amber-500/20 rounded-lg p-3">
          <p className="text-[11px] text-muted-foreground">نسبة الإنجاز من المطلوب</p>
          <p className="text-xl font-bold text-amber-600 mt-0.5">{overallRate}%</p>
        </div>
        <div className="bg-gradient-to-br from-slate-500/10 to-gray-600/5 border border-slate-500/20 rounded-lg p-3">
          <p className="text-[11px] text-muted-foreground">بنود بلا سعر فائز</p>
          <p className="text-xl font-bold text-slate-600 mt-0.5">
            {totals?.unattributedItems ?? 0}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="h-40 bg-muted rounded-lg animate-pulse" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          لا توجد بنود منسوبة بعد — تُحسب عند إصدار أمر شراء العميل بسعر مورد معتمد.
        </p>
      ) : (
        <div className="bg-card border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="text-right p-3 font-medium">الموظف</th>
                <th className="text-center p-3 font-medium">بنود منسوبة</th>
                <th className="text-center p-3 font-medium">تحوّلت لأمر شراء</th>
                <th className="text-center p-3 font-medium">نسبة الإنجاز</th>
                <th className="text-right p-3 font-medium">التصنيفات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.employeeId} className="hover:bg-muted/30">
                  <td className="p-3 font-medium text-foreground">{r.employeeName}</td>
                  <td className="text-center p-3 text-teal-600 font-medium">{r.attributedItems}</td>
                  <td className="text-center p-3 text-emerald-600">{r.convertedItems}</td>
                  <td className="text-center p-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        r.achievementRate >= 50
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                          : r.achievementRate >= 20
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                            : "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400"
                      }`}
                    >
                      {r.achievementRate}%
                    </span>
                  </td>
                  <td className="p-3 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      {r.categories.map((c) => (
                        <span
                          key={`${r.employeeId}:${c.categoryId ?? "none"}`}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-[11px] text-muted-foreground"
                        >
                          {c.categoryName ?? "غير مصنّف"}
                          <b className="font-mono text-foreground">{c.items}</b>
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

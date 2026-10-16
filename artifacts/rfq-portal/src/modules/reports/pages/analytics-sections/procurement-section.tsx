import { useState, useEffect, useCallback } from "react";
import { ClipboardList, RefreshCw } from "lucide-react";

// ────────────────── overview types ──────────────────

export interface ProcurementEmployee {
  employeeId: number;
  employeeName: string;
  role: string;
  rfqCount: number;
  itemCount: number;
  offerCount: number;
  avgOffersPerRfq: number;
  avgOfferItemsPerItem: number;
  convertedRfqs: number;
  convertedItems: number;
  conversionRate: number;
  failedRfqs: number;
  itemsWithOffers: number;
}
export interface ProcurementResponse {
  employees: ProcurementEmployee[];
  totals: {
    rfqCount: number;
    itemCount: number;
    offerCount: number;
    convertedRfqs: number;
    convertedItems: number;
    failedRfqs: number;
  };
}

export function ProcurementPerformanceSection() {
  const [data, setData] = useState<ProcurementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/analytics/procurement", { credentials: "include" });
      if (!res.ok) throw new Error("فشل تحميل البيانات");
      const json = (await res.json()) as ProcurementResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطأ غير متوقع");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = data?.totals;
  const employees = data?.employees ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-base text-foreground flex items-center gap-2">
            <ClipboardList size={18} className="text-indigo-500" />
            أداء موظفي المشتريات
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            إنتاجية كل موظف عبر دورة طلبات التسعير: الطلبات، البنود، العروض، التحويل لأمر شراء،
            والطلبات الفاشلة
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <RefreshCw size={12} /> تحديث
        </button>
      </div>

      {/* Company-wide totals */}
      {totals && (
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <div className="bg-gradient-to-br from-indigo-500/10 to-blue-600/5 border border-indigo-500/20 rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground">إجمالي طلبات التسعير</p>
            <p className="text-xl font-bold text-indigo-600 mt-0.5">{totals.rfqCount}</p>
          </div>
          <div className="bg-gradient-to-br from-sky-500/10 to-cyan-600/5 border border-sky-500/20 rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground">إجمالي البنود</p>
            <p className="text-xl font-bold text-sky-600 mt-0.5">{totals.itemCount}</p>
          </div>
          <div className="bg-gradient-to-br from-violet-500/10 to-purple-600/5 border border-violet-500/20 rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground">إجمالي العروض</p>
            <p className="text-xl font-bold text-violet-600 mt-0.5">{totals.offerCount}</p>
          </div>
          <div className="bg-gradient-to-br from-emerald-500/10 to-green-600/5 border border-emerald-500/20 rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground">تحوّل لأمر شراء</p>
            <p className="text-xl font-bold text-emerald-600 mt-0.5">{totals.convertedRfqs}</p>
            <p className="text-[10px] text-muted-foreground">{totals.convertedItems} بند</p>
          </div>
          <div className="bg-gradient-to-br from-rose-500/10 to-red-600/5 border border-rose-500/20 rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground">طلبات فاشلة</p>
            <p className="text-xl font-bold text-rose-600 mt-0.5">{totals.failedRfqs}</p>
          </div>
          <div className="bg-gradient-to-br from-amber-500/10 to-orange-600/5 border border-amber-500/20 rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground">نسبة التحويل الكلية</p>
            <p className="text-xl font-bold text-amber-600 mt-0.5">
              {totals.rfqCount
                ? Math.round((totals.convertedRfqs / totals.rfqCount) * 1000) / 10
                : 0}
              %
            </p>
          </div>
        </div>
      )}

      {/* Per-employee table */}
      {loading ? (
        <div className="h-48 bg-muted rounded-lg animate-pulse" />
      ) : error ? (
        <p className="text-sm text-red-500 text-center py-8">{error}</p>
      ) : employees.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">لا توجد بيانات مشتريات بعد</p>
      ) : (
        <div className="bg-card border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="text-right p-3 font-medium">الموظف</th>
                <th className="text-center p-3 font-medium">طلبات التسعير</th>
                <th className="text-center p-3 font-medium">البنود</th>
                <th className="text-center p-3 font-medium">العروض المستلمة</th>
                <th className="text-center p-3 font-medium">متوسط عروض/طلب</th>
                <th className="text-center p-3 font-medium">متوسط عروض/بند</th>
                <th className="text-center p-3 font-medium">بنود حصلت على عروض</th>
                <th className="text-center p-3 font-medium">تحوّل لأمر شراء (طلب)</th>
                <th className="text-center p-3 font-medium">بنود تحوّلت</th>
                <th className="text-center p-3 font-medium">نسبة التحويل</th>
                <th className="text-center p-3 font-medium">طلبات فاشلة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {employees.map((emp) => (
                <tr key={emp.employeeId} className="hover:bg-muted/30">
                  <td className="p-3 font-medium text-foreground">
                    {emp.employeeName}
                    <span className="block text-[10px] text-muted-foreground font-normal">
                      {emp.role}
                    </span>
                  </td>
                  <td className="text-center p-3 text-foreground font-medium">{emp.rfqCount}</td>
                  <td className="text-center p-3 text-muted-foreground">{emp.itemCount}</td>
                  <td className="text-center p-3 text-violet-600 font-medium">{emp.offerCount}</td>
                  <td className="text-center p-3 text-sky-600">{emp.avgOffersPerRfq}</td>
                  <td className="text-center p-3 text-sky-600">{emp.avgOfferItemsPerItem}</td>
                  <td className="text-center p-3 text-muted-foreground">
                    {emp.itemsWithOffers}
                    {emp.itemCount > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        {" "}
                        ({Math.round((emp.itemsWithOffers / emp.itemCount) * 100)}%)
                      </span>
                    )}
                  </td>
                  <td className="text-center p-3 text-emerald-600 font-medium">
                    {emp.convertedRfqs}
                  </td>
                  <td className="text-center p-3 text-emerald-600">{emp.convertedItems}</td>
                  <td className="text-center p-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        emp.conversionRate >= 50
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                          : emp.conversionRate >= 20
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                            : "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400"
                      }`}
                    >
                      {emp.conversionRate}%
                    </span>
                  </td>
                  <td className="text-center p-3">
                    {emp.failedRfqs > 0 ? (
                      <span className="text-rose-600 font-medium">{emp.failedRfqs}</span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
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

// ────────────────── data-entry operator performance section ──────────────────

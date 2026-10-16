import { useState, useEffect, useCallback } from "react";
import { RefreshCw, UserCircle } from "lucide-react";

// ────────────────── overview types ──────────────────

export interface DataEntryEmployee {
  employeeId: number;
  employeeName: string;
  role: string;
  counts: {
    rfqs: number;
    rfqItems: number;
    customerRfqs: number;
    customerRfqItems: number;
    pos: number;
    poItems: number;
    customerPos: number;
    customerPoItems: number;
    completedSessions: number;
    abandonedSessions: number;
  };
  durations: {
    totalSeconds: number;
    avgSeconds: number;
    totalFormatted: string;
    avgFormatted: string;
    weeklySeconds: number;
    monthlySeconds: number;
    weeklyFormatted: string;
    monthlyFormatted: string;
    weeklySessions: number;
    monthlySessions: number;
  };
}
export interface DataEntryResponse {
  employees: DataEntryEmployee[];
  totals: {
    totalActiveSeconds: number;
    weeklySeconds: number;
    monthlySeconds: number;
    totalFormatted: string;
    weeklyFormatted: string;
    monthlyFormatted: string;
    completedSessions: number;
    abandonedSessions: number;
  };
}

export function DataEntryPerformanceSection() {
  const [data, setData] = useState<DataEntryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/analytics/data-entry", { credentials: "include" });
      if (!res.ok) throw new Error("فشل تحميل البيانات");
      const json = (await res.json()) as DataEntryResponse;
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
            <UserCircle size={18} className="text-sky-500" />
            أداء مُدخِلي البيانات
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            الوقت الفعلي المستغرق في إدخال الطلبات (من فتح الفورم حتى الحفظ)
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <RefreshCw size={12} /> تحديث
        </button>
      </div>

      {/* Company-wide time totals */}
      {totals && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-gradient-to-br from-sky-500/10 to-blue-600/5 border border-sky-500/20 rounded-lg p-4">
            <p className="text-xs text-muted-foreground">إجمالي الوقت أمام التطبيق</p>
            <p className="text-xl font-bold text-sky-600 mt-1">{totals.totalFormatted}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {totals.completedSessions} جلسة مكتملة
            </p>
          </div>
          <div className="bg-gradient-to-br from-emerald-500/10 to-green-600/5 border border-emerald-500/20 rounded-lg p-4">
            <p className="text-xs text-muted-foreground">هذا الأسبوع</p>
            <p className="text-xl font-bold text-emerald-600 mt-1">{totals.weeklyFormatted}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">آخر 7 أيام</p>
          </div>
          <div className="bg-gradient-to-br from-violet-500/10 to-purple-600/5 border border-violet-500/20 rounded-lg p-4">
            <p className="text-xs text-muted-foreground">هذا الشهر</p>
            <p className="text-xl font-bold text-violet-600 mt-1">{totals.monthlyFormatted}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">آخر 30 يوم</p>
          </div>
          <div className="bg-gradient-to-br from-amber-500/10 to-orange-600/5 border border-amber-500/20 rounded-lg p-4">
            <p className="text-xs text-muted-foreground">جلسات بدون حفظ</p>
            <p className="text-xl font-bold text-amber-600 mt-1">{totals.abandonedSessions}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">فُتحت ولم تُحفظ</p>
          </div>
        </div>
      )}

      {/* Per-employee table */}
      {loading ? (
        <div className="h-48 bg-muted rounded-lg animate-pulse" />
      ) : error ? (
        <p className="text-sm text-red-500 text-center py-8">{error}</p>
      ) : employees.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          لا توجد بيانات إدخال بعد — سيظهر هنا أداء الموظفين فور بدء إدخال الطلبات
        </p>
      ) : (
        <div className="bg-card border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="text-right p-3 font-medium">الموظف</th>
                <th className="text-center p-3 font-medium">طلبات تسعير الموردين</th>
                <th className="text-center p-3 font-medium">بنود</th>
                <th className="text-center p-3 font-medium">طلبات تسعير العملاء</th>
                <th className="text-center p-3 font-medium">بنود</th>
                <th className="text-center p-3 font-medium">أوامر شراء (موردين)</th>
                <th className="text-center p-3 font-medium">بنود</th>
                <th className="text-center p-3 font-medium">أوامر شراء (عملاء)</th>
                <th className="text-center p-3 font-medium">بنود</th>
                <th className="text-center p-3 font-medium">متوسط وقت الإدخال</th>
                <th className="text-center p-3 font-medium">إجمالي وقت الإدخال</th>
                <th className="text-center p-3 font-medium">أسبوعي</th>
                <th className="text-center p-3 font-medium">شهري</th>
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
                  <td className="text-center p-3 text-foreground">{emp.counts.rfqs}</td>
                  <td className="text-center p-3 text-muted-foreground">{emp.counts.rfqItems}</td>
                  <td className="text-center p-3 text-foreground">{emp.counts.customerRfqs}</td>
                  <td className="text-center p-3 text-muted-foreground">
                    {emp.counts.customerRfqItems}
                  </td>
                  <td className="text-center p-3 text-foreground">{emp.counts.pos}</td>
                  <td className="text-center p-3 text-muted-foreground">{emp.counts.poItems}</td>
                  <td className="text-center p-3 text-foreground">{emp.counts.customerPos}</td>
                  <td className="text-center p-3 text-muted-foreground">
                    {emp.counts.customerPoItems}
                  </td>
                  <td className="text-center p-3 text-sky-600 font-medium">
                    {emp.durations.avgFormatted}
                  </td>
                  <td className="text-center p-3 text-foreground font-medium">
                    {emp.durations.totalFormatted}
                  </td>
                  <td className="text-center p-3 text-emerald-600">
                    {emp.durations.weeklyFormatted}
                  </td>
                  <td className="text-center p-3 text-violet-600">
                    {emp.durations.monthlyFormatted}
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

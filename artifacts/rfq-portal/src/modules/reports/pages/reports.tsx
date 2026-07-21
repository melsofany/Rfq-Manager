// ─── Reports Tab Component ───────────────────────────────────────
// Full "تقارير" tab for the analytics page

import { useGetReports, getGetReportsQueryKey } from "@workspace/api-client-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  LineChart,
  Line,
  CartesianGrid,
  Legend,
  PieChart,
  Pie,
} from "recharts";
import { useState, useMemo } from "react";
import {
  Calendar,
  Users,
  Package,
  ShoppingCart,
  FileText,
  TrendingUp,
  Award,
  BarChart2,
  Filter,
  Download,
  RefreshCw,
} from "lucide-react";

const DEEP_COLORS = [
  "#1e3a5f",
  "#0ea5e9",
  "#f59e0b",
  "#10b981",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#14b8a6",
  "#64748b",
  "#ef4444",
];

const STATUS_AR: Record<string, string> = {
  DRAFT: "مسودة",
  SENT: "مرسل",
  QUOTED: "مسعّر",
  FAILED: "فشل",
  SUCCESS: "ناجح",
  draft: "مسودة",
  sent: "مرسل",
  partial: "جزئي",
  completed: "مكتمل",
  closed: "مغلق",
};
const STATUS_COLORS: Record<string, string> = {
  DRAFT: "#6b7280",
  SENT: "#3b82f6",
  QUOTED: "#f97316",
  FAILED: "#ef4444",
  SUCCESS: "#22c55e",
  draft: "#6b7280",
  sent: "#3b82f6",
  partial: "#f97316",
  completed: "#22c55e",
  closed: "#64748b",
};

// Quick summary KPI
function SummaryKpi({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color: string;
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex items-center gap-3">
      <div className={`p-2.5 rounded-lg ${color}`}>
        <Icon size={18} />
      </div>
      <div>
        <p className="text-2xl font-bold text-foreground leading-tight">{value}</p>
        <p className="text-muted-foreground text-xs mt-0.5">{label}</p>
      </div>
    </div>
  );
}

const REPORT_TYPES = [
  { id: "employees", label: "أداء الموظفين", icon: Users },
  { id: "items", label: "أكثر البنود طلباً", icon: Package },
  { id: "lineitems", label: "إحصائيات البنود", icon: FileText },
  { id: "trend", label: "الاتجاه الشهري", icon: TrendingUp },
  { id: "funnel", label: "مسار الحالات", icon: BarChart2 },
];

export default function ReportsTab() {
  const today = new Date();
  const sixMonthsAgo = new Date(today);
  sixMonthsAgo.setMonth(today.getMonth() - 6);

  const [from, setFrom] = useState(sixMonthsAgo.toISOString().substring(0, 10));
  const [to, setTo] = useState(today.toISOString().substring(0, 10));
  const [activeReport, setActiveReport] = useState("employees");
  const [appliedFrom, setAppliedFrom] = useState(from);
  const [appliedTo, setAppliedTo] = useState(to);

  const { data, isLoading, refetch } = useGetReports(
    { from: appliedFrom, to: appliedTo },
    { query: { queryKey: getGetReportsQueryKey({ from: appliedFrom, to: appliedTo }) } },
  );

  function applyFilter() {
    setAppliedFrom(from);
    setAppliedTo(to);
  }

  const summary = data?.summary;
  const employeeStats = data?.employeeStats ?? [];
  const topItems = data?.topItems ?? [];
  const lineItemStats = data?.lineItemStats ?? [];
  const monthlyTrend = data?.monthlyTrend ?? [];
  const statusFunnel = data?.statusFunnel ?? [];

  // Month display helper
  function fmtMonth(m: string | undefined) {
    if (!m) return "";
    const [y, mo] = m.split("-");
    const months = [
      "يناير",
      "فبراير",
      "مارس",
      "أبريل",
      "مايو",
      "يونيو",
      "يوليو",
      "أغسطس",
      "سبتمبر",
      "أكتوبر",
      "نوفمبر",
      "ديسمبر",
    ];
    return `${months[parseInt(mo) - 1]} ${y}`;
  }

  // Print helper
  function printReport() {
    const title = REPORT_TYPES.find((r) => r.id === activeReport)?.label ?? "تقرير";
    const win = window.open("", "_blank", "width=1100,height=800,scrollbars=yes");
    if (!win) return;
    win.document
      .write(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>${title}</title>
      <style>body{font-family:Arial,sans-serif;padding:24px;direction:rtl}
      table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:right}
      th{background:#1e3a5f;color:white}tr:nth-child(even){background:#f9f9f9}
      h1{color:#1e3a5f}h2{color:#0ea5e9}.summary{display:flex;gap:16px;margin-bottom:24px}
      .kpi{border:1px solid #ddd;border-radius:8px;padding:12px;min-width:120px;text-align:center}
      .kpi .val{font-size:24px;font-weight:bold;color:#1e3a5f}.kpi .lbl{font-size:12px;color:#666}</style>
    </head><body>
      <h1>${title}</h1>
      <p>الفترة: ${appliedFrom} إلى ${appliedTo}</p>
      <div class="summary">
        <div class="kpi"><div class="val">${summary?.totalRfqs ?? 0}</div><div class="lbl">إجمالي RFQs</div></div>
        <div class="kpi"><div class="val">${summary?.totalPos ?? 0}</div><div class="lbl">أوامر الشراء</div></div>
        <div class="kpi"><div class="val">${summary?.totalItems ?? 0}</div><div class="lbl">إجمالي البنود</div></div>
        <div class="kpi"><div class="val">${summary?.conversionRate ?? 0}%</div><div class="lbl">معدل التحويل</div></div>
      </div>
      ${
        activeReport === "employees"
          ? `<h2>أداء الموظفين</h2>
        <table><thead><tr><th>#</th><th>الموظف</th><th>الدور</th><th>RFQs</th><th>عروض الأسعار</th><th>أوامر الشراء</th><th>معدل التحويل</th></tr></thead>
        <tbody>${employeeStats.map((e, i) => `<tr><td>${i + 1}</td><td>${e.employeeName}</td><td>${e.role}</td><td>${e.totalRfqs}</td><td>${e.totalOffers}</td><td>${e.totalPos}</td><td>${e.conversionRate}%</td></tr>`).join("")}</tbody></table>`
          : activeReport === "items"
            ? `<h2>أكثر البنود طلباً</h2>
        <table><thead><tr><th>#</th><th>الصنف</th><th>Part No</th><th>عدد المرات</th><th>إجمالي الكمية</th></tr></thead>
        <tbody>${topItems.map((t, i) => `<tr><td>${i + 1}</td><td>${t.description}</td><td>${t.partNo ?? "—"}</td><td>${t.count}</td><td>${t.totalQty?.toFixed(2) ?? 0}</td></tr>`).join("")}</tbody></table>`
            : activeReport === "lineitems"
              ? `<h2>إحصائيات البنود</h2>
        <table><thead><tr><th>#</th><th>رقم البند</th><th>إجمالي التكرار</th><th>عدد RFQs المختلفة</th></tr></thead>
        <tbody>${lineItemStats.map((l, i) => `<tr><td>${i + 1}</td><td>${l.lineItem}</td><td>${l.count}</td><td>${l.distinctRfqs}</td></tr>`).join("")}</tbody></table>`
              : ""
      }
    </body></html>`);
    win.document.close();
    win.document.fonts.ready.then(() => setTimeout(() => win.print(), 600));
  }

  return (
    <div className="space-y-5">
      {/* ── Date filter bar ──────────────────────────────────── */}
      <div className="bg-card border border-border rounded-lg p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-muted-foreground font-medium block mb-1">من تاريخ</label>
            <div className="relative">
              <Calendar
                size={14}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
              />
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="pr-8 pl-3 py-1.5 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-medium block mb-1">
              إلى تاريخ
            </label>
            <div className="relative">
              <Calendar
                size={14}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
              />
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="pr-8 pl-3 py-1.5 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {/* Quick presets */}
          <div className="flex gap-1.5 flex-wrap">
            {[
              {
                label: "هذا الشهر",
                fn: () => {
                  const n = new Date();
                  setFrom(`${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-01`);
                  setTo(n.toISOString().substring(0, 10));
                },
              },
              {
                label: "آخر 3 أشهر",
                fn: () => {
                  const n = new Date();
                  const f = new Date(n);
                  f.setMonth(n.getMonth() - 3);
                  setFrom(f.toISOString().substring(0, 10));
                  setTo(n.toISOString().substring(0, 10));
                },
              },
              {
                label: "هذا العام",
                fn: () => {
                  const y = new Date().getFullYear();
                  setFrom(`${y}-01-01`);
                  setTo(`${y}-12-31`);
                },
              },
              {
                label: "كل الفترات",
                fn: () => {
                  setFrom("2020-01-01");
                  setTo(new Date().toISOString().substring(0, 10));
                },
              },
            ].map((p) => (
              <button
                key={p.label}
                onClick={p.fn}
                className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted text-foreground transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>

          <button
            onClick={applyFilter}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition-opacity"
          >
            <Filter size={14} />
            تطبيق الفلتر
          </button>
          <button
            onClick={printReport}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-md text-sm text-muted-foreground hover:bg-muted transition-colors"
          >
            <Download size={14} />
            طباعة
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <RefreshCw size={20} className="animate-spin ml-2" />
          جاري تحميل التقارير...
        </div>
      ) : (
        <>
          {/* ── Summary KPIs ──────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SummaryKpi
              label="إجمالي RFQs"
              value={summary?.totalRfqs ?? 0}
              icon={FileText}
              color="bg-blue-100 text-blue-700"
            />
            <SummaryKpi
              label="أوامر الشراء"
              value={summary?.totalPos ?? 0}
              icon={ShoppingCart}
              color="bg-green-100 text-green-700"
            />
            <SummaryKpi
              label="إجمالي البنود"
              value={summary?.totalItems ?? 0}
              icon={Package}
              color="bg-amber-100 text-amber-700"
            />
            <SummaryKpi
              label="معدل التحويل"
              value={`${summary?.conversionRate ?? 0}%`}
              icon={TrendingUp}
              color="bg-purple-100 text-purple-700"
            />
          </div>

          {/* ── Report type tabs ──────────────────────────────── */}
          <div className="flex gap-1 flex-wrap border-b border-border">
            {REPORT_TYPES.map((rt) => (
              <button
                key={rt.id}
                onClick={() => setActiveReport(rt.id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                  activeReport === rt.id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <rt.icon size={14} />
                {rt.label}
              </button>
            ))}
          </div>

          {/* ── Employee Performance ──────────────────────────── */}
          {activeReport === "employees" && (
            <div className="space-y-5">
              {employeeStats.length === 0 ? (
                <p className="text-center text-muted-foreground py-10 text-sm">
                  لا توجد بيانات للفترة المحددة
                </p>
              ) : (
                <>
                  {/* Bar chart */}
                  <div className="bg-card border border-border rounded-lg p-5">
                    <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                      <span className="w-1.5 h-4 bg-[#1e3a5f] rounded-full" />
                      مقارنة أداء الموظفين
                    </h3>
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={employeeStats} margin={{ right: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis
                          dataKey="employeeName"
                          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                        />
                        <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                        <Tooltip
                          contentStyle={{
                            background: "hsl(var(--card))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                        />
                        <Legend />
                        <Bar dataKey="totalRfqs" name="RFQs" fill="#1e3a5f" radius={[3, 3, 0, 0]} />
                        <Bar
                          dataKey="totalOffers"
                          name="عروض الأسعار"
                          fill="#0ea5e9"
                          radius={[3, 3, 0, 0]}
                        />
                        <Bar
                          dataKey="totalPos"
                          name="أوامر الشراء"
                          fill="#10b981"
                          radius={[3, 3, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Table */}
                  <div className="bg-card border border-border rounded-lg p-5 overflow-x-auto">
                    <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                      <span className="w-1.5 h-4 bg-[#0ea5e9] rounded-full" />
                      تفاصيل أداء الموظفين
                    </h3>
                    <table className="w-full text-xs min-w-[600px]">
                      <thead>
                        <tr className="border-b border-border">
                          {[
                            "#",
                            "الموظف",
                            "الدور",
                            "RFQs أنشأ",
                            "عروض أسعار",
                            "أوامر شراء",
                            "RFQs ناجحة",
                            "معدل التحويل",
                          ].map((h) => (
                            <th
                              key={h}
                              className="pb-2.5 text-right text-muted-foreground font-medium pr-4 whitespace-nowrap"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {employeeStats
                          .sort((a, b) => (b.totalRfqs ?? 0) - (a.totalRfqs ?? 0))
                          .map((e, i) => (
                            <tr
                              key={e.employeeId}
                              className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                            >
                              <td className="py-2.5 text-muted-foreground pr-4">{i + 1}</td>
                              <td className="py-2.5 font-semibold pr-4 whitespace-nowrap">
                                {e.employeeName}
                              </td>
                              <td className="py-2.5 pr-4">
                                <span className="px-2 py-0.5 rounded-full text-xs bg-primary/10 text-primary">
                                  {e.role === "admin"
                                    ? "مدير"
                                    : e.role === "manager"
                                      ? "مشرف"
                                      : "مشتريات"}
                                </span>
                              </td>
                              <td className="py-2.5 text-center pr-4 font-medium">{e.totalRfqs}</td>
                              <td className="py-2.5 text-center pr-4">{e.totalOffers}</td>
                              <td className="py-2.5 text-center pr-4 font-medium text-green-600">
                                {e.totalPos}
                              </td>
                              <td className="py-2.5 text-center pr-4">{e.successRfqs}</td>
                              <td className="py-2.5 pr-4">
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 bg-muted rounded-full h-1.5 min-w-[60px]">
                                    <div
                                      className="h-1.5 rounded-full bg-primary"
                                      style={{ width: `${Math.min(e.conversionRate ?? 0, 100)}%` }}
                                    />
                                  </div>
                                  <span
                                    className={`font-semibold text-xs ${(e.conversionRate ?? 0) >= 50 ? "text-green-600" : (e.conversionRate ?? 0) >= 25 ? "text-amber-600" : "text-muted-foreground"}`}
                                  >
                                    {e.conversionRate ?? 0}%
                                  </span>
                                </div>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Top Items ────────────────────────────────────── */}
          {activeReport === "items" && (
            <div className="space-y-5">
              {topItems.length === 0 ? (
                <p className="text-center text-muted-foreground py-10 text-sm">
                  لا توجد بيانات للفترة المحددة
                </p>
              ) : (
                <>
                  {/* Horizontal bar chart */}
                  <div className="bg-card border border-border rounded-lg p-5">
                    <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                      <span className="w-1.5 h-4 bg-[#f59e0b] rounded-full" />
                      أكثر 10 بنود طلباً (حسب أوامر الشراء)
                    </h3>
                    <ResponsiveContainer
                      width="100%"
                      height={Math.max(300, topItems.slice(0, 10).length * 42)}
                    >
                      <BarChart
                        data={topItems.slice(0, 10)}
                        layout="vertical"
                        margin={{ left: 8, right: 32 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis
                          type="number"
                          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                        />
                        <YAxis
                          type="category"
                          dataKey="description"
                          width={160}
                          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                          tickFormatter={(v: string) =>
                            v.length > 22 ? v.substring(0, 22) + "…" : v
                          }
                        />
                        <Tooltip
                          contentStyle={{
                            background: "hsl(var(--card))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                          formatter={(v: number) => [`${v} مرة`, "عدد الطلبات"]}
                        />
                        <Bar dataKey="count" name="عدد الطلبات" radius={[0, 4, 4, 0]}>
                          {topItems.slice(0, 10).map((_, idx) => (
                            <Cell key={idx} fill={DEEP_COLORS[idx % DEEP_COLORS.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Table */}
                  <div className="bg-card border border-border rounded-lg p-5 overflow-x-auto">
                    <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                      <span className="w-1.5 h-4 bg-[#f59e0b] rounded-full" />
                      قائمة أكثر البنود طلباً
                    </h3>
                    <table className="w-full text-xs min-w-[500px]">
                      <thead>
                        <tr className="border-b border-border">
                          {[
                            "#",
                            "وصف الصنف",
                            "Part No",
                            "عدد مرات الطلب",
                            "إجمالي الكمية المطلوبة",
                          ].map((h) => (
                            <th
                              key={h}
                              className="pb-2.5 text-right text-muted-foreground font-medium pr-4"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {topItems.map((item, i) => (
                          <tr
                            key={i}
                            className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                          >
                            <td className="py-2.5 pr-4 text-muted-foreground">{i + 1}</td>
                            <td className="py-2.5 pr-4 font-medium max-w-xs">{item.description}</td>
                            <td className="py-2.5 pr-4 text-muted-foreground font-mono text-xs">
                              {item.partNo ?? "—"}
                            </td>
                            <td className="py-2.5 pr-4 text-center">
                              <span className="px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold">
                                {item.count}
                              </span>
                            </td>
                            <td className="py-2.5 pr-4 text-center font-medium">
                              {item.totalQty?.toFixed(2) ?? "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Line Item Stats ───────────────────────────────── */}
          {activeReport === "lineitems" && (
            <div className="space-y-5">
              {lineItemStats.length === 0 ? (
                <p className="text-center text-muted-foreground py-10 text-sm">
                  لا توجد بيانات للفترة المحددة
                </p>
              ) : (
                <>
                  <div className="bg-card border border-border rounded-lg p-5">
                    <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                      <span className="w-1.5 h-4 bg-[#8b5cf6] rounded-full" />
                      توزيع البنود حسب رقم السطر (Line Item)
                    </h3>
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={lineItemStats.slice(0, 15)} margin={{ right: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis
                          dataKey="lineItem"
                          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                        />
                        <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                        <Tooltip
                          contentStyle={{
                            background: "hsl(var(--card))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                        />
                        <Legend />
                        <Bar dataKey="count" name="عدد البنود" fill="#8b5cf6" radius={[3, 3, 0, 0]}>
                          {lineItemStats.slice(0, 15).map((_, idx) => (
                            <Cell key={idx} fill={DEEP_COLORS[idx % DEEP_COLORS.length]} />
                          ))}
                        </Bar>
                        <Bar
                          dataKey="distinctRfqs"
                          name="RFQs مختلفة"
                          fill="#0ea5e9"
                          radius={[3, 3, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="bg-card border border-border rounded-lg p-5 overflow-x-auto">
                    <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                      <span className="w-1.5 h-4 bg-[#8b5cf6] rounded-full" />
                      إحصائيات تفصيلية للبنود
                    </h3>
                    <table className="w-full text-xs min-w-[400px]">
                      <thead>
                        <tr className="border-b border-border">
                          {[
                            "#",
                            "رقم البند (Line Item)",
                            "إجمالي تكرار البند",
                            "عدد RFQs المختلفة",
                          ].map((h) => (
                            <th
                              key={h}
                              className="pb-2.5 text-right text-muted-foreground font-medium pr-4"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {lineItemStats.map((li, i) => (
                          <tr
                            key={i}
                            className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                          >
                            <td className="py-2.5 pr-4 text-muted-foreground">{i + 1}</td>
                            <td className="py-2.5 pr-4 font-mono font-medium text-primary">
                              {li.lineItem}
                            </td>
                            <td className="py-2.5 pr-4 text-center">
                              <span className="px-2.5 py-0.5 rounded-full bg-purple-100 text-purple-800 font-semibold">
                                {li.count}
                              </span>
                            </td>
                            <td className="py-2.5 pr-4 text-center font-medium">
                              {li.distinctRfqs}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Monthly Trend ─────────────────────────────────── */}
          {activeReport === "trend" && (
            <div className="bg-card border border-border rounded-lg p-5">
              <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                <span className="w-1.5 h-4 bg-[#10b981] rounded-full" />
                الاتجاه الشهري — RFQs وأوامر الشراء
              </h3>
              {monthlyTrend.length === 0 ? (
                <p className="text-center text-muted-foreground py-10 text-sm">
                  لا توجد بيانات للفترة المحددة
                </p>
              ) : (
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart
                    data={monthlyTrend.map((m) => ({ ...m, month: fmtMonth(m.month ?? "") }))}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    />
                    <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="rfqs"
                      name="RFQs"
                      stroke="#1e3a5f"
                      strokeWidth={2.5}
                      dot={{ r: 4, fill: "#1e3a5f" }}
                      activeDot={{ r: 6 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="pos"
                      name="أوامر الشراء"
                      stroke="#10b981"
                      strokeWidth={2.5}
                      dot={{ r: 4, fill: "#10b981" }}
                      activeDot={{ r: 6 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          )}

          {/* ── Status Funnel ─────────────────────────────────── */}
          {activeReport === "funnel" && (
            <div className="grid md:grid-cols-2 gap-5">
              {/* Pie chart */}
              <div className="bg-card border border-border rounded-lg p-5">
                <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                  <span className="w-1.5 h-4 bg-[#f97316] rounded-full" />
                  توزيع RFQs حسب الحالة
                </h3>
                {statusFunnel.length === 0 ? (
                  <p className="text-center text-muted-foreground py-10 text-sm">لا توجد بيانات</p>
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie
                        data={statusFunnel}
                        dataKey="count"
                        nameKey="status"
                        cx="50%"
                        cy="50%"
                        outerRadius={100}
                        label={({ status, percent }) =>
                          `${STATUS_AR[status] ?? status} (${(percent * 100).toFixed(0)}%)`
                        }
                        labelLine={false}
                      >
                        {statusFunnel.map((entry, idx) => (
                          <Cell
                            key={idx}
                            fill={
                              STATUS_COLORS[entry.status ?? ""] ??
                              DEEP_COLORS[idx % DEEP_COLORS.length]
                            }
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(v, n) => [v, STATUS_AR[n as string] ?? n]}
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                      />
                      <Legend formatter={(v) => STATUS_AR[v] ?? v} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* Funnel table */}
              <div className="bg-card border border-border rounded-lg p-5">
                <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                  <span className="w-1.5 h-4 bg-[#f97316] rounded-full" />
                  تفاصيل مسار الحالات
                </h3>
                {statusFunnel.length === 0 ? (
                  <p className="text-center text-muted-foreground py-10 text-sm">لا توجد بيانات</p>
                ) : (
                  <div className="space-y-3">
                    {(() => {
                      const total = statusFunnel.reduce((a, b) => a + (b.count ?? 0), 0);
                      return statusFunnel
                        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
                        .map((sf) => (
                          <div key={sf.status} className="space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span
                                className="font-medium"
                                style={{ color: STATUS_COLORS[sf.status ?? ""] }}
                              >
                                {STATUS_AR[sf.status ?? ""] ?? sf.status}
                              </span>
                              <span className="font-bold text-foreground">
                                {sf.count ?? 0} (
                                {total > 0 ? Math.round(((sf.count ?? 0) / total) * 100) : 0}%)
                              </span>
                            </div>
                            <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all duration-500"
                                style={{
                                  width: `${total > 0 ? ((sf.count ?? 0) / total) * 100 : 0}%`,
                                  background: STATUS_COLORS[sf.status ?? ""] ?? "#1e3a5f",
                                }}
                              />
                            </div>
                          </div>
                        ));
                    })()}

                    {/* Conversion insights */}
                    <div className="mt-4 pt-4 border-t border-border space-y-2">
                      <p className="text-xs font-semibold text-foreground">رؤى التحويل</p>
                      {statusFunnel.find((s) => s.status === "SUCCESS") && (
                        <p className="text-xs text-muted-foreground">
                          نسبة النجاح:{" "}
                          <span className="font-bold text-green-600">
                            {Math.round(
                              ((statusFunnel.find((s) => s.status === "SUCCESS")!.count ?? 0) /
                                statusFunnel.reduce((a, b) => a + (b.count ?? 0), 0)) *
                                100,
                            )}
                            %
                          </span>
                        </p>
                      )}
                      {statusFunnel.find((s) => s.status === "FAILED") && (
                        <p className="text-xs text-muted-foreground">
                          نسبة الفشل:{" "}
                          <span className="font-bold text-red-500">
                            {Math.round(
                              ((statusFunnel.find((s) => s.status === "FAILED")!.count ?? 0) /
                                statusFunnel.reduce((a, b) => a + (b.count ?? 0), 0)) *
                                100,
                            )}
                            %
                          </span>
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        معدل التحويل إلى PO:{" "}
                        <span className="font-bold text-primary">
                          {summary?.conversionRate ?? 0}%
                        </span>
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

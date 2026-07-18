import {
  useGetDashboardStats,
  getGetDashboardStatsQueryKey,
  useGetEmployeePerformance,
  getGetEmployeePerformanceQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
} from "recharts";
import { useState } from "react";
import {
  TrendingUp,
  Package,
  ShoppingCart,
  Users,
  FileText,
  CheckCircle,
  AlertCircle,
  Clock,
  Printer,
  BarChart2,
  ClipboardList,
} from "lucide-react";

// ────────────────── helpers ──────────────────
function RateRing({ value, label, color }: { value: number; label: string; color: string }) {
  const r = 42;
  const circ = 2 * Math.PI * r;
  const offset = circ - (value / 100) * circ;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={104} height={104} viewBox="0 0 104 104">
        <circle cx={52} cy={52} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={10} />
        <circle
          cx={52}
          cy={52}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={10}
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transform: "rotate(-90deg)", transformOrigin: "52px 52px" }}
        />
        <text
          x={52}
          y={56}
          textAnchor="middle"
          fontSize={18}
          fontWeight={700}
          fill="hsl(var(--foreground))"
        >
          {value}%
        </text>
      </svg>
      <p className="text-xs text-muted-foreground text-center leading-tight">{label}</p>
    </div>
  );
}

function KpiChip({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  accent: string;
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex items-center gap-3">
      <div className={`p-2 rounded-lg ${accent}`}>
        <Icon size={18} />
      </div>
      <div>
        <p className="text-xl font-bold text-foreground leading-tight">{value}</p>
        <p className="text-muted-foreground text-xs">{label}</p>
      </div>
    </div>
  );
}

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

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "مسودة",
  SENT: "مرسل",
  QUOTED: "مسعّر",
  FAILED: "فشل",
  SUCCESS: "ناجح",
};

const DEEP_COLORS = [
  "#1e3a5f",
  "#0ea5e9",
  "#f59e0b",
  "#10b981",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#14b8a6",
];

// ────────────────── print report ──────────────────
function printReport(html: string) {
  const win = window.open("", "_blank", "width=1100,height=800,scrollbars=yes");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.document.fonts.ready.then(() => {
    setTimeout(() => win.print(), 600);
  });
}

// ────────────────── page ──────────────────
import ReportsTab from "./reports";

export default function AnalyticsPage() {
  const { data: stats, isLoading } = useGetDashboardStats({
    query: { queryKey: getGetDashboardStatsQueryKey() },
  });

  const { data: empPerf, isLoading: empLoading } = useGetEmployeePerformance({
    query: { queryKey: getGetEmployeePerformanceQueryKey() },
  });

  const [pageTab, setPageTab] = useState<"analytics" | "reports">("analytics");
  const [supplierTab, setSupplierTab] = useState<"response" | "po" | "price" | "delivery">(
    "response",
  );

  // ── derived data ──
  const statusData =
    stats?.rfqsByStatus?.map((s) => ({
      name: s.status ?? "",
      count: s.count ?? 0,
    })) ?? [];

  const itemsPieData = [
    { name: "مسعّرة", value: stats?.pricedItems ?? 0, color: "#10b981" },
    { name: "غير مسعّرة", value: stats?.unpricedItems ?? 0, color: "#ef4444" },
  ].filter((d) => d.value > 0);

  const rfqVsPoData = [
    { name: "طلبات تسعير", value: stats?.totalRfqs ?? 0, fill: "#1e3a5f" },
    { name: "أوامر شراء", value: stats?.totalPos ?? 0, fill: "#0ea5e9" },
    { name: "RFQs مرتبطة بـ PO", value: stats?.rfqsWithPo ?? 0, fill: "#10b981" },
  ];

  const deepSuppliers = stats?.supplierDeepStats ?? [];

  const supplierChartData = deepSuppliers.map((s) => {
    const sName = s.supplierName ?? "";
    return {
      name: sName.length > 16 ? sName.slice(0, 16) + "…" : sName,
      responseRate: s.responseRate,
      poWinRate: s.poWinRate,
      avgPrice: s.avgPrice ?? 0,
      avgDelivery: s.avgDeliveryDays ?? 0,
      offers: s.totalOffersSubmitted,
      poItems: s.totalPoItems,
    };
  });

  const employees = Array.isArray(empPerf) ? empPerf : [];

  const loading = isLoading;

  // ── generate printable HTML ──
  const handlePrintReport = () => {
    const today = new Date().toLocaleDateString("ar-EG", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });

    const statusRows = statusData
      .map(
        (s) => `
        <tr>
          <td>${STATUS_LABELS[s.name] ?? s.name}</td>
          <td style="text-align:center">${s.count}</td>
          <td style="text-align:center">${stats?.totalRfqs ? Math.round((s.count / stats.totalRfqs) * 100) : 0}%</td>
        </tr>`,
      )
      .join("");

    const supplierRows = deepSuppliers
      .map(
        (s, i) => `
        <tr>
          <td style="text-align:center">${i + 1}</td>
          <td>${s.supplierName ?? ""}</td>
          <td style="text-align:center">${s.totalRfqsReceived ?? 0}</td>
          <td style="text-align:center">${s.totalOffersSubmitted ?? 0}</td>
          <td style="text-align:center">${s.responseRate ?? 0}%</td>
          <td style="text-align:center">${s.totalPoItems ?? 0}</td>
          <td style="text-align:center">${s.poWinRate ?? 0}%</td>
          <td style="text-align:center">${s.avgDeliveryDays != null ? s.avgDeliveryDays + " يوم" : "—"}</td>
        </tr>`,
      )
      .join("");

    const empRows = employees
      .map(
        (e, i) => `
        <tr>
          <td style="text-align:center">${i + 1}</td>
          <td>${e.employee?.name ?? "—"}</td>
          <td style="text-align:center">${e.totalRfqsSent ?? 0}</td>
          <td style="text-align:center">${e.totalOffersReceived ?? 0}</td>
          <td style="text-align:center">${e.responseRate ?? 0}%</td>
          <td style="text-align:center">${e.awardRate ?? 0}%</td>
          <td style="text-align:left;direction:ltr">${e.totalPurchaseValue != null ? Number(e.totalPurchaseValue).toLocaleString(undefined, { maximumFractionDigits: 0 }) + " ج.م" : "—"}</td>
        </tr>`,
      )
      .join("");

    const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="UTF-8"/>
<title>تقرير أداء المشتريات</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Cairo', Arial, sans-serif; font-size: 12px; color: #1e293b; background: #fff; padding: 24px; direction: rtl; }
  .nop { position: fixed; bottom: 20px; left: 20px; display: flex; gap: 8px; }
  @media print { .nop { display: none; } }
  .nop button { padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; font-family: inherit; font-size: 13px; }
  .nop button.pri { background: #1e3a5f; color: #fff; }
  .nop button.sec { background: #e2e8f0; color: #334155; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; border-bottom: 2px solid #1e3a5f; padding-bottom: 14px; }
  .header h1 { font-size: 20px; font-weight: 700; color: #1e3a5f; }
  .header .meta { font-size: 11px; color: #64748b; text-align: left; }
  .section { margin-bottom: 28px; }
  .section h2 { font-size: 13px; font-weight: 700; color: #1e3a5f; margin-bottom: 10px; padding-bottom: 4px; border-bottom: 1px solid #e2e8f0; }
  .kpi-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 20px; }
  .kpi { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; text-align: center; }
  .kpi .val { font-size: 20px; font-weight: 700; color: #1e3a5f; }
  .kpi .lbl { font-size: 10px; color: #64748b; margin-top: 2px; }
  .rates { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
  .rate { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 10px 12px; text-align: center; }
  .rate .val { font-size: 22px; font-weight: 700; color: #0369a1; }
  .rate .lbl { font-size: 10px; color: #0369a1; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { background: #1e3a5f; color: #fff; padding: 7px 10px; font-weight: 600; text-align: right; }
  td { padding: 6px 10px; border-bottom: 1px solid #f1f5f9; }
  tr:nth-child(even) td { background: #f8fafc; }
  .footer { margin-top: 30px; padding-top: 10px; border-top: 1px solid #e2e8f0; font-size: 10px; color: #94a3b8; text-align: center; }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>تقرير أداء المشتريات الشامل</h1>
    <p style="font-size:11px;color:#64748b;margin-top:4px">قرطبة للتوريدات</p>
  </div>
  <div class="meta">
    <div>تاريخ التقرير: ${today}</div>
    <div style="margin-top:4px">إجمالي طلبات التسعير: ${stats?.totalRfqs ?? 0}</div>
  </div>
</div>

<!-- KPIs -->
<div class="section">
  <h2>المؤشرات الرئيسية</h2>
  <div class="kpi-grid">
    <div class="kpi"><div class="val">${stats?.totalRfqs ?? 0}</div><div class="lbl">إجمالي طلبات التسعير</div></div>
    <div class="kpi"><div class="val">${stats?.openRfqs ?? 0}</div><div class="lbl">طلبات مفتوحة</div></div>
    <div class="kpi"><div class="val">${stats?.totalSuppliers ?? 0}</div><div class="lbl">الموردون</div></div>
    <div class="kpi"><div class="val">${stats?.totalOffers ?? 0}</div><div class="lbl">العروض المستلمة</div></div>
    <div class="kpi"><div class="val">${stats?.totalPos ?? 0}</div><div class="lbl">أوامر الشراء</div></div>
    <div class="kpi"><div class="val">${stats?.totalItems ?? 0}</div><div class="lbl">إجمالي البنود</div></div>
  </div>
  <div class="rates">
    <div class="rate"><div class="val">${stats?.pricingRate ?? 0}%</div><div class="lbl">نسبة التسعير</div></div>
    <div class="rate"><div class="val">${stats?.rfqToPoRate ?? 0}%</div><div class="lbl">تحويل RFQ → PO</div></div>
    <div class="rate"><div class="val">${stats?.poRate ?? 0}%</div><div class="lbl">البنود بـ PO</div></div>
    <div class="rate"><div class="val">${stats?.responseRateThisMonth ?? 0}%</div><div class="lbl">استجابة الموردين</div></div>
  </div>
</div>

<!-- RFQ Status -->
<div class="section">
  <h2>توزيع طلبات التسعير حسب الحالة</h2>
  <table>
    <thead><tr><th>الحالة</th><th style="text-align:center">العدد</th><th style="text-align:center">النسبة</th></tr></thead>
    <tbody>${statusRows || '<tr><td colspan="3" style="text-align:center;color:#94a3b8">لا توجد بيانات</td></tr>'}</tbody>
  </table>
</div>

<!-- Supplier Performance -->
<div class="section">
  <h2>تقرير أداء الموردين</h2>
  <table>
    <thead>
      <tr>
        <th style="text-align:center">#</th>
        <th>المورد</th>
        <th style="text-align:center">RFQs استلم</th>
        <th style="text-align:center">عروض أرسل</th>
        <th style="text-align:center">نسبة الاستجابة</th>
        <th style="text-align:center">بنود PO</th>
        <th style="text-align:center">نسبة الفوز بـ PO</th>
        <th style="text-align:center">متوسط التسليم</th>
      </tr>
    </thead>
    <tbody>${supplierRows || '<tr><td colspan="8" style="text-align:center;color:#94a3b8">لا توجد بيانات موردين</td></tr>'}</tbody>
  </table>
</div>

<!-- Employee Performance -->
${
  employees.length > 0
    ? `<div class="section">
  <h2>تقرير أداء الموظفين</h2>
  <table>
    <thead>
      <tr>
        <th style="text-align:center">#</th>
        <th>الموظف</th>
        <th style="text-align:center">RFQs أرسل</th>
        <th style="text-align:center">عروض استلم</th>
        <th style="text-align:center">معدل الاستجابة</th>
        <th style="text-align:center">نسبة الإسناد</th>
        <th>قيمة المشتريات</th>
      </tr>
    </thead>
    <tbody>${empRows}</tbody>
  </table>
</div>`
    : ""
}

<div class="footer">
  قرطبة للتوريدات · INFO@CORTOBA-SUPPLIES.COM · تم إنشاء هذا التقرير بتاريخ ${today}
</div>

<div class="nop">
  <button class="pri" onclick="window.print()">🖨️ &nbsp;طباعة / PDF</button>
  <button class="sec" onclick="window.close()">✕ إغلاق</button>
</div>

<script>
  document.fonts.ready.then(function(){ setTimeout(function(){ window.print(); }, 700); });
</script>
</body>
</html>`;

    printReport(html);
  };

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-6">
        {/* Header + top-level tabs */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">
              {pageTab === "analytics" ? "التحليلات" : "تقارير"}
            </h1>
            <p className="text-muted-foreground text-sm">
              {pageTab === "analytics"
                ? "تقرير أداء المشتريات الشامل"
                : "تقارير قابلة للطباعة والتصدير"}
            </p>
          </div>

          {/* Tab switcher */}
          <div className="flex gap-1 bg-muted rounded-lg p-1 text-sm">
            <button
              onClick={() => setPageTab("analytics")}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md transition-colors ${
                pageTab === "analytics"
                  ? "bg-card text-foreground shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <BarChart2 size={14} />
              التحليلات
            </button>
            <button
              onClick={() => setPageTab("reports")}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md transition-colors ${
                pageTab === "reports"
                  ? "bg-card text-foreground shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <ClipboardList size={14} />
              تقارير
            </button>
          </div>
        </div>

        {/* ══════════════ ANALYTICS TAB ══════════════ */}
        {pageTab === "analytics" && (
          <>
            {loading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-48 bg-muted rounded-lg animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="space-y-6">
                {/* ── Row 1: Core KPIs ── */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  <KpiChip
                    label="إجمالي طلبات التسعير"
                    value={stats?.totalRfqs ?? 0}
                    icon={FileText}
                    accent="bg-blue-100 text-blue-700"
                  />
                  <KpiChip
                    label="طلبات مفتوحة"
                    value={stats?.openRfqs ?? 0}
                    icon={Clock}
                    accent="bg-amber-100 text-amber-700"
                  />
                  <KpiChip
                    label="الموردون النشطون"
                    value={stats?.totalSuppliers ?? 0}
                    icon={Users}
                    accent="bg-purple-100 text-purple-700"
                  />
                  <KpiChip
                    label="العروض المستلمة"
                    value={stats?.totalOffers ?? 0}
                    icon={TrendingUp}
                    accent="bg-teal-100 text-teal-700"
                  />
                  <KpiChip
                    label="أوامر الشراء"
                    value={stats?.totalPos ?? 0}
                    icon={ShoppingCart}
                    accent="bg-green-100 text-green-700"
                  />
                  <KpiChip
                    label="البنود الكلية"
                    value={stats?.totalItems ?? 0}
                    icon={Package}
                    accent="bg-slate-100 text-slate-700"
                  />
                </div>

                {/* ── Row 2: Rate rings + RFQ→PO funnel ── */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Rate rings */}
                  <div className="bg-card border border-border rounded-lg p-5">
                    <h2 className="font-semibold text-sm text-foreground mb-5">نسب الأداء الرئيسية</h2>
                    <div className="flex flex-wrap justify-around gap-6">
                      <RateRing value={stats?.pricingRate ?? 0} label="نسبة التسعير" color="#0ea5e9" />
                      <RateRing value={stats?.poRate ?? 0} label="نسبة البنود بـ PO" color="#10b981" />
                      <RateRing
                        value={stats?.rfqToPoRate ?? 0}
                        label="تحويل RFQ → PO"
                        color="#f59e0b"
                      />
                      <RateRing
                        value={stats?.responseRateThisMonth ?? 0}
                        label="معدل استجابة الموردين"
                        color="#8b5cf6"
                      />
                    </div>
                  </div>

                  {/* Items pricing donut */}
                  <div className="bg-card border border-border rounded-lg p-5">
                    <h2 className="font-semibold text-sm text-foreground mb-1">
                      البنود المسعّرة مقابل الغير مسعّرة
                    </h2>
                    <p className="text-xs text-muted-foreground mb-4">
                      {stats?.pricedItems ?? 0} مسعّرة · {stats?.unpricedItems ?? 0} غير مسعّرة ·{" "}
                      {stats?.itemsWithPo ?? 0} صدر لها PO
                    </p>
                    {itemsPieData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <PieChart>
                          <Pie
                            data={itemsPieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={55}
                            outerRadius={85}
                            dataKey="value"
                            label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                            labelLine={false}
                          >
                            {itemsPieData.map((d, i) => (
                              <Cell key={i} fill={d.color} />
                            ))}
                          </Pie>
                          <Tooltip formatter={(v) => [v, "بنود"]} />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
                        لا توجد بيانات
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Row 3: RFQ Status + RFQ vs PO bar ── */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-card border border-border rounded-lg p-5">
                    <h2 className="font-semibold text-sm text-foreground mb-4">
                      توزيع طلبات التسعير حسب الحالة
                    </h2>
                    {statusData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={statusData} barCategoryGap="30%">
                          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                          <Tooltip />
                          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                            {statusData.map((d, i) => (
                              <Cell
                                key={i}
                                fill={STATUS_COLORS[d.name] ?? DEEP_COLORS[i % DEEP_COLORS.length]}
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
                        لا توجد بيانات
                      </div>
                    )}
                  </div>

                  <div className="bg-card border border-border rounded-lg p-5">
                    <h2 className="font-semibold text-sm text-foreground mb-1">
                      العلاقة بين طلبات التسعير والـ PO
                    </h2>
                    <p className="text-xs text-muted-foreground mb-4">
                      {stats?.rfqsWithPo ?? 0} من أصل {stats?.totalRfqs ?? 0} طلب تسعير تحول إلى أمر
                      شراء
                    </p>
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={rfqVsPoData} barCategoryGap="35%">
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                        <Tooltip />
                        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                          {rfqVsPoData.map((d, i) => (
                            <Cell key={i} fill={d.fill} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* ── Row 4: Deep Supplier Analysis ── */}
                <div className="bg-card border border-border rounded-lg p-5">
                  <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                    <div>
                      <h2 className="font-semibold text-sm text-foreground">تحليل الموردين المتعمق</h2>
                      <p className="text-xs text-muted-foreground">
                        معدل الاستجابة · نسبة الفوز بـ PO · متوسط السعر · أيام التسليم
                      </p>
                    </div>
                    <div className="flex gap-1 bg-muted rounded-lg p-1 text-xs">
                      {(["response", "po", "price", "delivery"] as const).map((tab) => (
                        <button
                          key={tab}
                          onClick={() => setSupplierTab(tab)}
                          className={`px-3 py-1 rounded-md transition-colors ${supplierTab === tab ? "bg-card text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
                        >
                          {tab === "response"
                            ? "الاستجابة"
                            : tab === "po"
                              ? "PO فوز"
                              : tab === "price"
                                ? "السعر"
                                : "التسليم"}
                        </button>
                      ))}
                    </div>
                  </div>

                  {supplierChartData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={supplierChartData} layout="vertical" barCategoryGap="20%">
                        <XAxis
                          type="number"
                          tick={{ fontSize: 10 }}
                          domain={
                            supplierTab === "response" || supplierTab === "po" ? [0, 100] : undefined
                          }
                          tickFormatter={
                            supplierTab === "response" || supplierTab === "po"
                              ? (v) => `${v}%`
                              : undefined
                          }
                        />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={120} />
                        <Tooltip
                          formatter={(v, name) => {
                            if (name === "responseRate" || name === "poWinRate")
                              return [`${v}%`, name === "responseRate" ? "معدل الاستجابة" : "نسبة PO"];
                            if (name === "avgPrice") return [Number(v).toLocaleString(), "متوسط السعر"];
                            if (name === "avgDelivery") return [`${v} يوم`, "متوسط التسليم"];
                            return [v, name];
                          }}
                        />
                        {supplierTab === "response" && (
                          <Bar
                            dataKey="responseRate"
                            fill="#0ea5e9"
                            radius={[0, 4, 4, 0]}
                            name="responseRate"
                          />
                        )}
                        {supplierTab === "po" && (
                          <Bar
                            dataKey="poWinRate"
                            fill="#10b981"
                            radius={[0, 4, 4, 0]}
                            name="poWinRate"
                          />
                        )}
                        {supplierTab === "price" && (
                          <Bar
                            dataKey="avgPrice"
                            fill="#f59e0b"
                            radius={[0, 4, 4, 0]}
                            name="avgPrice"
                          />
                        )}
                        {supplierTab === "delivery" && (
                          <Bar
                            dataKey="avgDelivery"
                            fill="#8b5cf6"
                            radius={[0, 4, 4, 0]}
                            name="avgDelivery"
                          />
                        )}
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
                      لا توجد بيانات موردين
                    </div>
                  )}
                </div>

                {/* ── Row 5: Full supplier table ── */}
                <div className="bg-card border border-border rounded-lg p-5 overflow-x-auto">
                  <h2 className="font-semibold text-sm text-foreground mb-4">جدول الموردين التفصيلي</h2>
                  {deepSuppliers.length > 0 ? (
                    <table className="w-full text-xs min-w-[640px]">
                      <thead>
                        <tr className="border-b border-border text-left">
                          {[
                            "#",
                            "المورد",
                            "الفئة",
                            "RFQs استلم",
                            "عروض أرسل",
                            "استجابة %",
                            "بنود عُرضت",
                            "بنود PO",
                            "PO فوز %",
                            "متوسط السعر",
                            "تسليم (يوم)",
                          ].map((h) => (
                            <th
                              key={h}
                              className="pb-2 text-muted-foreground font-medium whitespace-nowrap pr-4"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {deepSuppliers.map((s, i) => (
                          <tr
                            key={s.supplierId}
                            className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                          >
                            <td className="py-2.5 text-muted-foreground pr-4">{i + 1}</td>
                            <td className="py-2.5 font-medium text-foreground pr-4 whitespace-nowrap">
                              {s.supplierName}
                            </td>
                            <td className="py-2.5 text-muted-foreground pr-4">{s.category || "—"}</td>
                            <td className="py-2.5 text-center pr-4">{s.totalRfqsReceived}</td>
                            <td className="py-2.5 text-center pr-4">{s.totalOffersSubmitted}</td>
                            <td className="py-2.5 pr-4">
                              <div className="flex items-center gap-1.5">
                                <div className="w-12 bg-muted rounded-full h-1.5 shrink-0">
                                  <div
                                    className="bg-blue-500 h-1.5 rounded-full"
                                    style={{ width: `${Math.min(100, s.responseRate ?? 0)}%` }}
                                  />
                                </div>
                                <span
                                  className={`font-medium ${(s.responseRate ?? 0) >= 70 ? "text-green-600" : (s.responseRate ?? 0) >= 40 ? "text-amber-600" : "text-red-500"}`}
                                >
                                  {s.responseRate ?? 0}%
                                </span>
                              </div>
                            </td>
                            <td className="py-2.5 text-center pr-4">{s.totalItemsOffered}</td>
                            <td className="py-2.5 text-center pr-4">{s.totalPoItems}</td>
                            <td className="py-2.5 pr-4">
                              <div className="flex items-center gap-1.5">
                                <div className="w-12 bg-muted rounded-full h-1.5 shrink-0">
                                  <div
                                    className="bg-green-500 h-1.5 rounded-full"
                                    style={{ width: `${Math.min(100, s.poWinRate ?? 0)}%` }}
                                  />
                                </div>
                                <span
                                  className={`font-medium ${(s.poWinRate ?? 0) >= 40 ? "text-green-600" : (s.poWinRate ?? 0) >= 20 ? "text-amber-600" : "text-muted-foreground"}`}
                                >
                                  {s.poWinRate ?? 0}%
                                </span>
                              </div>
                            </td>
                            <td className="py-2.5 text-center pr-4">
                              {s.avgPrice != null
                                ? Number(s.avgPrice).toLocaleString(undefined, {
                                    maximumFractionDigits: 2,
                                  })
                                : "—"}
                            </td>
                            <td className="py-2.5 text-center pr-4">
                              {s.avgDeliveryDays != null ? s.avgDeliveryDays : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="py-10 text-center text-muted-foreground text-sm">
                      لا توجد بيانات موردين بعد
                    </div>
                  )}
                </div>

                {/* ── Row 6: Supplier Radar (top 6) ── */}
                {supplierChartData.length >= 2 && (
                  <div className="bg-card border border-border rounded-lg p-5">
                    <h2 className="font-semibold text-sm text-foreground mb-4">
                      مقارنة راداريّة لأفضل الموردين
                    </h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {supplierChartData.slice(0, 6).map((s, i) => {
                        const radarData = [
                          { subject: "استجابة", value: s.responseRate },
                          { subject: "PO فوز", value: s.poWinRate },
                          { subject: "عروض", value: Math.min(100, (s.offers ?? 0) * 5) },
                        ];
                        return (
                          <div key={i} className="text-center">
                            <p className="text-xs font-medium text-foreground mb-1">{s.name}</p>
                            <ResponsiveContainer width="100%" height={140}>
                              <RadarChart data={radarData}>
                                <PolarGrid />
                                <PolarAngleAxis dataKey="subject" tick={{ fontSize: 10 }} />
                                <Radar
                                  name={s.name}
                                  dataKey="value"
                                  stroke={DEEP_COLORS[i % DEEP_COLORS.length]}
                                  fill={DEEP_COLORS[i % DEEP_COLORS.length]}
                                  fillOpacity={0.3}
                                />
                              </RadarChart>
                            </ResponsiveContainer>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ══════════════ REPORTS TAB ══════════════ */}
        {pageTab === "reports" && <ReportsTab />}
      </div>
    </Layout>
  );
}

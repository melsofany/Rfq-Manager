import {
  useGetDashboardStats,
  getGetDashboardStatsQueryKey,
  useListEmployees,
  getListEmployeesQueryKey,
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
  LineChart,
  Line,
  CartesianGrid,
} from "recharts";
import { useState, useEffect, useCallback } from "react";
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
  RefreshCw,
  Building2,
  UserCheck,
  MessageSquare,
  Database,
  Wallet,
  Receipt,
  Banknote,
  Calculator,
  Truck,
  Activity,
  TrendingDown,
  Scale,
  UserCircle,
} from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

// ────────────────── overview types ──────────────────
interface OverviewCounts {
  rfqs: number;
  openRfqs: number;
  suppliers: number;
  offers: number;
  pos: number;
  items: number;
  customers: number;
  customerRfqs: number;
  customerPos: number;
  representatives: number;
  employees: number;
  whatsappChats: number;
  auditEntries: number;
  journalEntries: number;
  supplierInvoices: number;
  salesInvoices: number;
}
interface OverviewRates {
  pricingRate: number;
  poRate: number;
  rfqToPoRate: number;
  responseRateThisMonth: number;
  avgResponseTimeHours: number | null;
}
interface StatusDist { status: string; count: number; }
interface OverviewData {
  counts: OverviewCounts;
  rates: OverviewRates;
  itemAnalytics: { totalItems: number; pricedItems: number; unpricedItems: number; itemsWithPo: number };
  distributions: {
    rfqsByStatus: StatusDist[];
    customerRfqsByStatus: StatusDist[];
    customerPosByStatus: StatusDist[];
    posByStatus: StatusDist[];
  };
  operations: {
    poReceipt: { total: number; received: number; rejected: number };
    customerPoDelivery: { total: number; delivered: number; rejected: number; pending: number };
  };
  financials: {
    margins: { totalRevenue: number | null; totalCost: number | null; totalMargin: number | null; marginPct: number | null; lossLines: number; lineCount: number; pricedLines: number };
    vat: { vatRate: number; output: { net: number | null; vat: number | null }; input: { net: number | null; vat: number | null }; netVat: number; payable: number; credit: number };
    withholding: { rate: number; totalNet: number | null; totalWithholding: number | null; totalPayable: number | null };
    accounts: { totalAP: number | null; totalAR: number | null; cash: number | null; bank: number | null; pendingDrafts: number };
    expenses: { grandTotal: number | null; byCategory: { category: string; total: number; count: number }[] };
    collections: { totalReceivable: number | null; totalCollected: number | null; outstandingCount: number; overdueCount: number; dueSoonCount: number };
    statements: { netProfit: number | null; totalAssets: number | null; totalLiabilities: number | null; totalEquity: number | null };
  };
  monthlyTrend: { month: string; rfqs: number; pos: number; customerRfqs: number }[];
  topSuppliers: { supplierId: number; supplierName: string; category: string; totalRfqsReceived: number; totalOffersSubmitted: number; responseRate: number; totalPoItems: number; avgPrice: number | null }[];
  recentActivity: { id: number; action: string; description: string; employeeName: string | null; createdAt: string }[];
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return "—";
  return Number(v).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtMonth(m: string | undefined): string {
  if (!m) return "";
  const [y, mo] = m.split("-");
  const months = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  return `${months[parseInt(mo, 10) - 1]} ${y}`;
}
function timeAgo(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "الآن";
  if (mins < 60) return `منذ ${mins} دقيقة`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `منذ ${hrs} ساعة`;
  const days = Math.floor(hrs / 24);
  return `منذ ${days} يوم`;
}

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

// ────────────────── status distribution card ──────────────────
function StatusDistCard({ title, data }: { title: string; data: { status: string; count: number }[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  const palette = ["#1e3a5f", "#0ea5e9", "#f59e0b", "#10b981", "#8b5cf6", "#ec4899", "#f97316", "#14b8a6", "#6366f1", "#64748b"];
  return (
    <div className="bg-card border border-border rounded-lg p-5">
      <h2 className="font-semibold text-sm text-foreground mb-3">{title}</h2>
      {data.length > 0 ? (
        <div className="flex items-center gap-4">
          <ResponsiveContainer width="50%" height={160}>
            <PieChart>
              <Pie data={data.map((d) => ({ name: d.status, value: d.count }))} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={55} innerRadius={28} paddingAngle={2}>
                {data.map((_, i) => <Cell key={i} fill={palette[i % palette.length]} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="flex-1 space-y-1.5 text-xs">
            {data.map((d, i) => (
              <div key={d.status} className="flex justify-between items-center">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ background: palette[i % palette.length] }} />
                  {d.status}
                </span>
                <span className="font-medium text-foreground">
                  {d.count}
                  <span className="text-muted-foreground/60 mr-1"> ({total > 0 ? Math.round((d.count / total) * 100) : 0}%)</span>
                </span>
              </div>
            ))}
            <div className="flex justify-between border-t border-border pt-1.5 mt-1.5 font-medium">
              <span className="text-muted-foreground">الإجمالي</span>
              <span className="text-foreground">{total}</span>
            </div>
          </div>
        </div>
      ) : (
        <p className="text-center text-muted-foreground text-sm py-6">لا توجد بيانات</p>
      )}
    </div>
  );
}

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

// ────────────────── procurement employee performance section ──────────────────
interface ProcurementEmployee {
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
interface ProcurementResponse {
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

function ProcurementPerformanceSection() {
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
            إنتاجية كل موظف عبر دورة طلبات التسعير: الطلبات، البنود، العروض، التحويل لأمر شراء، والطلبات الفاشلة
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
              {totals.rfqCount ? Math.round((totals.convertedRfqs / totals.rfqCount) * 1000) / 10 : 0}%
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
        <p className="text-sm text-muted-foreground text-center py-8">
          لا توجد بيانات مشتريات بعد
        </p>
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
                    <span className="block text-[10px] text-muted-foreground font-normal">{emp.role}</span>
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
                  <td className="text-center p-3 text-emerald-600 font-medium">{emp.convertedRfqs}</td>
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
interface DataEntryEmployee {
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
interface DataEntryResponse {
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

function DataEntryPerformanceSection() {
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
            <p className="text-[10px] text-muted-foreground mt-0.5">{totals.completedSessions} جلسة مكتملة</p>
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
                    <span className="block text-[10px] text-muted-foreground font-normal">{emp.role}</span>
                  </td>
                  <td className="text-center p-3 text-foreground">{emp.counts.rfqs}</td>
                  <td className="text-center p-3 text-muted-foreground">{emp.counts.rfqItems}</td>
                  <td className="text-center p-3 text-foreground">{emp.counts.customerRfqs}</td>
                  <td className="text-center p-3 text-muted-foreground">{emp.counts.customerRfqItems}</td>
                  <td className="text-center p-3 text-foreground">{emp.counts.pos}</td>
                  <td className="text-center p-3 text-muted-foreground">{emp.counts.poItems}</td>
                  <td className="text-center p-3 text-foreground">{emp.counts.customerPos}</td>
                  <td className="text-center p-3 text-muted-foreground">{emp.counts.customerPoItems}</td>
                  <td className="text-center p-3 text-sky-600 font-medium">{emp.durations.avgFormatted}</td>
                  <td className="text-center p-3 text-foreground font-medium">{emp.durations.totalFormatted}</td>
                  <td className="text-center p-3 text-emerald-600">{emp.durations.weeklyFormatted}</td>
                  <td className="text-center p-3 text-violet-600">{emp.durations.monthlyFormatted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function AnalyticsPage() {
  const { data: stats, isLoading } = useGetDashboardStats({
    query: { queryKey: getGetDashboardStatsQueryKey() },
  });

  const { data: empPerf, isLoading: empLoading } = useListEmployees({
    query: { queryKey: getListEmployeesQueryKey() },
  });

  // ── comprehensive overview (all project numbers in one call) ──
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    try {
      const res = await fetch("/api/analytics/overview", { credentials: "include" });
      if (!res.ok) throw new Error("فشل تحميل البيانات الشاملة");
      setOverview(await res.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل البيانات الشاملة"));
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

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
          <td>${e.name ?? "—"}</td>
          <td style="text-align:center">—</td>
          <td style="text-align:center">—</td>
          <td style="text-align:center">—</td>
          <td style="text-align:center">—</td>
          <td style="text-align:left;direction:ltr">—</td>
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
                    <h2 className="font-semibold text-sm text-foreground mb-5">
                      نسب الأداء الرئيسية
                    </h2>
                    <div className="flex flex-wrap justify-around gap-6">
                      <RateRing
                        value={stats?.pricingRate ?? 0}
                        label="نسبة التسعير"
                        color="#0ea5e9"
                      />
                      <RateRing
                        value={stats?.poRate ?? 0}
                        label="نسبة البنود بـ PO"
                        color="#10b981"
                      />
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
                      <h2 className="font-semibold text-sm text-foreground">
                        تحليل الموردين المتعمق
                      </h2>
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
                            supplierTab === "response" || supplierTab === "po"
                              ? [0, 100]
                              : undefined
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
                              return [
                                `${v}%`,
                                name === "responseRate" ? "معدل الاستجابة" : "نسبة PO",
                              ];
                            if (name === "avgPrice")
                              return [Number(v).toLocaleString(), "متوسط السعر"];
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
                  <h2 className="font-semibold text-sm text-foreground mb-4">
                    جدول الموردين التفصيلي
                  </h2>
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
                            <td className="py-2.5 text-muted-foreground pr-4">
                              {s.category || "—"}
                            </td>
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

                {/* ════════════════════════════════════════════════════════ */}
                {/* ══ COMPREHENSIVE PROJECT OVERVIEW (all numbers) ══ */}
                {/* ════════════════════════════════════════════════════════ */}
                {overviewLoading ? (
                  <div className="flex items-center justify-center py-10 text-muted-foreground">
                    <RefreshCw size={20} className="animate-spin ml-2" />
                    جاري تحميل البيانات الشاملة...
                  </div>
                ) : overview ? (
                  <div className="space-y-6">
                    {/* ── Section: Entity Counts Grid ── */}
                    <div className="bg-card border border-border rounded-lg p-5">
                      <div className="flex items-center justify-between mb-4">
                        <h2 className="font-semibold text-sm text-foreground flex items-center gap-2">
                          <Database size={16} className="text-primary" />
                          إحصائيات شاملة للمشروع
                        </h2>
                        <button
                          onClick={loadOverview}
                          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                        >
                          <RefreshCw size={12} />
                          تحديث
                        </button>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                        {[
                          { label: "طلبات تسعير الموردين", value: overview.counts.rfqs, icon: FileText, color: "bg-blue-100 text-blue-700" },
                          { label: "طلبات مفتوحة", value: overview.counts.openRfqs, icon: Clock, color: "bg-amber-100 text-amber-700" },
                          { label: "طلبات تسعير العملاء", value: overview.counts.customerRfqs, icon: FileText, color: "bg-indigo-100 text-indigo-700" },
                          { label: "أوامر شراء العملاء", value: overview.counts.customerPos, icon: ShoppingCart, color: "bg-emerald-100 text-emerald-700" },
                          { label: "أوامر شراء الموردين", value: overview.counts.pos, icon: Package, color: "bg-green-100 text-green-700" },
                          { label: "إجمالي البنود", value: overview.counts.items, icon: Package, color: "bg-slate-100 text-slate-700" },
                          { label: "الموردون النشطون", value: overview.counts.suppliers, icon: Users, color: "bg-purple-100 text-purple-700" },
                          { label: "العملاء النشطون", value: overview.counts.customers, icon: Building2, color: "bg-cyan-100 text-cyan-700" },
                          { label: "العروض المستلمة", value: overview.counts.offers, icon: TrendingUp, color: "bg-teal-100 text-teal-700" },
                          { label: "المندوبون", value: overview.counts.representatives, icon: UserCheck, color: "bg-orange-100 text-orange-700" },
                          { label: "الموظفون", value: overview.counts.employees, icon: Users, color: "bg-pink-100 text-pink-700" },
                          { label: "محادثات واتساب", value: overview.counts.whatsappChats, icon: MessageSquare, color: "bg-green-100 text-green-700" },
                          { label: "فواتير الموردين", value: overview.counts.supplierInvoices, icon: Receipt, color: "bg-red-100 text-red-700" },
                          { label: "فواتير البيع", value: overview.counts.salesInvoices, icon: Receipt, color: "bg-blue-100 text-blue-700" },
                          { label: "قيود اليومية", value: overview.counts.journalEntries, icon: Calculator, color: "bg-violet-100 text-violet-700" },
                          { label: "سجل التدقيق", value: overview.counts.auditEntries, icon: Activity, color: "bg-gray-100 text-gray-700" },
                        ].map((kpi) => (
                          <div key={kpi.label} className="bg-muted/40 border border-border rounded-lg p-3 flex items-center gap-2.5">
                            <div className={`p-2 rounded-lg ${kpi.color} shrink-0`}>
                              <kpi.icon size={16} />
                            </div>
                            <div className="min-w-0">
                              <p className="text-lg font-bold text-foreground leading-tight">{kpi.value}</p>
                              <p className="text-muted-foreground text-[11px] leading-tight truncate">{kpi.label}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* ── Section: Operations (PO receipt + Customer delivery) ── */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="bg-card border border-border rounded-lg p-5">
                        <h2 className="font-semibold text-sm text-foreground flex items-center gap-2 mb-4">
                          <Truck size={16} className="text-primary" />
                          استلام التوريدات من الموردين
                        </h2>
                        <div className="grid grid-cols-3 gap-3 mb-4">
                          <div className="text-center bg-muted/40 rounded-lg p-3">
                            <p className="text-2xl font-bold text-foreground">{overview.operations.poReceipt.total}</p>
                            <p className="text-xs text-muted-foreground">إجمالي البنود</p>
                          </div>
                          <div className="text-center bg-emerald-50 dark:bg-emerald-950/30 rounded-lg p-3">
                            <p className="text-2xl font-bold text-emerald-600">{overview.operations.poReceipt.received}</p>
                            <p className="text-xs text-muted-foreground">تم الاستلام</p>
                          </div>
                          <div className="text-center bg-red-50 dark:bg-red-950/30 rounded-lg p-3">
                            <p className="text-2xl font-bold text-red-500">{overview.operations.poReceipt.rejected}</p>
                            <p className="text-xs text-muted-foreground">مرفوض</p>
                          </div>
                        </div>
                        {overview.operations.poReceipt.total > 0 && (
                          <div className="space-y-2">
                            <div className="flex justify-between text-xs text-muted-foreground">
                              <span>نسبة الاستلام</span>
                              <span className="font-bold text-foreground">
                                {Math.round((overview.operations.poReceipt.received / overview.operations.poReceipt.total) * 100)}%
                              </span>
                            </div>
                            <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                              <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${(overview.operations.poReceipt.received / overview.operations.poReceipt.total) * 100}%` }} />
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="bg-card border border-border rounded-lg p-5">
                        <h2 className="font-semibold text-sm text-foreground flex items-center gap-2 mb-4">
                          <Package size={16} className="text-primary" />
                          تسليم البضاعة للعملاء
                        </h2>
                        <div className="grid grid-cols-4 gap-2 mb-4">
                          <div className="text-center bg-muted/40 rounded-lg p-2">
                            <p className="text-xl font-bold text-foreground">{overview.operations.customerPoDelivery.total}</p>
                            <p className="text-[10px] text-muted-foreground">إجمالي</p>
                          </div>
                          <div className="text-center bg-emerald-50 dark:bg-emerald-950/30 rounded-lg p-2">
                            <p className="text-xl font-bold text-emerald-600">{overview.operations.customerPoDelivery.delivered}</p>
                            <p className="text-[10px] text-muted-foreground">مُسلّم</p>
                          </div>
                          <div className="text-center bg-red-50 dark:bg-red-950/30 rounded-lg p-2">
                            <p className="text-xl font-bold text-red-500">{overview.operations.customerPoDelivery.rejected}</p>
                            <p className="text-[10px] text-muted-foreground">مرفوض</p>
                          </div>
                          <div className="text-center bg-amber-50 dark:bg-amber-950/30 rounded-lg p-2">
                            <p className="text-xl font-bold text-amber-600">{overview.operations.customerPoDelivery.pending}</p>
                            <p className="text-[10px] text-muted-foreground">منتظر</p>
                          </div>
                        </div>
                        {overview.operations.customerPoDelivery.total > 0 && (
                          <div className="space-y-2">
                            <div className="flex justify-between text-xs text-muted-foreground">
                              <span>نسبة التسليم</span>
                              <span className="font-bold text-foreground">
                                {Math.round((overview.operations.customerPoDelivery.delivered / overview.operations.customerPoDelivery.total) * 100)}%
                              </span>
                            </div>
                            <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                              <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${(overview.operations.customerPoDelivery.delivered / overview.operations.customerPoDelivery.total) * 100}%` }} />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* ── Section: Status Distributions ── */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <StatusDistCard title="توزيع طلبات تسعير الموردين" data={overview.distributions.rfqsByStatus} />
                      <StatusDistCard title="توزيع طلبات تسعير العملاء" data={overview.distributions.customerRfqsByStatus} />
                      <StatusDistCard title="توزيع أوامر شراء العملاء" data={overview.distributions.customerPosByStatus} />
                      <StatusDistCard title="توزيع أوامر شراء الموردين" data={overview.distributions.posByStatus} />
                    </div>

                    {/* ── Section: Financial Summary ── */}
                    <div className="bg-card border border-border rounded-lg p-5">
                      <h2 className="font-semibold text-sm text-foreground flex items-center gap-2 mb-4">
                        <Wallet size={16} className="text-primary" />
                        الملخص المالي الشامل
                      </h2>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {/* Margins */}
                        <div className="border border-border rounded-lg p-4 bg-gradient-to-br from-emerald-50/50 to-transparent dark:from-emerald-950/20">
                          <h3 className="text-xs font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
                            <TrendingUp size={13} /> الهامش المحقق
                          </h3>
                          <div className="space-y-1.5 text-xs">
                            <div className="flex justify-between"><span className="text-muted-foreground">الإيرادات</span><span className="font-medium text-foreground">{fmtMoney(overview.financials.margins.totalRevenue)}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">التكلفة</span><span className="font-medium text-foreground">{fmtMoney(overview.financials.margins.totalCost)}</span></div>
                            <div className="flex justify-between border-t border-border pt-1.5"><span className="font-medium text-foreground">صافي الهامش</span><span className={`font-bold ${(overview.financials.margins.totalMargin ?? 0) >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtMoney(overview.financials.margins.totalMargin)}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">نسبة الهامش</span><span className="font-medium text-foreground">{overview.financials.margins.marginPct != null ? `${Number(overview.financials.margins.marginPct).toFixed(1)}%` : "—"}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">بنود خاسرة</span><span className={`font-medium ${overview.financials.margins.lossLines > 0 ? "text-red-500" : "text-foreground"}`}>{overview.financials.margins.lossLines}</span></div>
                          </div>
                        </div>

                        {/* VAT */}
                        <div className="border border-border rounded-lg p-4 bg-gradient-to-br from-blue-50/50 to-transparent dark:from-blue-950/20">
                          <h3 className="text-xs font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
                            <Receipt size={13} /> ضريبة القيمة المضافة ({overview.financials.vat.vatRate}%)
                          </h3>
                          <div className="space-y-1.5 text-xs">
                            <div className="flex justify-between"><span className="text-muted-foreground">ض.مخرجات</span><span className="font-medium text-foreground">{fmtMoney(overview.financials.vat.output.vat)}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">ض.مدخلات</span><span className="font-medium text-foreground">{fmtMoney(overview.financials.vat.input.vat)}</span></div>
                            <div className="flex justify-between border-t border-border pt-1.5"><span className="font-medium text-foreground">صافي المستحق</span><span className={`font-bold ${overview.financials.vat.netVat >= 0 ? "text-blue-600" : "text-emerald-600"}`}>{fmtMoney(overview.financials.vat.netVat)}</span></div>
                            {overview.financials.vat.payable > 0 && (
                              <div className="flex justify-between"><span className="text-muted-foreground">مستحق للضرائب</span><span className="font-medium text-blue-600">{fmtMoney(overview.financials.vat.payable)}</span></div>
                            )}
                            {overview.financials.vat.credit > 0 && (
                              <div className="flex justify-between"><span className="text-muted-foreground">ائتمان محمول</span><span className="font-medium text-emerald-600">{fmtMoney(overview.financials.vat.credit)}</span></div>
                            )}
                          </div>
                        </div>

                        {/* Withholding */}
                        <div className="border border-border rounded-lg p-4 bg-gradient-to-br from-amber-50/50 to-transparent dark:from-amber-950/20">
                          <h3 className="text-xs font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
                            <Receipt size={13} /> خصم تحت حساب المورد ({overview.financials.withholding.rate}%)
                          </h3>
                          <div className="space-y-1.5 text-xs">
                            <div className="flex justify-between"><span className="text-muted-foreground">صافي المشتريات</span><span className="font-medium text-foreground">{fmtMoney(overview.financials.withholding.totalNet)}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">إجمالي الخصم</span><span className="font-medium text-amber-600">{fmtMoney(overview.financials.withholding.totalWithholding)}</span></div>
                            <div className="flex justify-between border-t border-border pt-1.5"><span className="font-medium text-foreground">المستحق للموردين</span><span className="font-bold text-emerald-600">{fmtMoney(overview.financials.withholding.totalPayable)}</span></div>
                          </div>
                        </div>

                        {/* AP / AR */}
                        <div className="border border-border rounded-lg p-4 bg-gradient-to-br from-red-50/50 to-transparent dark:from-red-950/20">
                          <h3 className="text-xs font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
                            <Banknote size={13} /> الذمم (موردون / عملاء)
                          </h3>
                          <div className="space-y-1.5 text-xs">
                            <div className="flex justify-between"><span className="text-muted-foreground">ذمم دائنة (موردين)</span><span className="font-medium text-red-600">{fmtMoney(overview.financials.accounts.totalAP)}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">ذمم مدينة (عملاء)</span><span className="font-medium text-emerald-600">{fmtMoney(overview.financials.accounts.totalAR)}</span></div>
                            <div className="flex justify-between border-t border-border pt-1.5"><span className="font-medium text-foreground">صافي الذمم</span><span className="font-bold text-foreground">{fmtMoney((overview.financials.accounts.totalAR ?? 0) - (overview.financials.accounts.totalAP ?? 0))}</span></div>
                          </div>
                        </div>

                        {/* Cash / Bank */}
                        <div className="border border-border rounded-lg p-4 bg-gradient-to-br from-green-50/50 to-transparent dark:from-green-950/20">
                          <h3 className="text-xs font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
                            <Wallet size={13} /> النقدية والبنوك
                          </h3>
                          <div className="space-y-1.5 text-xs">
                            <div className="flex justify-between"><span className="text-muted-foreground">النقدية بالخزينة</span><span className="font-medium text-foreground">{fmtMoney(overview.financials.accounts.cash)}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">البنوك</span><span className="font-medium text-foreground">{fmtMoney(overview.financials.accounts.bank)}</span></div>
                            <div className="flex justify-between border-t border-border pt-1.5"><span className="font-medium text-foreground">إجمالي السيولة</span><span className="font-bold text-emerald-600">{fmtMoney((overview.financials.accounts.cash ?? 0) + (overview.financials.accounts.bank ?? 0))}</span></div>
                            {overview.financials.accounts.pendingDrafts > 0 && (
                              <div className="flex justify-between"><span className="text-muted-foreground">قيود بانتظار المراجعة</span><span className="font-medium text-amber-600">{overview.financials.accounts.pendingDrafts}</span></div>
                            )}
                          </div>
                        </div>

                        {/* Financial Statements */}
                        <div className="border border-border rounded-lg p-4 bg-gradient-to-br from-violet-50/50 to-transparent dark:from-violet-950/20">
                          <h3 className="text-xs font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
                            <Scale size={13} /> القوائم المالية
                          </h3>
                          <div className="space-y-1.5 text-xs">
                            <div className="flex justify-between"><span className="text-muted-foreground">صافي الربح</span><span className={`font-medium ${(overview.financials.statements.netProfit ?? 0) >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtMoney(overview.financials.statements.netProfit)}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">إجمالي الأصول</span><span className="font-medium text-foreground">{fmtMoney(overview.financials.statements.totalAssets)}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">إجمالي الخصوم</span><span className="font-medium text-foreground">{fmtMoney(overview.financials.statements.totalLiabilities)}</span></div>
                            <div className="flex justify-between border-t border-border pt-1.5"><span className="font-medium text-foreground">حقوق الملكية</span><span className="font-bold text-foreground">{fmtMoney(overview.financials.statements.totalEquity)}</span></div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* ── Section: Expenses + Collections ── */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="bg-card border border-border rounded-lg p-5">
                        <h2 className="font-semibold text-sm text-foreground flex items-center gap-2 mb-4">
                          <Calculator size={16} className="text-primary" />
                          المصروفات التشغيلية
                        </h2>
                        <div className="mb-3 p-3 bg-muted/40 rounded-lg flex justify-between items-center">
                          <span className="text-xs text-muted-foreground">إجمالي المصروفات</span>
                          <span className="text-xl font-bold text-foreground">{fmtMoney(overview.financials.expenses.grandTotal)}</span>
                        </div>
                        {overview.financials.expenses.byCategory.length > 0 ? (
                          <div className="space-y-2">
                            {overview.financials.expenses.byCategory
                              .sort((a, b) => b.total - a.total)
                              .map((c) => (
                                <div key={c.category} className="flex justify-between items-center text-xs">
                                  <span className="text-muted-foreground">{c.category}</span>
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-muted-foreground/70">({c.count})</span>
                                    <span className="font-medium text-foreground">{fmtMoney(c.total)}</span>
                                  </div>
                                </div>
                              ))}
                          </div>
                        ) : (
                          <p className="text-center text-muted-foreground text-sm py-6">لا توجد مصروفات</p>
                        )}
                      </div>

                      <div className="bg-card border border-border rounded-lg p-5">
                        <h2 className="font-semibold text-sm text-foreground flex items-center gap-2 mb-4">
                          <Banknote size={16} className="text-primary" />
                          تحصيل مستحقات العملاء
                        </h2>
                        <div className="grid grid-cols-2 gap-3 mb-3">
                          <div className="p-3 bg-muted/40 rounded-lg text-center">
                            <p className="text-lg font-bold text-foreground">{fmtMoney(overview.financials.collections.totalReceivable)}</p>
                            <p className="text-[11px] text-muted-foreground">إجمالي المستحقات</p>
                          </div>
                          <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg text-center">
                            <p className="text-lg font-bold text-emerald-600">{fmtMoney(overview.financials.collections.totalCollected)}</p>
                            <p className="text-[11px] text-muted-foreground">تم تحصيله</p>
                          </div>
                        </div>
                        <div className="space-y-2 text-xs">
                          <div className="flex justify-between p-2 bg-amber-50 dark:bg-amber-950/30 rounded">
                            <span className="text-amber-700 dark:text-amber-400">مستحقات قيد التحصيل</span>
                            <span className="font-bold text-amber-600">{overview.financials.collections.outstandingCount}</span>
                          </div>
                          <div className="flex justify-between p-2 bg-muted/40 rounded">
                            <span className="text-muted-foreground">نسبة التحصيل</span>
                            <span className="font-bold text-foreground">
                              {(overview.financials.collections.totalReceivable ?? 0) > 0
                                ? Math.round(((overview.financials.collections.totalCollected ?? 0) / (overview.financials.collections.totalReceivable ?? 1)) * 100)
                                : 0}%
                            </span>
                          </div>
                          <div className="flex justify-between p-2 bg-muted/40 rounded">
                            <span className="text-muted-foreground">المتبقي للتحصيل</span>
                            <span className="font-bold text-foreground">{fmtMoney((overview.financials.collections.totalReceivable ?? 0) - (overview.financials.collections.totalCollected ?? 0))}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* ── Section: Monthly Trend (12 months) ── */}
                    {overview.monthlyTrend.length > 0 && (
                      <div className="bg-card border border-border rounded-lg p-5">
                        <h2 className="font-semibold text-sm text-foreground flex items-center gap-2 mb-4">
                          <TrendingUp size={16} className="text-primary" />
                          الاتجاه الشهري (آخر 12 شهر)
                        </h2>
                        <ResponsiveContainer width="100%" height={300}>
                          <LineChart data={overview.monthlyTrend.map((m) => ({ ...m, month: fmtMonth(m.month) }))}>
                            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                            <XAxis dataKey="month" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                            <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} allowDecimals={false} />
                            <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                            <Legend />
                            <Line type="monotone" dataKey="rfqs" name="طلبات تسعير الموردين" stroke="#1e3a5f" strokeWidth={2.5} dot={{ r: 3 }} />
                            <Line type="monotone" dataKey="customerRfqs" name="طلبات تسعير العملاء" stroke="#8b5cf6" strokeWidth={2.5} dot={{ r: 3 }} />
                            <Line type="monotone" dataKey="pos" name="أوامر الشراء" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3 }} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    )}

                    {/* ── Section: Recent Activity ── */}
                    {overview.recentActivity.length > 0 && (
                      <div className="bg-card border border-border rounded-lg p-5">
                        <h2 className="font-semibold text-sm text-foreground flex items-center gap-2 mb-4">
                          <Activity size={16} className="text-primary" />
                          أحدث النشاطات
                        </h2>
                        <div className="space-y-2 max-h-80 overflow-y-auto">
                          {overview.recentActivity.map((a) => (
                            <div key={a.id} className="flex items-start gap-3 p-2.5 bg-muted/30 rounded-lg text-xs">
                              <div className="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-foreground font-medium truncate">{a.description}</p>
                                <div className="flex items-center gap-2 mt-0.5 text-muted-foreground">
                                  {a.employeeName && <span>{a.employeeName}</span>}
                                  <span>·</span>
                                  <span>{timeAgo(a.createdAt)}</span>
                                </div>
                              </div>
                              <span className="text-[10px] text-muted-foreground/70 shrink-0 font-mono">{a.action}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}

                {/* ══════════════ PROCUREMENT EMPLOYEE PERFORMANCE ══════════════ */}
                <ProcurementPerformanceSection />

                {/* ══════════════ DATA-ENTRY OPERATOR PERFORMANCE ══════════════ */}
                <DataEntryPerformanceSection />
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

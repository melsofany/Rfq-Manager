import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import {
  Search,
  TrendingDown,
  TrendingUp,
  Minus,
  Package,
  ExternalLink,
  Tag,
  Users,
  CalendarClock,
  Layers,
  ArrowRight,
  AlertTriangle,
  RefreshCw,
  History,
  BadgePercent,
  FileCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

// ─── Types (mirrors modules/rfq/item-analysis.ts) ────────────────────────────

interface PriceStats {
  pricedCount: number;
  zeroPriceCount: number;
  firstPriceNet: number | null;
  lastPriceNet: number | null;
  minPriceNet: number | null;
  maxPriceNet: number | null;
  avgPriceNet: number | null;
  medianPriceNet: number | null;
  lastPrice: number | null;
  lastPriceDate: string | null;
  lastSupplierName: string | null;
  changePct: number | null;
  direction: "up" | "down" | "flat" | "insufficient";
  series: Array<{ month: string; avgPriceNet: number; count: number }>;
}

interface AnalysisListItem extends PriceStats {
  key: string;
  partNos: string[];
  lineItems: string[];
  description: string;
  uom: string | null;
  categoryName: string | null;
  requestCount: number;
  supplierRfqCount: number;
  totalQty: number;
  lastRequestedAt: string | null;
  supplierCount: number;
  poIssuedCount: number;
}

interface PricePoint {
  rfqItemId: number | null;
  date: string | null;
  supplierId: number | null;
  supplierName: string;
  price: number;
  priceNet: number;
  taxIncluded: boolean;
  rfqId: number | null;
  internalRfqNo: string | null;
  customerRfqNo: string | null;
  employeeId: number | null;
  employeeName: string | null;
  isApproved: boolean;
  /** The supplier order(s) issued for this quote — empty when none, or when cancelled. */
  poNos: string[];
}

interface SupplierSummary {
  supplierId: number | null;
  supplierName: string;
  quotedCount: number;
  minPriceNet: number | null;
  lastPriceNet: number | null;
  avgPriceNet: number | null;
  lastDate: string | null;
}

interface RequestRow {
  customerRfqItemId: number | null;
  customerRfqId: number | null;
  customerRfqNo: string | null;
  internalNo: string | null;
  customerName: string | null;
  qty: number | null;
  uom: string | null;
  date: string | null;
  partNo: string | null;
  lineItem: string | null;
}

interface AnalysisDetail {
  key: string;
  partNos: string[];
  lineItems: string[];
  description: string;
  uom: string | null;
  categoryName: string | null;
  requestCount: number;
  supplierRfqCount: number;
  totalQty: number;
  lastRequestedAt: string | null;
  vatRate: number;
  stats: PriceStats;
  suppliers: SupplierSummary[];
  priceHistory: PricePoint[];
  requests: RequestRow[];
  poSummary: { quotedWithPo: number; poNumbers: string[] };
  truncated: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmtMonth(m: string) {
  const [y, mo] = m.split("-");
  const names = [
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
  const idx = Number(mo) - 1;
  return idx >= 0 && idx < 12 ? `${names[idx]} ${y}` : m;
}

function fmtQty(v: number | null | undefined) {
  if (v == null) return "—";
  return String(Math.round(v * 10000) / 10000);
}

const DIRECTION: Record<
  PriceStats["direction"],
  { label: string; cls: string; Icon: typeof TrendingUp }
> = {
  up: { label: "ارتفاع", cls: "bg-red-50 text-red-700 border-red-200", Icon: TrendingUp },
  down: {
    label: "انخفاض",
    cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
    Icon: TrendingDown,
  },
  flat: { label: "مستقر", cls: "bg-slate-50 text-slate-700 border-slate-200", Icon: Minus },
  insufficient: {
    label: "بيانات غير كافية",
    cls: "bg-amber-50 text-amber-700 border-amber-200",
    Icon: AlertTriangle,
  },
};

function DirectionBadge({ stats }: { stats: PriceStats }) {
  const d = DIRECTION[stats.direction];
  const { Icon } = d;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        d.cls,
      )}
      title={
        stats.direction === "insufficient"
          ? `أقل من 3 أسعار مسجَّلة (${stats.pricedCount}) — لا يمكن تحديد اتجاه`
          : `تغيّر ${stats.changePct}% بين النصف الأول والأحدث`
      }
    >
      <Icon size={12} />
      {d.label}
      {stats.changePct != null && stats.direction !== "insufficient" && (
        <span className="font-mono">
          {stats.changePct > 0 ? "+" : ""}
          {stats.changePct}%
        </span>
      )}
    </span>
  );
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// ─── Item row (the picker list) ──────────────────────────────────────────────

function ItemRow({
  item,
  active,
  onSelect,
}: {
  item: AnalysisListItem;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full text-right rounded-lg border p-3 transition-colors",
        active
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:bg-muted/40 hover:border-primary/40",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5 mb-1">
        {item.partNos.slice(0, 2).map((pn) => (
          <span
            key={pn}
            className="text-[11px] font-mono bg-primary/10 text-primary rounded px-1.5 py-0.5"
          >
            {pn}
          </span>
        ))}
        {item.lineItems.slice(0, 1).map((li) => (
          <span
            key={li}
            className="text-[11px] font-mono bg-muted text-muted-foreground rounded px-1.5 py-0.5"
            dir="ltr"
          >
            {li}
          </span>
        ))}
        {item.categoryName && (
          <span className="text-[11px] bg-violet-50 text-violet-700 rounded px-1.5 py-0.5">
            {item.categoryName}
          </span>
        )}
      </div>
      <p className="text-sm font-medium text-foreground leading-snug line-clamp-2">
        {item.description || "—"}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Layers size={11} /> طُلب {item.requestCount} مرة
        </span>
        <span className="inline-flex items-center gap-1">
          <Users size={11} /> {item.supplierCount} مورد
        </span>
        <span className="inline-flex items-center gap-1">
          <BadgePercent size={11} /> {item.pricedCount} سعر
        </span>
        {item.poIssuedCount > 0 && (
          <span className="inline-flex items-center gap-1 text-emerald-700">
            <FileCheck size={11} /> {item.poIssuedCount} أمر توريد
          </span>
        )}
        {item.lastRequestedAt && (
          <span className="inline-flex items-center gap-1">
            <CalendarClock size={11} /> {fmtDate(item.lastRequestedAt)}
          </span>
        )}
      </div>
      {item.pricedCount > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[11px]">
          <span className="text-emerald-600 font-mono">أدنى {fmtMoney(item.minPriceNet)}</span>
          <span className="text-blue-600 font-mono">متوسط {fmtMoney(item.avgPriceNet)}</span>
          {item.lastPriceNet != null && (
            <span className="text-foreground font-mono">آخر {fmtMoney(item.lastPriceNet)}</span>
          )}
          <DirectionBadge stats={item} />
        </div>
      )}
    </button>
  );
}

// ─── Detail panel ────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  tone = "default",
  hint,
}: {
  label: string;
  value: string;
  tone?: "default" | "green" | "red" | "blue" | "amber";
  hint?: string;
}) {
  const tones: Record<string, string> = {
    default: "border-border bg-card",
    green: "border-emerald-200 bg-emerald-50/60",
    red: "border-red-200 bg-red-50/60",
    blue: "border-blue-200 bg-blue-50/60",
    amber: "border-amber-200 bg-amber-50/60",
  };
  return (
    <div className={cn("rounded-lg border p-3", tones[tone])}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-lg font-bold text-foreground font-mono" dir="ltr">
        {value}
      </p>
      {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

function DetailPanel({ detail, loading }: { detail: AnalysisDetail | null; loading: boolean }) {
  const [onlyPriced, setOnlyPriced] = useState(true);

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-28 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="py-16 text-center text-muted-foreground border border-dashed border-border rounded-lg">
        <Package size={32} className="mx-auto mb-3 opacity-25" />
        <p className="text-sm font-medium">اختر بندًا من القائمة لعرض التحليل الكامل</p>
        <p className="text-xs mt-1">الاتجاه السعري · كل مرة تم تسعيره · المورد والموظف المسؤول</p>
      </div>
    );
  }

  const s = detail.stats;
  const history = onlyPriced ? detail.priceHistory.filter((p) => p.price > 0) : detail.priceHistory;
  const chartData = s.series.map((p) => ({ ...p, label: fmtMonth(p.month) }));

  return (
    <div className="space-y-4">
      {/* Identity header */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
              {detail.partNos.map((pn) => (
                <span
                  key={pn}
                  className="text-xs font-mono bg-primary/10 text-primary rounded px-2 py-0.5"
                >
                  {pn}
                </span>
              ))}
              {detail.lineItems.slice(0, 2).map((li) => (
                <span
                  key={li}
                  className="text-xs font-mono bg-muted text-muted-foreground rounded px-2 py-0.5"
                  dir="ltr"
                >
                  {li}
                </span>
              ))}
              {detail.categoryName && (
                <span className="text-xs bg-violet-50 text-violet-700 rounded px-2 py-0.5 inline-flex items-center gap-1">
                  <Tag size={11} /> {detail.categoryName}
                </span>
              )}
            </div>
            <p className="text-sm font-semibold text-foreground leading-snug">
              {detail.description || "—"}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
              <span>
                الوحدة: <span className="font-medium text-foreground">{detail.uom ?? "—"}</span>
              </span>
              <span>
                إجمالي الكميات:{" "}
                <span className="font-medium text-foreground font-mono">
                  {fmtQty(detail.totalQty)}
                </span>
              </span>
              <span>
                طُلب في <span className="font-medium text-foreground">{detail.requestCount}</span>{" "}
                طلب عميل
              </span>
              <span>
                أُرسل في{" "}
                <span className="font-medium text-foreground">{detail.supplierRfqCount}</span> طلب
                تسعير
              </span>
              {detail.lastRequestedAt && <span>آخر طلب: {fmtDate(detail.lastRequestedAt)}</span>}
            </div>
          </div>
          <DirectionBadge stats={s} />
        </div>
        {detail.truncated && (
          <p className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 inline-flex items-center gap-1">
            <AlertTriangle size={12} /> تم بلوغ الحد الأقصى للقراءة — النتيجة قد لا تشمل كل السجلات.
          </p>
        )}
      </div>

      {/* Price statistics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2">
        <StatCard
          label="آخر سعر (صافي)"
          value={fmtMoney(s.lastPriceNet)}
          tone="blue"
          hint={s.lastSupplierName ?? undefined}
        />
        <StatCard label="أدنى سعر" value={fmtMoney(s.minPriceNet)} tone="green" />
        <StatCard label="أعلى سعر" value={fmtMoney(s.maxPriceNet)} tone="red" />
        <StatCard label="المتوسط" value={fmtMoney(s.avgPriceNet)} />
        <StatCard label="الوسيط" value={fmtMoney(s.medianPriceNet)} />
        <StatCard
          label="عدد الأسعار"
          value={String(s.pricedCount)}
          hint={s.zeroPriceCount > 0 ? `+ ${s.zeroPriceCount} عرض بدون سعر` : "بدون عروض فارغة"}
        />
        <StatCard
          label="أسعار صدر لها أمر توريد"
          value={String(detail.poSummary?.quotedWithPo ?? 0)}
          tone="green"
          hint={
            detail.poSummary?.poNumbers?.length
              ? `${detail.poSummary.poNumbers.length} أمر توريد`
              : "لا يوجد أمر توريد صادر"
          }
        />
      </div>
      <p className="text-[11px] text-muted-foreground -mt-2">
        كل الأسعار محسوبة <span className="font-medium">صافي بدون ض.ق.م</span> (نسبة الضريبة{" "}
        {detail.vatRate}%) حتى تكون المقارنة صحيحة بين عرض شامل الضريبة وعرض غير شامل.
      </p>

      {/* Trend chart */}
      {chartData.length >= 1 ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="font-semibold text-sm text-foreground flex items-center gap-2 mb-3">
            <TrendingUp size={15} className="text-primary" />
            الاتجاه السعري الشهري (صافي)
          </h3>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} width={80} />
              <Tooltip
                formatter={(v: number) => [fmtMoney(v), "متوسط السعر"]}
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
                dataKey="avgPriceNet"
                name="متوسط السعر الشهري"
                stroke="#1e3a5f"
                strokeWidth={2.5}
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
          {s.direction === "insufficient" && (
            <p className="text-[11px] text-amber-700 mt-2">
              عدد الأسعار المسجَّلة أقل من 3 — يُعرض الرسم للاطلاع فقط بدون حكم على الاتجاه.
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground text-sm">
          لا توجد أسعار مسجَّلة لهذا البند بعد — لا يمكن رسم اتجاه سعري.
        </div>
      )}

      {/* Per-supplier breakdown */}
      {detail.suppliers.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <h3 className="font-semibold text-sm text-foreground flex items-center gap-2 px-4 py-3 border-b border-border">
            <Users size={15} className="text-primary" />
            ملخص الموردين ({detail.suppliers.length})
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="text-right font-medium px-3 py-2">المورد</th>
                  <th className="text-center font-medium px-3 py-2">عدد التسعيرات</th>
                  <th className="text-center font-medium px-3 py-2">أدنى سعر</th>
                  <th className="text-center font-medium px-3 py-2">المتوسط</th>
                  <th className="text-center font-medium px-3 py-2">آخر سعر</th>
                  <th className="text-center font-medium px-3 py-2">آخر تاريخ</th>
                </tr>
              </thead>
              <tbody>
                {detail.suppliers.map((sup, i) => (
                  <tr
                    key={`${sup.supplierId}-${i}`}
                    className="border-b border-border/50 last:border-0"
                  >
                    <td className="px-3 py-2 text-foreground font-medium">{sup.supplierName}</td>
                    <td className="px-3 py-2 text-center font-mono">{sup.quotedCount}</td>
                    <td className="px-3 py-2 text-center font-mono text-emerald-600">
                      {fmtMoney(sup.minPriceNet)}
                    </td>
                    <td className="px-3 py-2 text-center font-mono">{fmtMoney(sup.avgPriceNet)}</td>
                    <td className="px-3 py-2 text-center font-mono">
                      {fmtMoney(sup.lastPriceNet)}
                    </td>
                    <td className="px-3 py-2 text-center text-muted-foreground">
                      {fmtDate(sup.lastDate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Every priced quote */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
            <History size={15} className="text-primary" />
            كل مرة تم تسعير البند ({history.length})
          </h3>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOnlyPriced((v) => !v)}
            className="text-[11px] h-7"
          >
            {onlyPriced ? "إظهار العروض بدون سعر" : "إخفاء العروض بدون سعر"}
          </Button>
        </div>
        {history.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">لا توجد تسعيرات مسجَّلة.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[820px]">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="text-right font-medium px-3 py-2">التاريخ</th>
                  <th className="text-right font-medium px-3 py-2">المورد</th>
                  <th className="text-center font-medium px-3 py-2">السعر (كما ورد)</th>
                  <th className="text-center font-medium px-3 py-2">صافي بدون ض.ق.م</th>
                  <th className="text-center font-medium px-3 py-2">الضريبة</th>
                  <th className="text-center font-medium px-3 py-2">أمر التوريد للمورد</th>
                  <th className="text-right font-medium px-3 py-2">الموظف المسؤول</th>
                  <th className="text-right font-medium px-3 py-2">طلب التسعير</th>
                </tr>
              </thead>
              <tbody>
                {history.map((p, i) => (
                  <tr
                    key={`${p.rfqItemId}-${i}`}
                    className={cn(
                      "border-b border-border/50 last:border-0",
                      p.price === 0 && "bg-muted/30",
                      p.isApproved && "bg-emerald-50/60",
                    )}
                  >
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {fmtDate(p.date)}
                    </td>
                    <td className="px-3 py-2 text-foreground font-medium">
                      {p.supplierName || "—"}
                      {p.isApproved && (
                        <span className="ml-1 text-[10px] bg-emerald-100 text-emerald-700 rounded px-1">
                          معتمد
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center font-mono" dir="ltr">
                      {p.price === 0 ? (
                        <span className="text-muted-foreground">بدون سعر</span>
                      ) : (
                        fmtMoney(p.price)
                      )}
                    </td>
                    <td className="px-3 py-2 text-center font-mono font-semibold" dir="ltr">
                      {p.price === 0 ? "—" : fmtMoney(p.priceNet)}
                    </td>
                    <td className="px-3 py-2 text-center text-muted-foreground">
                      {p.taxIncluded ? "شامل" : "غير شامل"}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {p.poNos.length === 0 ? (
                        <span className="text-muted-foreground">لم يصدر</span>
                      ) : (
                        <span className="inline-flex flex-wrap justify-center gap-1">
                          {p.poNos.map((po) => (
                            <Link key={po} href={`/purchase-orders?q=${encodeURIComponent(po)}`}>
                              <a className="inline-flex items-center gap-1 font-mono font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5 hover:bg-emerald-100">
                                {po}
                                <ExternalLink size={9} />
                              </a>
                            </Link>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-foreground">{p.employeeName ?? "—"}</td>
                    <td className="px-3 py-2">
                      {p.rfqId != null ? (
                        <Link href={`/rfq/${p.rfqId}`}>
                          <a className="inline-flex items-center gap-1 text-primary hover:underline font-medium">
                            {p.internalRfqNo ?? `#${p.rfqId}`}
                            <ExternalLink size={10} />
                          </a>
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Requests */}
      {detail.requests.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <h3 className="font-semibold text-sm text-foreground flex items-center gap-2 px-4 py-3 border-b border-border">
            <Layers size={15} className="text-primary" />
            طلبات العملاء التي تضمّنت البند ({detail.requests.length})
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="text-right font-medium px-3 py-2">التاريخ</th>
                  <th className="text-right font-medium px-3 py-2">رقم الطلب</th>
                  <th className="text-right font-medium px-3 py-2">العميل</th>
                  <th className="text-center font-medium px-3 py-2">الكمية</th>
                  <th className="text-center font-medium px-3 py-2">الوحدة</th>
                </tr>
              </thead>
              <tbody>
                {detail.requests.map((r, i) => (
                  <tr
                    key={`${r.customerRfqItemId}-${i}`}
                    className="border-b border-border/50 last:border-0"
                  >
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {fmtDate(r.date)}
                    </td>
                    <td className="px-3 py-2">
                      {r.customerRfqId != null ? (
                        <Link href={`/customer-rfq/${r.customerRfqId}`}>
                          <a className="inline-flex items-center gap-1 text-primary hover:underline font-medium">
                            {r.customerRfqNo ?? r.internalNo ?? `#${r.customerRfqId}`}
                            <ExternalLink size={10} />
                          </a>
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">{r.customerRfqNo ?? "—"}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-foreground">{r.customerName ?? "—"}</td>
                    <td className="px-3 py-2 text-center font-mono">{fmtQty(r.qty)}</td>
                    <td className="px-3 py-2 text-center text-muted-foreground">{r.uom ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tab ─────────────────────────────────────────────────────────────────────

/**
 * «تحليل البنود والاتجاه السعري» — the new Items tab.
 *
 * Search by description / part number / line item, pick the item, then read its
 * full analysis: price statistics, the monthly trend, every quote with the
 * supplier and the responsible employee, and the customer requests it appeared
 * on. Results are grouped by ITEM (identity), not by RFQ line, so one article
 * quoted ten times is one row with one price history.
 */
export function ItemAnalysisTab() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [items, setItems] = useState<AnalysisListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<AnalysisDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const runSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) return;
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`/api/items/analysis/search?q=${encodeURIComponent(q.trim())}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as {
        items: AnalysisListItem[];
        total: number;
        truncated: boolean;
      };
      setItems(body.items ?? []);
      setTotal(body.total ?? 0);
      setTruncated(!!body.truncated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل البحث");
      setItems([]);
      setTotal(0);
    } finally {
      setSearching(false);
    }
  }, []);

  const openItem = useCallback(async (key: string) => {
    setSelectedKey(key);
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await fetch(`/api/items/analysis/item?key=${encodeURIComponent(key)}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      setDetail((await res.json()) as AnalysisDetail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل تحميل التحليل");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    setSubmitted(q);
    setSelectedKey(null);
    setDetail(null);
    void runSearch(q);
  };

  // Deep link: `/items?tab=analysis&q=…` opens straight on a search.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    if (q && q.trim().length >= 2) {
      setQuery(q);
      setSubmitted(q);
      void runSearch(q);
    }
  }, [runSearch]);

  const statsLine = useMemo(() => {
    if (!submitted) return null;
    return `عدد البنود المطابقة: ${total}${truncated ? " (قد تكون النتيجة مقتطعة)" : ""}`;
  }, [submitted, total, truncated]);

  return (
    <div className="space-y-4">
      {/* Search form */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="relative flex-1">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث بالوصف أو رقم القطعة (Part No) أو رقم البند (Line Item)…"
            className="pl-9"
          />
        </div>
        <Button type="submit" disabled={query.trim().length < 2 || searching}>
          {searching ? "جارٍ البحث…" : "بحث"}
        </Button>
        {submitted && (
          <Button
            type="button"
            variant="outline"
            onClick={() => void runSearch(submitted)}
            disabled={searching}
            title="إعادة تحميل النتائج"
          >
            <RefreshCw size={14} className={cn(searching && "animate-spin")} />
          </Button>
        )}
      </form>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {!submitted ? (
        <div className="py-16 text-center text-muted-foreground">
          <Search size={36} className="mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium">اكتب حرفين على الأقل للبحث</p>
          <p className="text-xs mt-1">
            يمكنك البحث بالوصف أو رقم القطعة أو رقم البند، ثم اختيار البند لعرض التحليل الكامل.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] gap-4 items-start">
          {/* Picker list */}
          <div className="space-y-2">
            {statsLine && <p className="text-xs text-muted-foreground">{statsLine}</p>}
            {searching && (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />
                ))}
              </div>
            )}
            {!searching && items.length === 0 && (
              <div className="py-10 text-center text-muted-foreground border border-dashed border-border rounded-lg">
                <Package size={28} className="mx-auto mb-2 opacity-25" />
                <p className="text-sm">لا توجد بنود مطابقة</p>
              </div>
            )}
            {!searching &&
              items.map((it) => (
                <ItemRow
                  key={it.key}
                  item={it}
                  active={it.key === selectedKey}
                  onSelect={() => void openItem(it.key)}
                />
              ))}
            {!searching && total > items.length && (
              <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                <ArrowRight size={11} /> يتم عرض أول {items.length} من {total} بند — ضيّق البحث
                لرؤية الباقي.
              </p>
            )}
          </div>

          {/* Detail */}
          <DetailPanel detail={detail} loading={detailLoading} />
        </div>
      )}
    </div>
  );
}

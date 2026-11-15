import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, CalendarClock, RefreshCw, Users, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  asUrgency,
  progressPct,
  URGENCY_ROW_ACCENT,
  URGENCY_STYLES,
  type OpenUrgency,
} from "./open-requests-presentation";

// The endpoint is not in the OpenAPI spec, so it is called with a plain fetch —
// the same pattern the receipts/deliveries/accounts screens use.
type OpenRequestAssignee = {
  employeeId: number;
  employeeName: string | null;
  itemCount: number;
};

type OpenRequestRow = {
  id: number;
  internalNo: string;
  customerRfqNo: string;
  customerName: string;
  entryDate: string | null;
  expiryDate: string | null;
  buyerName: string | null;
  employeeName: string | null;
  status: string;
  itemCount: number;
  /** Live items with no customer PO yet — the part «نجح %» cannot see. */
  unorderedItems: number;
  remainingDays: number | null;
  /** True when the close date has PASSED — no quote can be submitted any more. */
  closePassed: boolean;
  closePassedLabel: string | null;
  urgency: string;
  remainingLabel: string;
  requestStatus: {
    stage: string;
    label: string;
    deliveredPct: number | null;
    customerPricingPct: number | null;
  };
  assignees: OpenRequestAssignee[];
  assignedItemCount: number;
  unassignedItemCount: number;
};

type OpenRequestsResponse = {
  rows: OpenRequestRow[];
  totals: {
    count: number;
    overdue: number;
    today: number;
    soon: number;
    unassignedItems: number;
    items: number;
  };
  window: {
    days: number;
    includeUndated: boolean;
    includeOverdue: boolean;
    from: string;
    to: string;
    today: string;
    olderNotShown: number;
    /** Overdue requests left out because «إظهار المتأخرة» is off. */
    hiddenOverdue: number;
  };
};

const WINDOW_CHOICES = [7, 30, 90, 180, 365] as const;

/**
 * «الطلبات المفتوحة» — the requests that still owe work, how long is left before
 * their close date, and the employees responsible for their items.
 *
 * Rendered as a tab inside the customer-RFQ page, which already supplies
 * `<Layout>` — wrapping it again would nest a second sidebar.
 */
export function OpenRequestsTab() {
  const [, navigate] = useLocation();
  const [data, setData] = useState<OpenRequestsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number>(30);
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  // Off by default: a passed close date means no quote can be submitted, so
  // those requests are history rather than outstanding work.
  const [includeOverdue, setIncludeOverdue] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ days: String(days) });
      if (onlyUnassigned) params.set("onlyUnassigned", "true");
      if (includeOverdue) params.set("includeOverdue", "true");
      const res = await fetch(`/api/customer-rfq/open-requests?${params.toString()}`, {
        credentials: "include",
      });
      const body = (await res.json().catch(() => ({}))) as OpenRequestsResponse & {
        error?: string;
      };
      if (!res.ok) throw new Error(body.error || "فشل تحميل الطلبات المفتوحة");
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل تحميل الطلبات المفتوحة");
    } finally {
      setLoading(false);
    }
  }, [days, onlyUnassigned, includeOverdue]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = data?.totals;

  return (
    <div className="space-y-4">
      {/* Summary cards — the operator's first question is "how bad is it?" */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <SummaryCard
          label="طلبات مفتوحة"
          value={totals?.count ?? 0}
          tone="bg-slate-50 dark:bg-slate-900/40 text-slate-700 dark:text-slate-200"
          icon={<CalendarClock size={16} />}
        />
        <SummaryCard
          label="متأخرة عن الإغلاق"
          value={totals?.overdue ?? 0}
          tone="bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300"
          icon={<AlertTriangle size={16} />}
        />
        <SummaryCard
          label="تُغلق اليوم"
          value={totals?.today ?? 0}
          tone="bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-300"
          icon={<AlertTriangle size={16} />}
        />
        <SummaryCard
          label="تُغلق قريبًا"
          value={totals?.soon ?? 0}
          tone="bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300"
          icon={<CalendarClock size={16} />}
        />
        <SummaryCard
          label="بنود بلا مسؤول"
          value={totals?.unassignedItems ?? 0}
          tone="bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300"
          icon={<UserX size={16} />}
        />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">نطاق الإغلاق:</span>
        {WINDOW_CHOICES.map((d) => (
          <Button
            key={d}
            size="sm"
            variant={days === d ? "default" : "outline"}
            className="h-7 px-2.5 text-xs"
            onClick={() => setDays(d)}
          >
            {d === 365 ? "سنة" : `${d} يوم`}
          </Button>
        ))}
        <Button
          size="sm"
          variant={onlyUnassigned ? "default" : "outline"}
          className="h-7 px-2.5 text-xs gap-1"
          onClick={() => setOnlyUnassigned((v) => !v)}
          title="إظهار الطلبات التي بها بنود بلا مسؤول فقط"
        >
          <UserX size={13} /> بلا مسؤول فقط
        </Button>
        <Button
          size="sm"
          variant={includeOverdue ? "default" : "outline"}
          className="h-7 px-2.5 text-xs gap-1"
          onClick={() => setIncludeOverdue((v) => !v)}
          title="إظهار الطلبات التي انتهى موعد إغلاقها (لا يمكن تقديم عرض سعر بها)"
        >
          <AlertTriangle size={13} /> إظهار المنتهية
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2.5 text-xs gap-1"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin")} /> تحديث
        </Button>
        {data?.window && (
          <span className="text-[11px] text-muted-foreground mr-auto" dir="ltr">
            {data.window.from} → {data.window.to}
          </span>
        )}
      </div>

      {/* A bounded list must say so, or it reads as the whole set. */}
      {!loading && !error && (data?.window.hiddenOverdue ?? 0) > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 px-3 py-2 text-[12px] text-red-800 dark:text-red-300">
          {data?.window.hiddenOverdue} طلب انتهى موعد إغلاقه وغير معروض (لا يمكن تقديم عرض سعر به) —
          اضغط «إظهار المنتهية» لعرضه.
        </div>
      )}
      {!loading && !error && (data?.window.olderNotShown ?? 0) > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
          هناك {data?.window.olderNotShown} طلب يُغلق قبل بداية هذا النطاق وغير معروض هنا — وسّع
          النطاق لعرضه.
        </div>
      )}

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
        ) : error ? (
          <div className="p-8 text-center text-red-600 text-sm">{error}</div>
        ) : !data?.rows.length ? (
          <div className="p-12 text-center">
            <CalendarClock size={40} className="mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-muted-foreground text-sm">
              لا توجد طلبات مفتوحة داخل هذا النطاق الزمني
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/30 border-b border-border text-right">
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                    الرقم الداخلي
                  </th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">العميل</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                    رقم طلب العميل
                  </th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                    تاريخ الإغلاق
                  </th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                    المتبقي للإغلاق
                  </th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">
                    البنود
                  </th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                    الموظفون المسند إليهم
                  </th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                    حالة الطلب
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const urgency: OpenUrgency = asUrgency(r.urgency);
                  return (
                    <tr
                      key={r.id}
                      className={cn(
                        "border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer",
                        URGENCY_ROW_ACCENT[urgency],
                      )}
                      onClick={() => navigate(`/customer-rfq/${r.id}`)}
                    >
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-primary font-medium">
                          {r.internalNo}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-foreground text-xs">{r.customerName}</td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-foreground">{r.customerRfqNo}</span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs" dir="ltr">
                        {r.expiryDate ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium",
                            URGENCY_STYLES[urgency],
                          )}
                        >
                          <CalendarClock size={12} />
                          {r.remainingLabel}
                        </span>
                        {/* A passed close date is terminal for quoting — say it in
                            words, because a negative countdown alone reads as
                            «still workable, just late». */}
                        {r.closePassed && (
                          <div className="text-[10px] font-medium text-red-700 dark:text-red-400 mt-0.5">
                            {r.closePassedLabel ?? "انتهى موعد الإغلاق"} — لا يمكن تقديم عرض
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex items-center justify-center min-w-6 h-6 px-1.5 bg-muted rounded text-xs font-medium text-foreground">
                          {r.itemCount}
                        </span>
                        {r.unorderedItems > 0 && (
                          <div
                            className="text-[10px] text-amber-700 dark:text-amber-400 mt-0.5"
                            title="بنود لم يصدر لها أمر شراء بعد"
                          >
                            {r.unorderedItems} بلا أمر
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <AssigneeCell row={r} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="space-y-1">
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300">
                            {r.requestStatus.label}
                          </span>
                          {r.requestStatus.deliveredPct != null && (
                            <ProgressBar pct={progressPct(r.requestStatus.deliveredPct)} />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Who the request's items are assigned to. The operator asked to see the
 * employees, so this must show every one of them with their item count — a
 * request whose items are split between two employees must name both, or the
 * row hides half the responsibility.
 */
function AssigneeCell({ row }: { row: OpenRequestRow }) {
  if (row.assignees.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
        <UserX size={12} /> لا يوجد مسؤول
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1 items-center">
      {row.assignees.map((a) => (
        <span
          key={a.employeeId}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-muted text-foreground"
          title={`${a.itemCount} بند`}
        >
          <Users size={11} className="text-muted-foreground" />
          {a.employeeName ?? `#${a.employeeId}`}
          <span className="text-muted-foreground">({a.itemCount})</span>
        </span>
      ))}
      {row.unassignedItemCount > 0 && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
          <UserX size={11} /> {row.unassignedItemCount} بلا مسؤول
        </span>
      )}
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
      <div className="h-full bg-green-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number;
  tone: string;
  icon: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-lg border border-border p-3", tone)}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium opacity-90">
        {icon}
        {label}
      </div>
      <div className="text-xl font-bold mt-1" dir="ltr">
        {value}
      </div>
    </div>
  );
}

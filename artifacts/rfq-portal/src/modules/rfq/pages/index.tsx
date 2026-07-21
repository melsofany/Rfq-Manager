import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useListRfqs, getListRfqsQueryKey } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, FileText, Clock, AlertTriangle, ChevronDown, ChevronUp, Timer } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

const STATUSES = ["all", "DRAFT", "SENT", "QUOTED", "FAILED", "SUCCESS"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClosingSoonRfq {
  id: number;
  internalRfqNo: string;
  customerRfqNo: string;
  status: string;
  expiresAt: string;
  employeeName: string | null;
  supplierCount: number;
  offerCount: number;
}

interface ClosingSoonData {
  today: ClosingSoonRfq[];
  tomorrow: ClosingSoonRfq[];
  dayAfterTomorrow: ClosingSoonRfq[];
}

// ---------------------------------------------------------------------------
// Data hook
// ---------------------------------------------------------------------------

function useClosingSoon() {
  return useQuery<ClosingSoonData>({
    queryKey: ["rfq-closing-soon"],
    queryFn: async () => {
      const res = await fetch("/api/rfq/closing-soon", { credentials: "include" });
      if (!res.ok) throw new Error("closing-soon fetch failed");
      return res.json() as Promise<ClosingSoonData>;
    },
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SAP Fiori-style urgency config per bucket
// ---------------------------------------------------------------------------

const URGENCY = {
  today: {
    label: "اليوم",
    borderColor: "border-l-red-500",
    badgeBg: "bg-red-600",
    sectionBg: "bg-red-50 dark:bg-red-950/30",
    sectionText: "text-red-700 dark:text-red-400",
    sectionBorder: "border-b border-border",
    dot: "bg-red-500",
    icon: <AlertTriangle size={12} className="text-red-600" />,
  },
  tomorrow: {
    label: "غداً",
    borderColor: "border-l-orange-400",
    badgeBg: "bg-orange-500",
    sectionBg: "bg-orange-50 dark:bg-orange-950/20",
    sectionText: "text-orange-700 dark:text-orange-400",
    sectionBorder: "border-b border-border",
    dot: "bg-orange-400",
    icon: <Clock size={12} className="text-orange-500" />,
  },
  dayAfter: {
    label: "بعد غد",
    borderColor: "border-l-yellow-400",
    badgeBg: "bg-yellow-500",
    sectionBg: "bg-yellow-50/60 dark:bg-yellow-950/10",
    sectionText: "text-yellow-700 dark:text-yellow-400",
    sectionBorder: "border-b border-border",
    dot: "bg-yellow-400",
    icon: <Timer size={12} className="text-yellow-600" />,
  },
} as const;

type UrgencyKey = keyof typeof URGENCY;

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function ClosingSoonRow({
  rfq,
  urgency,
  navigate,
}: {
  rfq: ClosingSoonRfq;
  urgency: UrgencyKey;
  navigate: (path: string) => void;
}) {
  const { borderColor } = URGENCY[urgency];
  const time = rfq.expiresAt
    ? new Date(rfq.expiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : "—";

  return (
    <tr
      className={cn(
        "border-b border-border last:border-0 hover:bg-muted/30 cursor-pointer text-xs transition-colors",
        "border-l-2",
        borderColor,
      )}
      onClick={() => navigate(`/rfq/${rfq.id}`)}
    >
      <td className="px-3 py-2.5 font-mono font-semibold text-primary">{rfq.internalRfqNo}</td>
      <td className="px-3 py-2.5 font-mono text-muted-foreground">{rfq.customerRfqNo}</td>
      <td className="px-3 py-2.5 text-muted-foreground">{rfq.employeeName ?? "—"}</td>
      <td className="px-3 py-2.5">
        <StatusBadge status={rfq.status} />
      </td>
      <td className="px-3 py-2.5 text-center">
        <span className="inline-flex items-center justify-center w-6 h-6 bg-blue-50 text-blue-700 rounded text-xs font-medium">
          {rfq.supplierCount}
        </span>
      </td>
      <td className="px-3 py-2.5 text-center">
        <span className="inline-flex items-center justify-center w-6 h-6 bg-green-50 text-green-700 rounded text-xs font-medium">
          {rfq.offerCount}
        </span>
      </td>
      <td className="px-3 py-2.5 text-center tabular-nums font-medium text-foreground">{time}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Section (one bucket: today / tomorrow / dayAfter)
// ---------------------------------------------------------------------------

function ClosingSoonSection({
  rows,
  urgency,
  navigate,
}: {
  rows: ClosingSoonRfq[];
  urgency: UrgencyKey;
  navigate: (path: string) => void;
}) {
  const cfg = URGENCY[urgency];

  return (
    <div>
      {/* SAP-style group header */}
      <div
        className={cn(
          "flex items-center gap-2 px-4 py-1.5",
          cfg.sectionBg,
          cfg.sectionBorder,
        )}
      >
        {cfg.icon}
        <span className={cn("text-xs font-semibold", cfg.sectionText)}>
          {cfg.label}
        </span>
        <span
          className={cn(
            "ml-1 text-[10px] font-bold text-white rounded-full px-1.5 py-0.5 leading-none",
            cfg.badgeBg,
          )}
        >
          {rows.length}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-muted/20 border-b border-border text-left">
              {[
                { label: "رقم الطلب الداخلي", center: false },
                { label: "رقم طلب العميل", center: false },
                { label: "الموظف", center: false },
                { label: "الحالة", center: false },
                { label: "موردون", center: true },
                { label: "عروض", center: true },
                { label: "يغلق الساعة", center: true },
              ].map((h, i) => (
                <th
                  key={i}
                  className={cn(
                    "px-3 py-1.5 text-muted-foreground text-[11px] font-medium uppercase tracking-wide",
                    h.center && "text-center",
                  )}
                >
                  {h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((rfq) => (
              <ClosingSoonRow key={rfq.id} rfq={rfq} urgency={urgency} navigate={navigate} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function ClosingSoonPanel({ navigate }: { navigate: (path: string) => void }) {
  const { isLoading, isError, data } = useClosingSoon();
  const [open, setOpen] = useState(true);

  const today = data?.today ?? [];
  const tomorrow = data?.tomorrow ?? [];
  const dayAfter = data?.dayAfterTomorrow ?? [];
  const totalCount = today.length + tomorrow.length + dayAfter.length;

  function renderBody() {
    if (isLoading) {
      return (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground animate-pulse">
          جارٍ التحميل…
        </div>
      );
    }

    if (isError) {
      return (
        <div className="px-4 py-6 text-center text-sm text-destructive">
          تعذّر تحميل البيانات — يرجى تحديث الصفحة
        </div>
      );
    }

    if (totalCount === 0) {
      return (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          لا توجد طلبات تغلق خلال الأيام الثلاثة القادمة
        </div>
      );
    }

    return (
      <div className="divide-y divide-border">
        {today.length > 0 && (
          <ClosingSoonSection rows={today} urgency="today" navigate={navigate} />
        )}
        {tomorrow.length > 0 && (
          <ClosingSoonSection rows={tomorrow} urgency="tomorrow" navigate={navigate} />
        )}
        {dayAfter.length > 0 && (
          <ClosingSoonSection rows={dayAfter} urgency="dayAfter" navigate={navigate} />
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden shadow-sm">
      {/* ── Panel header — SAP Fiori analytical panel style ── */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left bg-primary hover:bg-primary/90 transition-colors"
      >
        <AlertTriangle size={15} className="text-primary-foreground/80 flex-shrink-0" />
        <span className="text-sm font-semibold text-primary-foreground flex-1">
          طلبات عروض تغلق قريباً
        </span>

        {/* Total badge */}
        {!isLoading && !isError && totalCount > 0 && (
          <span className="text-xs font-bold bg-white/20 text-primary-foreground rounded px-2 py-0.5 border border-white/20">
            {totalCount} طلب
          </span>
        )}

        {/* Urgency indicators */}
        {!isLoading && !isError && totalCount > 0 && (
          <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-primary-foreground/70">
            {today.length > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
                {today.length} اليوم
              </span>
            )}
            {tomorrow.length > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-orange-300 inline-block" />
                {tomorrow.length} غداً
              </span>
            )}
            {dayAfter.length > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-yellow-300 inline-block" />
                {dayAfter.length} بعد غد
              </span>
            )}
          </div>
        )}

        {open ? (
          <ChevronUp size={14} className="text-primary-foreground/70 flex-shrink-0" />
        ) : (
          <ChevronDown size={14} className="text-primary-foreground/70 flex-shrink-0" />
        )}
      </button>

      {open && (
        <div className="border-t border-border">
          {renderBody()}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RfqListPage() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const { t } = useLanguage();

  const { data: rfqs, isLoading } = useListRfqs(
    { status: status !== "all" ? status : undefined, search: search || undefined },
    {
      query: {
        queryKey: getListRfqsQueryKey({
          status: status !== "all" ? status : undefined,
          search: search || undefined,
        }),
      },
    },
  );

  const statusLabel = (s: string) => {
    if (s === "all") return t("rfq.filter.all");
    if (s === "DRAFT") return t("rfq.filter.draft");
    if (s === "SENT") return t("rfq.filter.sent");
    if (s === "QUOTED") return t("rfq.filter.quoted");
    if (s === "FAILED") return t("rfq.filter.failed");
    if (s === "SUCCESS") return t("rfq.filter.success");
    return s;
  };

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">{t("rfq.title")}</h1>
            <p className="text-muted-foreground text-sm">{t("rfq.subtitle")}</p>
          </div>
          <Button
            onClick={() => navigate("/rfq/new")}
            size="sm"
            className="gap-1.5 self-start sm:self-auto"
          >
            <Plus size={15} />
            {t("rfq.new")}
          </Button>
        </div>

        {/* Closing Soon Panel */}
        <ClosingSoonPanel navigate={navigate} />

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search
              size={15}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search RFQ number..."
              className="pl-8 h-8 text-sm"
            />
          </div>
          <div className="flex gap-1 overflow-x-auto pb-0.5 flex-nowrap">
            {STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors flex-shrink-0 ${
                  status === s
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {statusLabel(s)}
              </button>
            ))}
          </div>
        </div>

        {/* RFQ Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading...</div>
          ) : rfqs?.length === 0 ? (
            <div className="p-12 text-center">
              <FileText size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground text-sm">No RFQs found</p>
              <Button onClick={() => navigate("/rfq/new")} size="sm" className="mt-3 gap-1.5">
                <Plus size={14} /> Create first RFQ
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-left">
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                      Internal No.
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                      Customer RFQ
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                      Employee
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">Status</th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">
                      Items
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">
                      Suppliers
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">
                      Offers
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rfqs?.map((rfq) => (
                    <tr
                      key={rfq.id}
                      className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                      onClick={() => navigate(`/rfq/${rfq.id}`)}
                    >
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-primary font-medium">
                          {rfq.internalRfqNo}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-foreground font-mono text-xs">
                        {rfq.customerRfqNo}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {rfq.employeeName ?? "-"}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={rfq.status} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex items-center justify-center w-6 h-6 bg-muted rounded text-xs font-medium text-foreground">
                          {rfq.itemCount}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex items-center justify-center w-6 h-6 bg-blue-50 text-blue-700 rounded text-xs font-medium">
                          {rfq.supplierCount}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex items-center justify-center w-6 h-6 bg-green-50 text-green-700 rounded text-xs font-medium">
                          {rfq.offerCount}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {new Date(rfq.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

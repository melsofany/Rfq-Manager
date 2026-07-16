import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useListRfqs, getListRfqsQueryKey } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, FileText, Clock, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";

const STATUSES = ["all", "DRAFT", "SENT", "QUOTED", "FAILED", "SUCCESS"];

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
  tomorrow: ClosingSoonRfq[];
  dayAfterTomorrow: ClosingSoonRfq[];
}

function useClosingSoon() {
  return useQuery<ClosingSoonData>({
    queryKey: ["rfq-closing-soon"],
    queryFn: async () => {
      const res = await fetch("/api/rfq/closing-soon", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch closing-soon RFQs");
      return res.json();
    },
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });
}

function ClosingSoonRow({ rfq, navigate }: { rfq: ClosingSoonRfq; navigate: (path: string) => void }) {
  const time = new Date(rfq.expiresAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
  return (
    <tr
      className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer text-xs"
      onClick={() => navigate(`/rfq/${rfq.id}`)}
    >
      <td className="px-3 py-2 font-mono font-medium text-primary">{rfq.internalRfqNo}</td>
      <td className="px-3 py-2 font-mono text-muted-foreground">{rfq.customerRfqNo}</td>
      <td className="px-3 py-2 text-muted-foreground">{rfq.employeeName ?? "—"}</td>
      <td className="px-3 py-2"><StatusBadge status={rfq.status} /></td>
      <td className="px-3 py-2 text-center font-medium text-foreground">{rfq.supplierCount}</td>
      <td className="px-3 py-2 text-center font-medium text-green-700">{rfq.offerCount}</td>
      <td className="px-3 py-2 text-center tabular-nums text-muted-foreground">{time}</td>
    </tr>
  );
}

function ClosingSoonPanel({ navigate }: { navigate: (path: string) => void }) {
  const { data, isLoading } = useClosingSoon();
  const [open, setOpen] = useState(true);

  const totalCount = (data?.tomorrow.length ?? 0) + (data?.dayAfterTomorrow.length ?? 0);

  const tableHead = (
    <thead>
      <tr className="bg-muted/20 border-b border-border text-left">
        <th className="px-3 py-2 text-muted-foreground text-xs font-medium">رقم الطلب</th>
        <th className="px-3 py-2 text-muted-foreground text-xs font-medium">رقم العميل</th>
        <th className="px-3 py-2 text-muted-foreground text-xs font-medium">الموظف</th>
        <th className="px-3 py-2 text-muted-foreground text-xs font-medium">الحالة</th>
        <th className="px-3 py-2 text-muted-foreground text-xs font-medium text-center">موردون</th>
        <th className="px-3 py-2 text-muted-foreground text-xs font-medium text-center">عروض</th>
        <th className="px-3 py-2 text-muted-foreground text-xs font-medium text-center">وقت الإغلاق</th>
      </tr>
    </thead>
  );

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 px-4 py-3 text-left hover:bg-amber-100/60 dark:hover:bg-amber-900/20 transition-colors"
      >
        <AlertTriangle size={15} className="text-amber-600 flex-shrink-0" />
        <span className="text-sm font-semibold text-amber-800 dark:text-amber-300 flex-1">
          تقرير الطلبات التي ستغلق قريبًا
        </span>
        {isLoading ? (
          <span className="text-xs text-amber-600 animate-pulse">جاري التحميل...</span>
        ) : (
          <span className="text-xs font-medium bg-amber-600 text-white rounded-full px-2 py-0.5">
            {totalCount} طلب
          </span>
        )}
        {open ? <ChevronUp size={14} className="text-amber-600" /> : <ChevronDown size={14} className="text-amber-600" />}
      </button>

      {open && !isLoading && totalCount === 0 && (
        <div className="border-t border-amber-200 dark:border-amber-800 px-4 py-5 text-center text-sm text-amber-700 dark:text-amber-400">
          لا توجد طلبات ستغلق في اليومين القادمين
        </div>
      )}

      {open && !isLoading && totalCount > 0 && (
        <div className="border-t border-amber-200 dark:border-amber-800">

          {/* Tomorrow */}
          {data && data.tomorrow.length > 0 && (
            <div>
              <div className="flex items-center gap-2 px-4 py-2 bg-red-50 dark:bg-red-950/30 border-b border-amber-200 dark:border-amber-800">
                <Clock size={13} className="text-red-500" />
                <span className="text-xs font-semibold text-red-700 dark:text-red-400">
                  تغلق غدًا ({data.tomorrow.length} طلب)
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  {tableHead}
                  <tbody>
                    {data.tomorrow.map(rfq => (
                      <ClosingSoonRow key={rfq.id} rfq={rfq} navigate={navigate} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Day after tomorrow */}
          {data && data.dayAfterTomorrow.length > 0 && (
            <div className={data.tomorrow.length > 0 ? "border-t border-amber-200 dark:border-amber-800" : ""}>
              <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-800">
                <Clock size={13} className="text-amber-500" />
                <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                  تغلق بعد غد ({data.dayAfterTomorrow.length} طلب)
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  {tableHead}
                  <tbody>
                    {data.dayAfterTomorrow.map(rfq => (
                      <ClosingSoonRow key={rfq.id} rfq={rfq} navigate={navigate} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}

export default function RfqListPage() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");

  const { data: rfqs, isLoading } = useListRfqs(
    { status: status !== "all" ? status : undefined, search: search || undefined },
    { query: { queryKey: getListRfqsQueryKey({ status: status !== "all" ? status : undefined, search: search || undefined }) } }
  );

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">RFQ Management</h1>
            <p className="text-muted-foreground text-sm">Request for Quotation workflow</p>
          </div>
          <Button onClick={() => navigate("/rfq/new")} size="sm" className="gap-1.5 self-start sm:self-auto">
            <Plus size={15} />
            New RFQ
          </Button>
        </div>

        {/* Closing Soon Report */}
        <ClosingSoonPanel navigate={navigate} />

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
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
                {s === "all" ? "الكل" : s === "DRAFT" ? "مسودة" : s === "SENT" ? "تم الإرسال" : s === "QUOTED" ? "عروض واردة" : s === "FAILED" ? "فشل" : s === "SUCCESS" ? "ناجح" : s}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
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
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">Internal No.</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">Customer RFQ</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">Employee</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">Status</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">Items</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">Suppliers</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">Offers</th>
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
                      <span className="font-mono text-xs text-primary font-medium">{rfq.internalRfqNo}</span>
                    </td>
                    <td className="px-4 py-3 text-foreground font-mono text-xs">{rfq.customerRfqNo}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{rfq.employeeName ?? "-"}</td>
                    <td className="px-4 py-3"><StatusBadge status={rfq.status} /></td>
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
            </table></div>
          )}
        </div>
      </div>
    </Layout>
  );
}

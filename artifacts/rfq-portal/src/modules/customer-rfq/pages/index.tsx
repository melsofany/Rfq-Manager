import { useState } from "react";
import { useLocation } from "wouter";
import { useListCustomerRfqs, getListCustomerRfqsQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, FileText, Sparkles, CalendarClock, List } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { filterTabs } from "@/lib/permissions";
import { OpenRequestsTab } from "./open-requests";

const CUSTOMER_RFQ_TABS = ["list", "open"] as const;
type CustomerRfqTab = (typeof CUSTOMER_RFQ_TABS)[number];

export default function CustomerRfqPage() {
  const { employee } = useAuth();
  const allowedTabs = filterTabs(
    employee?.role,
    employee?.permissions,
    "customer-rfq",
    CUSTOMER_RFQ_TABS,
  );
  const [tab, setTab] = useState<CustomerRfqTab>(() => {
    const q = new URLSearchParams(window.location.search).get("tab");
    const wanted: CustomerRfqTab = q === "open" ? "open" : "list";
    return (allowedTabs as readonly string[]).includes(wanted)
      ? wanted
      : (allowedTabs[0] ?? "list");
  });

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">طلبات تسعير العملاء</h1>
            <p className="text-muted-foreground text-sm">
              {tab === "open"
                ? "الطلبات التي ما زال عليها عمل، والمتبقي من الوقت لإغلاقها، والموظفون المسند إليهم بنودها."
                : "إدارة طلبات التسعير الواردة من العملاء"}
            </p>
          </div>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 border-b border-border">
          {allowedTabs.includes("list") && (
            <button
              onClick={() => setTab("list")}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                tab === "list"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <List size={15} /> كل الطلبات
            </button>
          )}
          {allowedTabs.includes("open") && (
            <button
              onClick={() => setTab("open")}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                tab === "open"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <CalendarClock size={15} /> الطلبات المفتوحة
            </button>
          )}
        </div>

        {tab === "open" ? <OpenRequestsTab /> : <AllRequestsTab />}
      </div>
    </Layout>
  );
}

function AllRequestsTab() {
  const [, navigate] = useLocation();
  const { employee } = useAuth();
  const [search, setSearch] = useState("");
  const [classifying, setClassifying] = useState(false);
  const canClassify = employee?.role === "admin" || employee?.role === "manager";

  const { data: rfqs, isLoading } = useListCustomerRfqs(
    { search: search || undefined },
    { query: { queryKey: getListCustomerRfqsQueryKey({ search: search || undefined }) } },
  );

  const runBulkClassify = async () => {
    setClassifying(true);
    try {
      const res = await fetch("/api/customer-rfq/items/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ limit: 300 }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        scanned?: number;
        classified?: number;
      };
      if (!res.ok) throw new Error(body.error || "فشل التصنيف الآلي");
      toast.success(`تم التصنيف الآلي: ${body.classified ?? 0} من ${body.scanned ?? 0} بند`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التصنيف الآلي");
    } finally {
      setClassifying(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="relative max-w-xs">
          <Search
            size={15}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث برقم الطلب أو العميل..."
            className="pl-8 h-8 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          {canClassify && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={runBulkClassify}
              disabled={classifying}
              title="تصنيف البنود غير المصنّفة تلقائيًا بالذكاء الاصطناعي"
            >
              <Sparkles size={15} /> {classifying ? "جارٍ التصنيف…" : "تصنيف آلي"}
            </Button>
          )}
          <Button onClick={() => navigate("/customer-rfq/new")} size="sm" className="gap-1.5">
            <Plus size={15} /> طلب تسعير جديد
          </Button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
        ) : !rfqs?.length ? (
          <div className="p-12 text-center">
            <FileText size={40} className="mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-muted-foreground text-sm">لا توجد طلبات تسعير</p>
            <Button
              onClick={() => navigate("/customer-rfq/new")}
              size="sm"
              className="mt-3 gap-1.5"
            >
              <Plus size={14} /> إنشاء أول طلب
            </Button>
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
                    تاريخ الدخول
                  </th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                    تاريخ الانتهاء
                  </th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">المشتري</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">المدخل</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">
                    البنود
                  </th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                    حالة الطلب
                  </th>
                </tr>
              </thead>
              <tbody>
                {rfqs.map((rfq) => (
                  <tr
                    key={rfq.id}
                    className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                    onClick={() => navigate(`/customer-rfq/${rfq.id}`)}
                  >
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-primary font-medium">
                        {rfq.internalNo}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-foreground text-xs">{rfq.customerName}</td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-foreground">{rfq.customerRfqNo}</span>
                      {rfq.numberAutoGenerated && (
                        <span className="mr-1 inline-block px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
                          تلقائي
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs" dir="ltr">
                      {rfq.entryDate ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs" dir="ltr">
                      {rfq.expiryDate ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {rfq.buyerName ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {rfq.employeeName ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center justify-center w-6 h-6 bg-muted rounded text-xs font-medium text-foreground">
                        {rfq.itemCount ?? 0}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <RequestStatusBadge status={rfq.requestStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// Colored badge for the derived request status. Each stage gets a distinct
// color so the list reads at a glance.
function RequestStatusBadge({
  status,
}: {
  status?: import("@workspace/api-client-react").CustomerRfqRequestStatus | null;
}) {
  if (!status) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const STAGE_STYLES: Record<string, string> = {
    received: "bg-slate-100 text-slate-600 dark:bg-slate-900/50 dark:text-slate-300",
    supplier_priced: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
    customer_priced: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
    po_issued: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
    delivered: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
    failed: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
    expired: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  };
  const cls = STAGE_STYLES[status.stage] ?? STAGE_STYLES.received;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${cls}`}>
      {status.label}
    </span>
  );
}

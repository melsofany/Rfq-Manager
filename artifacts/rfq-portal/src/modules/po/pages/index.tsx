import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useListPurchaseOrders, getListPurchaseOrdersQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Search, ShoppingCart, Ban } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { filterTabs } from "@/lib/permissions";
import GoodsReceiptPage from "./receipts";

const STATUSES = ["all", "draft", "sent", "cancelled"];
const PO_TABS = ["orders", "receipts"] as const;

interface PoProgress {
  poId: number;
  total: number;
  received: number;
  rejected: number;
}

export default function PurchaseOrdersListPage() {
  const [, navigate] = useLocation();
  const { employee } = useAuth();
  const allowedTabs = filterTabs(employee?.role, employee?.permissions, "purchase-orders", PO_TABS);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [tab, setTab] = useState<string>(allowedTabs[0] ?? "orders");
  const [progress, setProgress] = useState<Record<number, PoProgress>>({});

  const { data: purchaseOrders, isLoading } = useListPurchaseOrders(
    { status: status !== "all" ? status : undefined, search: search || undefined },
    {
      query: {
        queryKey: getListPurchaseOrdersQueryKey({
          status: status !== "all" ? status : undefined,
          search: search || undefined,
        }),
      },
    },
  );

  // Load per-PO receipt progress (received/rejected/total) for the list badge.
  // Live-refreshes via the same SSE stream the receipts tab uses.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/po/progress", { credentials: "include" });
        if (!r.ok) return;
        const data: PoProgress[] = await r.json();
        if (cancelled) return;
        setProgress(Object.fromEntries(data.map((p) => [p.poId, p])));
      } catch {
        /* non-critical */
      }
    }
    void load();
    const es = new EventSource("/api/whatsapp/events", { withCredentials: true });
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        if (payload?.type === "receipt_recorded") void load();
      } catch {
        /* ignore */
      }
    };
    return () => {
      cancelled = true;
      es.close();
    };
  }, [purchaseOrders]);

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">Purchase Orders</h1>
            <p className="text-muted-foreground text-sm">
              Manage purchase orders sent to suppliers
            </p>
          </div>
          <Button
            onClick={() => navigate("/purchase-orders/new")}
            size="sm"
            className="gap-1.5 self-start sm:self-auto"
          >
            <Plus size={15} />
            New Purchase Order
          </Button>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            {allowedTabs.includes("orders") && (
              <TabsTrigger value="orders" className="text-xs">أوامر الشراء</TabsTrigger>
            )}
            {allowedTabs.includes("receipts") && (
              <TabsTrigger value="receipts" className="text-xs">استلام التوريدات</TabsTrigger>
            )}
          </TabsList>
        </Tabs>

        {tab === "receipts" ? (
          <GoodsReceiptPage />
        ) : (
          <>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search
              size={15}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search PO number..."
              className="pl-8 h-8 text-sm"
            />
          </div>
          <div className="flex gap-1 overflow-x-auto pb-0.5 flex-nowrap">
            {STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors capitalize flex-shrink-0 ${
                  status === s
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading...</div>
          ) : purchaseOrders?.length === 0 ? (
            <div className="p-12 text-center">
              <ShoppingCart size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground text-sm">No purchase orders found</p>
              <Button
                onClick={() => navigate("/purchase-orders/new")}
                size="sm"
                className="mt-3 gap-1.5"
              >
                <Plus size={14} /> Create first purchase order
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
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">PO No.</th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                      Employee
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                      Receiver
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">Status</th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">
                      الاستلام
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">
                      إجراء
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {purchaseOrders?.map((po) => (
                    <tr
                      key={po.id}
                      onClick={() => navigate(`/purchase-orders/${po.id}`)}
                      className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                    >
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-primary font-medium">
                          {po.internalPoNo}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-foreground font-mono text-xs">
                        {po.sheetPoNo}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {po.employeeName ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {po.receiverName
                          ? `${po.receiverName}${po.receiverPhone ? ` · ${po.receiverPhone}` : ""}`
                          : "-"}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={po.status} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        {(() => {
                          const p = progress[po.id];
                          if (!p || p.total === 0) {
                            return (
                              <span className="inline-flex items-center justify-center min-w-6 h-6 px-1.5 bg-muted rounded text-xs font-medium text-foreground">
                                {po.itemCount}
                              </span>
                            );
                          }
                          const allDone = p.received + p.rejected >= p.total;
                          const tone = p.rejected > 0
                            ? "bg-amber-100 text-amber-700"
                            : allDone
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-muted text-foreground";
                          return (
                            <span className={`inline-flex items-center justify-center min-w-6 h-6 px-1.5 rounded text-xs font-medium ${tone}`}>
                              {p.received}/{p.total}
                              {p.rejected > 0 && (
                                <span className="mr-1 text-red-600">·{p.rejected} رفض</span>
                              )}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {po.status === "sent" ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/purchase-orders/${po.id}`);
                            }}
                            title="إدارة الإلغاء لكل مورد من صفحة التفاصيل"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-destructive border border-destructive/40 hover:bg-destructive/10"
                          >
                            <Ban size={13} />
                            إدارة الإلغاء
                          </button>
                        ) : (
                          <span className="text-muted-foreground/40 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {new Date(po.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
          </>
        )}
      </div>
    </Layout>
  );
}

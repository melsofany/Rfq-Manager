import { useGetDashboardStats, getGetDashboardStatsQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { StatusBadge } from "@/components/StatusBadge";
import { Link } from "wouter";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import {
  FileText,
  Users,
  TrendingUp,
  Inbox,
  ArrowRight,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Loader2,
  ShoppingCart,
  Package,
  Tag,
  BarChart2,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";

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

interface SyncStatus {
  lastSyncAt: string | null;
  lastSyncResult: "success" | "error" | null;
  lastSyncError: string | null;
  lastSyncStats: { rfqs: number; items: number; suppliers: number } | null;
  deleted: { rfqs: number; items: number; suppliers: number } | null;
  inProgress: boolean;
}

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  color,
}: {
  label: string;
  value: number | string;
  sub?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color: string;
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-muted-foreground text-xs uppercase tracking-wider font-medium">
            {label}
          </p>
          <p className="text-3xl font-bold text-foreground mt-1">{value}</p>
          {sub && <p className="text-muted-foreground text-xs mt-1">{sub}</p>}
        </div>
        <div className={`p-2 rounded-lg ${color}`}>
          <Icon size={20} />
        </div>
      </div>
    </div>
  );
}

function SheetSyncCard() {
  const { employee: user } = useAuth();
  const canSync = user?.role === "admin" || user?.role === "manager";

  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/status", { credentials: "include" });
      if (res.ok) setSyncStatus(await res.json());
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!syncStatus?.inProgress && !syncing) return;
    const id = setInterval(fetchStatus, 2000);
    return () => clearInterval(id);
  }, [syncStatus?.inProgress, syncing, fetchStatus]);

  async function triggerSync() {
    setSyncing(true);
    try {
      await fetch("/api/sync/sheet", { method: "POST", credentials: "include" });
      const poll = setInterval(async () => {
        await fetchStatus();
        const fresh = (await fetch("/api/sync/status", { credentials: "include" }).then((r) =>
          r.json(),
        )) as SyncStatus;
        if (!fresh.inProgress) {
          setSyncStatus(fresh);
          setSyncing(false);
          clearInterval(poll);
        }
      }, 2000);
    } catch {
      setSyncing(false);
    }
  }

  const isRunning = syncing || syncStatus?.inProgress;

  return (
    <div className="bg-card border border-border rounded-lg p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-semibold text-foreground text-sm">Google Sheet Sync</h2>
          <p className="text-muted-foreground text-xs mt-0.5">
            Mirror of database — RFQs, Items, Suppliers
          </p>
        </div>
        {canSync && (
          <button
            onClick={triggerSync}
            disabled={isRunning}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isRunning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {isRunning ? "Syncing..." : "Sync Now"}
          </button>
        )}
      </div>

      {syncStatus?.lastSyncAt ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {syncStatus.lastSyncResult === "success" ? (
              <CheckCircle size={14} className="text-green-500 shrink-0" />
            ) : (
              <AlertCircle size={14} className="text-red-500 shrink-0" />
            )}
            <span className="text-xs text-muted-foreground">
              Last sync: {new Date(syncStatus.lastSyncAt).toLocaleString()}
            </span>
          </div>

          {syncStatus.lastSyncResult === "success" && syncStatus.lastSyncStats && (
            <div className="flex gap-4 text-xs text-muted-foreground pl-5">
              <span>{syncStatus.lastSyncStats.rfqs} RFQs</span>
              <span>{syncStatus.lastSyncStats.items} items</span>
              <span>{syncStatus.lastSyncStats.suppliers} suppliers</span>
              {syncStatus.deleted &&
                syncStatus.deleted.rfqs + syncStatus.deleted.items + syncStatus.deleted.suppliers >
                  0 && (
                  <span className="text-amber-600 font-medium">
                    {syncStatus.deleted.rfqs +
                      syncStatus.deleted.items +
                      syncStatus.deleted.suppliers}{" "}
                    deleted from DB
                  </span>
                )}
            </div>
          )}

          {syncStatus.lastSyncResult === "error" && (
            <p className="text-xs text-red-500 pl-5 truncate">{syncStatus.lastSyncError}</p>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {isRunning
            ? "First sync in progress..."
            : "No sync has run yet. Click Sync Now to start."}
        </p>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const { t } = useLanguage();
  const { data: stats, isLoading } = useGetDashboardStats({
    query: { queryKey: getGetDashboardStatsQueryKey() },
  });

  if (isLoading) {
    return (
      <Layout>
        <div className="p-4 sm:p-6 space-y-4">
          <div className="h-8 bg-muted rounded w-48 animate-pulse" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-28 bg-muted rounded-lg animate-pulse" />
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-28 bg-muted rounded-lg animate-pulse" />
            ))}
          </div>
        </div>
      </Layout>
    );
  }

  const chartData =
    stats?.rfqsByStatus?.map((s) => ({
      name: t(`status.${s.status}`),
      value: s.count,
      fill: STATUS_COLORS[s.status ?? ""] || "#6b7280",
    })) ?? [];

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">{t("dashboard.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("dashboard.subtitle")}</p>
        </div>

        {/* KPI Cards — Row 1: RFQ overview */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            label={t("dashboard.totalRfqs")}
            value={stats?.totalRfqs ?? 0}
            icon={FileText}
            color="bg-blue-50 text-blue-600"
          />
          <KpiCard
            label={t("dashboard.openRfqs")}
            value={stats?.openRfqs ?? 0}
            sub={t("dashboard.active")}
            icon={Inbox}
            color="bg-amber-50 text-amber-600"
          />
          <KpiCard
            label={t("dashboard.suppliers")}
            value={stats?.totalSuppliers ?? 0}
            sub={t("dashboard.active")}
            icon={Users}
            color="bg-green-50 text-green-600"
          />
          <KpiCard
            label={t("dashboard.responseRate")}
            value={`${stats?.responseRateThisMonth ?? 0}%`}
            sub={t("dashboard.thisMonth")}
            icon={TrendingUp}
            color="bg-purple-50 text-purple-600"
          />
        </div>

        {/* KPI Cards — Row 2: PO & item analytics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            label="Purchase Orders"
            value={stats?.totalPos ?? 0}
            sub="Total POs created"
            icon={ShoppingCart}
            color="bg-indigo-50 text-indigo-600"
          />
          <KpiCard
            label="RFQ → PO Rate"
            value={`${stats?.rfqToPoRate ?? 0}%`}
            sub="Conversion rate"
            icon={BarChart2}
            color="bg-rose-50 text-rose-600"
          />
          <KpiCard
            label="Total Items"
            value={stats?.totalItems ?? 0}
            sub={`${stats?.pricedItems ?? 0} priced`}
            icon={Package}
            color="bg-cyan-50 text-cyan-600"
          />
          <KpiCard
            label="Pricing Coverage"
            value={`${stats?.pricingRate ?? 0}%`}
            sub={`${stats?.unpricedItems ?? 0} items unpriced`}
            icon={Tag}
            color="bg-teal-50 text-teal-600"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* RFQ Status Chart */}
          <div className="bg-card border border-border rounded-lg p-5">
            <h2 className="font-semibold text-foreground text-sm mb-4">
              {t("dashboard.rfqsByStatus")}
            </h2>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} barCategoryGap="30%">
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                    {chartData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
                {t("dashboard.noData")}
              </div>
            )}
          </div>

          {/* Top Suppliers */}
          <div className="bg-card border border-border rounded-lg p-5">
            <h2 className="font-semibold text-foreground text-sm mb-4">
              {t("dashboard.topSuppliers")}
            </h2>
            {stats?.topSuppliers?.length ? (
              <div className="space-y-3">
                {stats.topSuppliers.map((s) => (
                  <div key={s.supplierId} className="flex items-center justify-between">
                    <span className="text-sm text-foreground truncate max-w-[200px]">
                      {s.supplierName}
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">
                        {s.totalOffersSubmitted} {t("dashboard.offers")}
                      </span>
                      <div className="w-16 bg-muted rounded-full h-1.5">
                        <div
                          className="bg-primary h-1.5 rounded-full"
                          style={{ width: `${Math.min(s.responseRate ?? 0, 100)}%` }}
                        />
                      </div>
                      <span className="text-xs font-medium text-foreground w-10 text-right">
                        {s.responseRate}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
                {t("dashboard.noSupplierData")}
              </div>
            )}
          </div>
        </div>

        {/* Item & PO breakdown */}
        {((stats?.totalItems ?? 0) > 0 || (stats?.totalPos ?? 0) > 0) && (
          <div className="bg-card border border-border rounded-lg p-5">
            <h2 className="font-semibold text-foreground text-sm mb-4">Items & PO Breakdown</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
              <div className="text-center">
                <p className="text-2xl font-bold text-foreground">{stats?.totalItems ?? 0}</p>
                <p className="text-xs text-muted-foreground mt-1">Total RFQ Items</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-green-600">{stats?.pricedItems ?? 0}</p>
                <p className="text-xs text-muted-foreground mt-1">Priced Items</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-amber-600">{stats?.unpricedItems ?? 0}</p>
                <p className="text-xs text-muted-foreground mt-1">Unpriced Items</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-indigo-600">{stats?.itemsWithPo ?? 0}</p>
                <p className="text-xs text-muted-foreground mt-1">Items in POs</p>
              </div>
            </div>
            {/* Pricing coverage bar */}
            {(stats?.totalItems ?? 0) > 0 && (
              <div className="mt-4">
                <div className="flex justify-between text-xs text-muted-foreground mb-1">
                  <span>Pricing coverage</span>
                  <span>{stats?.pricingRate ?? 0}%</span>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div
                    className="bg-green-500 h-2 rounded-full transition-all"
                    style={{ width: `${Math.min(stats?.pricingRate ?? 0, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>PO award rate</span>
                  <span>{stats?.poRate ?? 0}%</span>
                </div>
                <div className="w-full bg-muted rounded-full h-2 mt-1">
                  <div
                    className="bg-indigo-500 h-2 rounded-full transition-all"
                    style={{ width: `${Math.min(stats?.poRate ?? 0, 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Google Sheet Sync */}
        <SheetSyncCard />

        {/* Recent RFQs */}
        <div className="bg-card border border-border rounded-lg">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="font-semibold text-foreground text-sm">{t("dashboard.recentRfqs")}</h2>
            <Link href="/rfq">
              <a className="text-primary text-xs flex items-center gap-1 hover:underline">
                {t("dashboard.viewAll")} <ArrowRight size={12} />
              </a>
            </Link>
          </div>
          {stats?.recentRfqs?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="px-5 py-2.5 text-muted-foreground text-xs font-medium">
                      Internal No.
                    </th>
                    <th className="px-5 py-2.5 text-muted-foreground text-xs font-medium">
                      Customer RFQ
                    </th>
                    <th className="px-5 py-2.5 text-muted-foreground text-xs font-medium">
                      Employee
                    </th>
                    <th className="px-5 py-2.5 text-muted-foreground text-xs font-medium">Items</th>
                    <th className="px-5 py-2.5 text-muted-foreground text-xs font-medium">
                      Offers
                    </th>
                    <th className="px-5 py-2.5 text-muted-foreground text-xs font-medium">
                      Status
                    </th>
                    <th className="px-5 py-2.5 text-muted-foreground text-xs font-medium">
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recentRfqs.map((rfq) => (
                    <tr
                      key={rfq.id}
                      className="border-b border-border last:border-0 hover:bg-muted/30"
                    >
                      <td className="px-5 py-3">
                        <Link href={`/rfq/${rfq.id}`}>
                          <a className="text-primary font-mono text-xs hover:underline">
                            {rfq.internalRfqNo}
                          </a>
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-foreground text-xs font-mono">
                        {rfq.customerRfqNo}
                      </td>
                      <td className="px-5 py-3 text-muted-foreground text-xs">
                        {rfq.employeeName ?? "-"}
                      </td>
                      <td className="px-5 py-3 text-muted-foreground text-xs text-center">
                        {rfq.itemCount ?? 0}
                      </td>
                      <td className="px-5 py-3 text-muted-foreground text-xs text-center">
                        {rfq.offerCount ?? 0}
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={rfq.status} />
                      </td>
                      <td className="px-5 py-3 text-muted-foreground text-xs">
                        {new Date(rfq.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-5 py-10 text-center text-muted-foreground text-sm">
              {t("dashboard.noRfqs")}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

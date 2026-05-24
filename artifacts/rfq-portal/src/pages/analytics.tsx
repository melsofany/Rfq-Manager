import { useGetDashboardStats, getGetDashboardStatsQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  RadarChart, PolarGrid, PolarAngleAxis, Radar,
} from "recharts";

export default function AnalyticsPage() {
  const { data: stats, isLoading } = useGetDashboardStats({
    query: { queryKey: getGetDashboardStatsQueryKey() },
  });

  const supplierData = stats?.topSuppliers?.map((s) => ({
    name: s.supplierName.length > 18 ? s.supplierName.slice(0, 18) + "…" : s.supplierName,
    score: s.totalScore,
    responseRate: s.responseRateScore,
    offers: s.totalOffersSubmitted,
  })) ?? [];

  const statusData = stats?.rfqsByStatus?.map((s) => ({
    name: s.status.charAt(0).toUpperCase() + s.status.slice(1),
    count: s.count,
  })) ?? [];

  return (
    <Layout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">Analytics</h1>
          <p className="text-muted-foreground text-sm">Procurement performance overview</p>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2].map((i) => <div key={i} className="h-64 bg-muted rounded-lg animate-pulse" />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Supplier Scorecard */}
            <div className="bg-card border border-border rounded-lg p-5">
              <h2 className="font-semibold text-sm text-foreground mb-4">Supplier Response Rates</h2>
              {supplierData.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={supplierData} layout="vertical" barCategoryGap="25%">
                    <XAxis type="number" tick={{ fontSize: 11 }} domain={[0, 100]} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={130} />
                    <Tooltip formatter={(v) => [`${v}%`, "Response Rate"]} />
                    <Bar dataKey="responseRate" fill="hsl(221,83%,53%)" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">No data yet</div>
              )}
            </div>

            {/* RFQ Status Distribution */}
            <div className="bg-card border border-border rounded-lg p-5">
              <h2 className="font-semibold text-sm text-foreground mb-4">RFQ Status Distribution</h2>
              {statusData.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={statusData} barCategoryGap="30%">
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="count" fill="hsl(173,58%,39%)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">No data yet</div>
              )}
            </div>

            {/* KPI Summary */}
            <div className="bg-card border border-border rounded-lg p-5 col-span-full">
              <h2 className="font-semibold text-sm text-foreground mb-4">Key Metrics</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div className="bg-muted/30 rounded-lg p-4 text-center">
                  <p className="text-3xl font-bold text-foreground">{stats?.totalRfqs ?? 0}</p>
                  <p className="text-muted-foreground text-xs mt-1">Total RFQs</p>
                </div>
                <div className="bg-muted/30 rounded-lg p-4 text-center">
                  <p className="text-3xl font-bold text-foreground">{stats?.totalOffers ?? 0}</p>
                  <p className="text-muted-foreground text-xs mt-1">Offers Received</p>
                </div>
                <div className="bg-muted/30 rounded-lg p-4 text-center">
                  <p className="text-3xl font-bold text-foreground">{stats?.totalSuppliers ?? 0}</p>
                  <p className="text-muted-foreground text-xs mt-1">Active Suppliers</p>
                </div>
                <div className="bg-muted/30 rounded-lg p-4 text-center">
                  <p className="text-3xl font-bold text-foreground">{stats?.responseRateThisMonth ?? 0}%</p>
                  <p className="text-muted-foreground text-xs mt-1">Response Rate</p>
                </div>
              </div>
            </div>

            {/* Top Supplier Leaderboard */}
            <div className="bg-card border border-border rounded-lg p-5 col-span-full">
              <h2 className="font-semibold text-sm text-foreground mb-4">Supplier Leaderboard</h2>
              {stats?.topSuppliers?.length ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="pb-2 text-muted-foreground text-xs font-medium w-8">#</th>
                      <th className="pb-2 text-muted-foreground text-xs font-medium">Supplier</th>
                      <th className="pb-2 text-muted-foreground text-xs font-medium text-center">Score</th>
                      <th className="pb-2 text-muted-foreground text-xs font-medium text-center">RFQs</th>
                      <th className="pb-2 text-muted-foreground text-xs font-medium text-center">Offers</th>
                      <th className="pb-2 text-muted-foreground text-xs font-medium text-center">Response %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.topSuppliers.map((s, i) => (
                      <tr key={s.supplierId} className="border-b border-border last:border-0">
                        <td className="py-3 text-muted-foreground text-xs">{i + 1}</td>
                        <td className="py-3 font-medium text-foreground">{s.supplierName}</td>
                        <td className="py-3 text-center">
                          <span className={`font-bold text-sm ${
                            s.totalScore >= 70 ? "text-green-600" : s.totalScore >= 50 ? "text-amber-600" : "text-red-600"
                          }`}>{s.totalScore}</span>
                        </td>
                        <td className="py-3 text-center text-xs text-foreground">{s.totalRfqsReceived}</td>
                        <td className="py-3 text-center text-xs text-foreground">{s.totalOffersSubmitted}</td>
                        <td className="py-3 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <div className="w-16 bg-muted rounded-full h-1.5">
                              <div className="bg-primary h-1.5 rounded-full" style={{ width: `${s.responseRate}%` }} />
                            </div>
                            <span className="text-xs text-foreground w-8">{s.responseRate}%</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="py-8 text-center text-muted-foreground text-sm">No supplier data yet</div>
              )}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

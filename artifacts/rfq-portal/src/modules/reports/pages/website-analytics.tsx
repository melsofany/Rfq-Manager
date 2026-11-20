import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Globe } from "lucide-react";

type Summary = {
  last7: { views: number; visitors: number };
  last30: { views: number; visitors: number };
};
type TrendRow = { period: string; views: number; visitors: number };
type GroupRow = { views: number; visitors: number } & Record<string, string | number>;

function useWebsiteQuery<T>(path: string) {
  return useQuery<T>({
    queryKey: ["website-analytics", path],
    queryFn: () => customFetch<T>(`/api/website-analytics/${path}`, { method: "GET" }),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}

function Stat({ title, views, visitors }: { title: string; views: number; visitors: number }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <p className="text-sm text-muted-foreground">{title}</p>
      <div className="mt-2 flex gap-6">
        <div>
          <p className="text-2xl font-bold text-foreground">{views.toLocaleString("ar-EG")}</p>
          <p className="text-xs text-muted-foreground">مشاهدة صفحة</p>
        </div>
        <div>
          <p className="text-2xl font-bold text-foreground">{visitors.toLocaleString("ar-EG")}</p>
          <p className="text-xs text-muted-foreground">زائر</p>
        </div>
      </div>
    </div>
  );
}

function Table({ rows, label, keyName }: { rows: GroupRow[]; label: string; keyName: string }) {
  const max = Math.max(1, ...rows.map((r) => r.views));
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th className="text-start p-3 font-medium">{label}</th>
            <th className="text-end p-3 font-medium">المشاهدات</th>
            <th className="text-end p-3 font-medium">الزوار</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border">
              <td className="p-3">
                <div className="flex items-center gap-2">
                  <span>{String(r[keyName])}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-muted">
                  <div
                    className="h-1.5 rounded bg-primary"
                    style={{ width: `${(r.views / max) * 100}%` }}
                  />
                </div>
              </td>
              <td className="p-3 text-end">{r.views.toLocaleString("ar-EG")}</td>
              <td className="p-3 text-end">{r.visitors.toLocaleString("ar-EG")}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="p-6 text-center text-muted-foreground">
                لا توجد بيانات
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Trend({ rows, title }: { rows: TrendRow[]; title: string }) {
  const max = Math.max(1, ...rows.map((r) => r.views));
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <h2 className="font-semibold mb-3">{title}</h2>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.period} className="grid grid-cols-[7rem_1fr_auto] items-center gap-3 text-sm">
            <span className="text-muted-foreground" dir="ltr">
              {r.period.slice(0, 10)}
            </span>
            <div className="h-3 rounded bg-muted">
              <div
                className="h-3 rounded bg-primary"
                style={{ width: `${(r.views / max) * 100}%` }}
              />
            </div>
            <span className="text-end whitespace-nowrap">
              {r.views.toLocaleString("ar-EG")} / {r.visitors.toLocaleString("ar-EG")}
            </span>
          </div>
        ))}
        {rows.length === 0 && <p className="text-muted-foreground text-sm">لا توجد بيانات</p>}
      </div>
      <p className="text-xs text-muted-foreground mt-3">المشاهدات / الزوار</p>
    </div>
  );
}

export default function WebsiteAnalyticsPage() {
  const summary = useWebsiteQuery<Summary>("summary");
  const weekly = useWebsiteQuery<TrendRow[]>("trend?granularity=week");
  const monthly = useWebsiteQuery<TrendRow[]>("trend?granularity=month");
  const countries = useWebsiteQuery<GroupRow[]>("countries");
  const egypt = useWebsiteQuery<GroupRow[]>("egypt");

  const notConfigured = [summary, weekly].some(
    (q) => (q.error as { status?: number } | null)?.status === 503,
  );

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-6">
        <div className="flex items-center gap-3">
          <Globe className="text-primary" size={24} />
          <div>
            <h1 className="text-xl font-bold text-foreground">زيارات الموقع الإلكتروني</h1>
            <p className="text-muted-foreground text-sm">
              إحصائيات الزيارات من PostHog — الأسبوعية والشهرية والدول والمحافظات
            </p>
          </div>
        </div>

        {notConfigured ? (
          <div className="bg-card border border-border rounded-lg p-6 text-sm text-muted-foreground">
            التحليلات غير مفعلة بعد. لازم يتضاف على السيرفر متغيرات
            <span dir="ltr" className="mx-1">
              POSTHOG_PERSONAL_API_KEY
            </span>{" "}
            و
            <span dir="ltr" className="mx-1">
              POSTHOG_PROJECT_ID
            </span>
            .
          </div>
        ) : (
          <>
            {summary.data && (
              <div className="grid gap-4 md:grid-cols-2">
                <Stat title="آخر 7 أيام" {...summary.data.last7} />
                <Stat title="آخر 30 يوم" {...summary.data.last30} />
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              <Trend title="أسبوعياً (آخر 12 أسبوع)" rows={weekly.data ?? []} />
              <Trend title="شهرياً (آخر 12 شهر)" rows={monthly.data ?? []} />
            </div>

            <section className="space-y-2">
              <h2 className="font-semibold">حسب الدولة (آخر 30 يوم)</h2>
              <Table rows={countries.data ?? []} label="الدولة" keyName="country" />
            </section>

            <section className="space-y-2">
              <h2 className="font-semibold">مصر حسب المحافظة (آخر 30 يوم)</h2>
              <Table rows={egypt.data ?? []} label="المحافظة" keyName="governorate" />
            </section>
          </>
        )}
      </div>
    </Layout>
  );
}

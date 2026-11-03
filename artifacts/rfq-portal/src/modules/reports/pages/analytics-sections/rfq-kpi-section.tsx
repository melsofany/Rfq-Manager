import { useState, useEffect, useCallback, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";

// ────────────────── types (mirror GET /api/analytics/rfq-kpis) ──────────────────

interface RfqKpiResponse {
  year: number;
  month: number;
  yearly: {
    totalItems: number;
    rfqCount: number;
    customerPoCount: number;
    pricedItems: number;
    pricingRate: number;
    poWinRate: number;
  };
  monthly: {
    rfqCount: number;
    firstSeenItems: number;
    itemsToPrice: number;
    supplierRfqCount: number;
    supplierPoCount: number;
    supplierPoRate: number;
    openCustomerRequests: number;
    openCustomerItems: number;
    itemsWithSupplierPrice: number;
    supplierPriceRate: number;
  };
  definitions: Record<string, string>;
}

// ────────────────── small presentational pieces ──────────────────

function KpiCard({
  label,
  value,
  suffix,
  definition,
  tone,
}: {
  label: string;
  value: number;
  suffix?: string;
  definition: string;
  tone: string;
}) {
  return (
    <div className={`rounded-xl border p-4 ${tone}`}>
      <div className="text-xs font-medium opacity-80">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">
        {value.toLocaleString("en-US")}
        {suffix ? <span className="text-base font-semibold"> {suffix}</span> : null}
      </div>
      <p className="mt-2 text-[11px] leading-5 opacity-70">{definition}</p>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{children}</h3>;
}

const MONTHS_AR = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

// ────────────────── section ──────────────────

export function RfqKpiSection() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [data, setData] = useState<RfqKpiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/analytics/rfq-kpis?year=${year}&month=${month}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as RfqKpiResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحميل المؤشرات");
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    void load();
  }, [load]);

  const d = data?.definitions ?? {};

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">مؤشرات طلبات التسعير</h2>
        <div className="flex items-center gap-2">
          <select
            aria-label="الشهر"
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
          >
            {MONTHS_AR.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </select>
          <input
            aria-label="السنة"
            type="number"
            className="w-24 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
          />
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border border-slate-300 p-1.5 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
            aria-label="تحديث"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {data && (
        <>
          <div>
            <SectionTitle>إجمالي السنة {data.year}</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <KpiCard label="إجمالي البنود" value={data.yearly.totalItems} definition={d.totalItems ?? ""} tone="border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" />
              <KpiCard label="طلبات التسعير" value={data.yearly.rfqCount} definition={d.rfqCount ?? ""} tone="border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" />
              <KpiCard label="أوامر الشراء من العملاء" value={data.yearly.customerPoCount} definition={d.customerPoCount ?? ""} tone="border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" />
              <KpiCard label="البنود المسعّرة" value={data.yearly.pricedItems} definition={d.pricedItems ?? ""} tone="border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" />
              <KpiCard label="نسبة التسعير" value={data.yearly.pricingRate} suffix="%" definition={d.pricingRate ?? ""} tone="border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100" />
              <KpiCard label="نسبة الفوز بالـ PO" value={data.yearly.poWinRate} suffix="%" definition={d.poWinRate ?? ""} tone="border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100" />
            </div>
          </div>

          <div>
            <SectionTitle>
              شهر {MONTHS_AR[data.month - 1]} {data.year}
            </SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              <KpiCard label="طلبات التسعير (العملاء)" value={data.monthly.rfqCount} definition={d.monthRfqCount ?? ""} tone="border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" />
              <KpiCard label="بنود دخلت لأول مرة" value={data.monthly.firstSeenItems} definition={d.monthFirstSeenItems ?? ""} tone="border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" />
              <KpiCard label="إجمالي البنود المطلوب تسعيرها" value={data.monthly.itemsToPrice} definition={d.monthItemsToPrice ?? ""} tone="border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" />
              <KpiCard label="طلبات التسعير المرسلة للموردين" value={data.monthly.supplierRfqCount} definition={d.monthSupplierRfqCount ?? ""} tone="border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" />
              <KpiCard label="أوامر الشراء المرسلة للموردين" value={data.monthly.supplierPoCount} definition={d.monthSupplierPoCount ?? ""} tone="border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" />
              <KpiCard label="نسبة أوامر الشراء للموردين" value={data.monthly.supplierPoRate} suffix="%" definition={d.monthSupplierPoRate ?? ""} tone="border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-100" />
              <KpiCard label="الطلبات المفتوحة للعملاء" value={data.monthly.openCustomerRequests} definition={d.monthOpenCustomerRequests ?? ""} tone="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100" />
              <KpiCard label="بنود مطلوب تسعيرها للعملاء" value={data.monthly.openCustomerItems} definition={d.monthOpenCustomerItems ?? ""} tone="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100" />
              <KpiCard label="بنود ليها سعر مورد" value={data.monthly.itemsWithSupplierPrice} definition={d.monthItemsWithSupplierPrice ?? ""} tone="border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" />
              <KpiCard label="نسبة البنود اللي ليها سعر مورد" value={data.monthly.supplierPriceRate} suffix="%" definition={d.monthSupplierPriceRate ?? ""} tone="border-violet-200 bg-violet-50 text-violet-900 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-100" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

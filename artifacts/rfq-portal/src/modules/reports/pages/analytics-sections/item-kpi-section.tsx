import { useState, useEffect, useCallback } from "react";
import { RefreshCw, UserCog, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

// ────────────────── overview types ──────────────────
import { EmployeeKpiBoard, type ItemKpiEmployee } from "./EmployeeKpiBoard";

export interface ItemKpiResponse {
  employees: ItemKpiEmployee[];
  categories: Array<{
    categoryId: number | null;
    categoryName: string;
    items: number;
    itemsWithOffers: number;
    offersReceived: number;
    convertedItems: number;
    deliveredItems: number;
  }>;
  unassigned: Array<{
    categoryId: number | null;
    categoryName: string | null;
    items: number;
    itemsWithOffers: number;
    offersReceived: number;
    convertedItems: number;
  }>;
  totals: {
    items: number;
    itemsWithOffers: number;
    offersReceived: number;
    convertedItems: number;
    deliveredItems: number;
    manualItems: number;
    assignedItems: number;
    unassignedItems: number;
    unclassifiedItems: number;
    totalItems: number;
  };
}
export interface CoverageResponse {
  categories: Array<{
    id: number;
    name: string;
    isActive: boolean;
    owners: number;
    uncovered: boolean;
  }>;
  totals: {
    totalItems: number;
    unclassifiedItems: number;
    assignedItems: number;
    unassignedItems: number;
  };
}

// ────────── attribution achievement — «من أحضر السعر الفائز» ──────────

export function ItemKpiSection() {
  const [kpi, setKpi] = useState<ItemKpiResponse | null>(null);
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [kRes, cRes] = await Promise.all([
        fetch("/api/analytics/procurement/by-item", { credentials: "include" }),
        fetch("/api/analytics/categories/coverage", { credentials: "include" }),
      ]);
      if (kRes.ok) setKpi((await kRes.json()) as ItemKpiResponse);
      if (cRes.ok) setCoverage((await cRes.json()) as CoverageResponse);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل مؤشرات البنود"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = kpi?.totals;
  const rows = kpi?.employees ?? [];
  const cov = coverage?.totals;
  const uncoveredCats = (coverage?.categories ?? []).filter((c) => c.uncovered);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-base text-foreground flex items-center gap-2">
            <UserCog size={18} className="text-teal-500" />
            مؤشرات الأداء حسب مسؤولية البند
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            توزيع البنود على الموظفين حسب التصنيف: البنود، البنود التي استقبلت عروضًا، العروض،
            والتحويل لأمر شراء — مع تغطية التصنيفات
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <RefreshCw size={12} /> تحديث
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground animate-pulse">جارٍ التحميل…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: "إجمالي البنود المسندة", value: totals?.items ?? 0, color: "teal" },
              { label: "بنود استقبلت عروضًا", value: totals?.itemsWithOffers ?? 0, color: "blue" },
              { label: "إجمالي العروض", value: totals?.offersReceived ?? 0, color: "indigo" },
              {
                label: "بنود تحوّلت لأمر شراء",
                value: totals?.convertedItems ?? 0,
                color: "emerald",
              },
              {
                label: "بنود أمر شرائها اتسلّم",
                value: totals?.deliveredItems ?? 0,
                color: "emerald",
              },
              { label: "إسناد يدوي", value: totals?.manualItems ?? 0, color: "slate" },
            ].map((c) => (
              <div key={c.label} className="bg-card border border-border rounded-lg p-3">
                <div className="text-xl font-bold text-foreground">{c.value}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">{c.label}</div>
              </div>
            ))}
          </div>

          <EmployeeKpiBoard rows={rows} />

          {cov && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-card border border-border rounded-lg p-3">
                <div className="text-lg font-semibold text-foreground">{cov.totalItems}</div>
                <div className="text-[11px] text-muted-foreground">إجمالي بنود النظام</div>
              </div>
              <div className="bg-card border border-border rounded-lg p-3">
                <div
                  className={`text-lg font-semibold ${cov.unclassifiedItems ? "text-amber-600" : "text-foreground"}`}
                >
                  {cov.unclassifiedItems}
                </div>
                <div className="text-[11px] text-muted-foreground">بنود غير مصنّفة</div>
              </div>
              <div className="bg-card border border-border rounded-lg p-3">
                <div className="text-lg font-semibold text-foreground">{cov.assignedItems}</div>
                <div className="text-[11px] text-muted-foreground">بنود لها مسؤول</div>
              </div>
              <div className="bg-card border border-border rounded-lg p-3">
                <div
                  className={`text-lg font-semibold ${cov.unassignedItems ? "text-amber-600" : "text-foreground"}`}
                >
                  {cov.unassignedItems}
                </div>
                <div className="text-[11px] text-muted-foreground">بنود بلا مسؤول</div>
              </div>
            </div>
          )}

          {uncoveredCats.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
              <AlertTriangle size={13} className="inline me-1" />
              تصنيفات بلا مسؤول: {uncoveredCats.map((c) => c.name).join("، ")}
            </div>
          )}

          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/30 border-b border-border text-right">
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">الموظف</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">التصنيف</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-center">
                    البنود
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-center">
                    بعروض
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-center">
                    العروض
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-center">
                    تحويل
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-center">
                    نسبة التحويل
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-center">
                    أمر شراء اتسلّم
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground text-sm">
                      لا توجد بنود مسندة بعد.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr
                      key={`${r.employeeId}:${r.categoryId ?? "none"}`}
                      className="border-b border-border last:border-0"
                    >
                      <td className="px-3 py-2 text-foreground text-xs">{r.employeeName}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {r.categoryName ?? "غير مصنّف"}
                      </td>
                      <td className="px-3 py-2 text-center text-xs text-foreground">{r.items}</td>
                      <td className="px-3 py-2 text-center text-xs text-foreground">
                        {r.itemsWithOffers}
                      </td>
                      <td className="px-3 py-2 text-center text-xs text-foreground">
                        {r.offersReceived}
                      </td>
                      <td className="px-3 py-2 text-center text-xs text-foreground">
                        {r.convertedItems}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${
                            r.conversionRate >= 50
                              ? "bg-emerald-100 text-emerald-700"
                              : r.conversionRate >= 20
                                ? "bg-amber-100 text-amber-700"
                                : "bg-red-100 text-red-700"
                          }`}
                        >
                          {r.conversionRate}%
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center text-xs text-emerald-600">
                        {r.deliveredItems}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Reconciliation: the employee table covers only ASSIGNED items.
              Unassigned (classified, no owner) and unclassified items are shown
              explicitly so the totals add up instead of silently diverging. */}
          {totals && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-card border border-border rounded-lg p-3">
                <div className="text-lg font-semibold text-foreground">{totals.totalItems}</div>
                <div className="text-[11px] text-muted-foreground">إجمالي بنود النظام</div>
              </div>
              <div className="bg-card border border-border rounded-lg p-3">
                <div className="text-lg font-semibold text-teal-600">{totals.assignedItems}</div>
                <div className="text-[11px] text-muted-foreground">بنود لها مسؤول</div>
              </div>
              <div className="bg-card border border-border rounded-lg p-3">
                <div
                  className={`text-lg font-semibold ${totals.unassignedItems ? "text-amber-600" : "text-foreground"}`}
                >
                  {totals.unassignedItems}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  بنود مصنّفة بلا مسؤول (تصنيف بلا مالك)
                </div>
              </div>
              <div className="bg-card border border-border rounded-lg p-3">
                <div
                  className={`text-lg font-semibold ${totals.unclassifiedItems ? "text-amber-600" : "text-foreground"}`}
                >
                  {totals.unclassifiedItems}
                </div>
                <div className="text-[11px] text-muted-foreground">بنود غير مصنّفة</div>
              </div>
            </div>
          )}

          {(kpi?.unassigned ?? []).length > 0 && (
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 border-b border-border text-xs font-medium text-amber-700 bg-amber-50">
                بنود مصنّفة بلا مسؤول — تصنيف بلا مالك (ليست ضمن مؤشرات الموظفين أعلاه)
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-right">
                    <th className="px-3 py-2 text-xs font-medium text-muted-foreground">التصنيف</th>
                    <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-center">
                      البنود
                    </th>
                    <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-center">
                      بعروض
                    </th>
                    <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-center">
                      العروض
                    </th>
                    <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-center">
                      تحويل
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(kpi?.unassigned ?? []).map((u) => (
                    <tr
                      key={`unassigned:${u.categoryId ?? "none"}`}
                      className="border-b border-border last:border-0 bg-amber-50/40"
                    >
                      <td className="px-3 py-2 text-xs text-foreground">
                        {u.categoryName ?? "غير مصنّف"}
                      </td>
                      <td className="px-3 py-2 text-center text-xs text-foreground">{u.items}</td>
                      <td className="px-3 py-2 text-center text-xs text-foreground">
                        {u.itemsWithOffers}
                      </td>
                      <td className="px-3 py-2 text-center text-xs text-foreground">
                        {u.offersReceived}
                      </td>
                      <td className="px-3 py-2 text-center text-xs text-foreground">
                        {u.convertedItems}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ────────────────── procurement employee performance section ──────────────────

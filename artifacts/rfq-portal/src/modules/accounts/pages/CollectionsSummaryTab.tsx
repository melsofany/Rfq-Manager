import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Banknote, AlertCircle, Clock, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

interface AlertRow {
  customerPoId: number;
  internalPoNo: string;
  customerPoNo: string;
  customerName: string | null;
  receivable: string | null;
  remaining: string | null;
  dueDate: string | null;
  daysLate?: number | null;
}

interface Alerts {
  dueSoonCount: number;
  overdueCount: number;
  dueSoon: AlertRow[];
  overdue: AlertRow[];
}

function fmt(n: string | null): string {
  if (n == null) return "-";
  return Number(n).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function CollectionsSummaryTab() {
  const [data, setData] = useState<Alerts | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/collections/alerts", { credentials: "include" });
      if (!r.ok) throw new Error();
      setData(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل تنبيهات التحصيل"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          نظرة عامة على التحصيلات المتأخرة والقريبة من الاستحقاق
        </p>
        <Link href="/collections">
          <Button variant="outline" size="sm" className="gap-1.5">
            إدارة التحصيلات <ArrowLeft size={14} />
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle size={22} className="text-red-600" />
          <div>
            <p className="text-xs text-red-700">متأخرات عن الاستحقاق</p>
            <p className="text-2xl font-bold text-red-700">{loading ? "..." : data?.overdueCount ?? 0}</p>
          </div>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center gap-3">
          <Clock size={22} className="text-amber-600" />
          <div>
            <p className="text-xs text-amber-700">قريب الاستحقاق (7 أيام)</p>
            <p className="text-2xl font-bold text-amber-700">{loading ? "..." : data?.dueSoonCount ?? 0}</p>
          </div>
        </div>
      </div>

      {/* Overdue list */}
      {data && data.overdue.length > 0 && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-red-50 border-b border-red-200 text-xs font-medium text-red-700 flex items-center gap-1.5">
            <AlertCircle size={14} />
            متأخرات ({data.overdue.length})
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left">
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">أمر الشراء</th>
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">العميل</th>
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">المتبقي</th>
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">الاستحقاق</th>
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">أيام التأخير</th>
              </tr>
            </thead>
            <tbody>
              {data.overdue.map((r) => (
                <tr key={r.customerPoId} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-mono text-xs text-primary">
                    <Link href="/collections">{r.internalPoNo}</Link>
                  </td>
                  <td className="px-3 py-2 text-xs">{r.customerName ?? "-"}</td>
                  <td className="px-3 py-2 text-xs font-medium text-amber-600">{fmt(r.remaining)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.dueDate ?? "-"}</td>
                  <td className="px-3 py-2 text-xs text-red-600 font-medium">{r.daysLate ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Due soon list */}
      {data && data.dueSoon.length > 0 && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-xs font-medium text-amber-700 flex items-center gap-1.5">
            <Clock size={14} />
            قريب الاستحقاق ({data.dueSoon.length})
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left">
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">أمر الشراء</th>
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">العميل</th>
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">المتبقي</th>
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">الاستحقاق</th>
              </tr>
            </thead>
            <tbody>
              {data.dueSoon.map((r) => (
                <tr key={r.customerPoId} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-mono text-xs text-primary">{r.internalPoNo}</td>
                  <td className="px-3 py-2 text-xs">{r.customerName ?? "-"}</td>
                  <td className="px-3 py-2 text-xs font-medium text-amber-600">{fmt(r.remaining)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.dueDate ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.overdue.length === 0 && data.dueSoon.length === 0 && !loading && (
        <div className="p-8 text-center">
          <Banknote size={36} className="mx-auto text-emerald-400 mb-2" />
          <p className="text-sm text-muted-foreground">لا توجد تحصيلات متأخرة أو قريبة من الاستحقاق</p>
        </div>
      )}
    </div>
  );
}

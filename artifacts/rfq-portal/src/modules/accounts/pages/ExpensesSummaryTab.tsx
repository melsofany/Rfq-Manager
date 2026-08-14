import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { Wallet, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

interface CategoryTotal {
  category: string;
  total: string | null;
  count: number;
}

interface Summary {
  from: string | null;
  to: string | null;
  grandTotal: string | null;
  categoryCount: number;
  byCategory: CategoryTotal[];
}

function fmt(n: string | number | null | undefined): string {
  if (n == null) return "-";
  return Number(n).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function ExpensesSummaryTab() {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    try {
      const r = await fetch(`/api/expenses/summary?${params.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error();
      setData(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل ملخص المصروفات"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">من تاريخ</label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-sm" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">إلى تاريخ</label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-sm" />
        </div>
        <Button onClick={load} size="sm" className="gap-1.5">تحديث</Button>
        <Link href="/expenses" className="ml-auto">
          <Button variant="outline" size="sm" className="gap-1.5">
            إدارة المصروفات <ArrowLeft size={14} />
          </Button>
        </Link>
      </div>

      <div className="bg-card border border-border rounded-lg p-4 flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground flex items-center gap-1.5">
            <Wallet size={16} className="text-primary" />
            إجمالي المصروفات التشغيلية للفترة
          </p>
          {data && (
            <p className="text-xs text-muted-foreground mt-0.5">{data.categoryCount} نوع</p>
          )}
        </div>
        <span className="text-2xl font-bold text-foreground">
          {loading ? "..." : fmt(data?.grandTotal)}
        </span>
      </div>

      {data && data.byCategory.length > 0 && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left">
                <th className="px-3 py-3 text-muted-foreground text-xs font-medium">النوع</th>
                <th className="px-3 py-3 text-muted-foreground text-xs font-medium">عدد المصروفات</th>
                <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {data.byCategory.map((c) => (
                <tr key={c.category} className="border-b border-border last:border-0">
                  <td className="px-3 py-3 text-xs font-medium">{c.category}</td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">{c.count}</td>
                  <td className="px-3 py-3 text-xs font-semibold">{fmt(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

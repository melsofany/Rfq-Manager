import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Wallet, Landmark, TrendingDown, TrendingUp, AlertTriangle, Clock, FileText } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";
import { Link } from "wouter";

interface Dashboard {
  totalAP: string | null;
  totalAR: string | null;
  cash: string | null;
  bank: string | null;
  pendingDrafts: number;
  recentEntries: Array<{ id: number; entryNo: string; entryDate: string; description: string; totalDebit: string | null }>;
}

export default function DashboardTab() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/accounts/dashboard", { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل لوحة المحاسب");
      setData(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل لوحة المحاسب"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading || !data) {
    return <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>;
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card label="ذمم الموردين (مستحق)" value={data.totalAP ?? "-"} icon={<TrendingDown size={16} className="text-red-600" />} tone="loss" />
        <Card label="ذمم العملاء (متحصّل)" value={data.totalAR ?? "-"} icon={<TrendingUp size={16} className="text-emerald-600" />} tone="profit" />
        <Card label="رصيد النقدية" value={data.cash ?? "-"} icon={<Wallet size={16} className="text-primary" />} />
        <Card label="رصيد البنك" value={data.bank ?? "-"} icon={<Landmark size={16} className="text-primary" />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-card border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Clock size={16} className="text-amber-600" />
              قيود بانتظار المراجعة والترحيل
            </h3>
            <span className="text-2xl font-bold text-amber-600">{data.pendingDrafts}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            قيود اليومية في حالة مسودة تحتاج مراجعة المحاسب قبل ترحيلها إلى دفتر الأستاذ.
          </p>
          <Link to="/accounts?tab=journal">
            <Button size="sm" variant="outline" className="gap-1.5">
              <FileText size={14} /> مراجعة القيود
            </Button>
          </Link>
        </div>

        <div className="bg-card border border-border rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <AlertTriangle size={16} className="text-primary" /> أحدث القيود المرحّلة
          </h3>
          {data.recentEntries.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">لا توجد قيود مرحّلة بعد</p>
          ) : (
            <div className="space-y-2">
              {data.recentEntries.map((e) => (
                <div key={e.id} className="flex items-center justify-between text-xs border-b border-border last:border-0 pb-2 last:pb-0">
                  <div className="min-w-0">
                    <div className="font-mono text-primary truncate">{e.entryNo}</div>
                    <div className="text-muted-foreground truncate">{e.description}</div>
                  </div>
                  <div className="text-left">
                    <div className="font-medium">{e.totalDebit ?? "-"}</div>
                    <div className="text-muted-foreground">{e.entryDate}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ label, value, icon, tone }: { label: string; value: string; icon?: React.ReactNode; tone?: "profit" | "loss" }) {
  const toneClass = tone === "loss" ? "text-red-600" : tone === "profit" ? "text-emerald-600" : "text-foreground";
  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        {icon}
      </div>
      <div className={`text-lg font-bold ${toneClass}`}>{value}</div>
    </div>
  );
}

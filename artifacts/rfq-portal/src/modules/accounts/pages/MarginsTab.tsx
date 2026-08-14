import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown, AlertTriangle, Calculator } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

interface MarginLine {
  customerPoId: number;
  internalPoNo: string;
  customerPoNo: string | null;
  customerName: string | null;
  poDate: string | null;
  poStatus: string;
  customerPoItemId: number;
  lineItem: string | null;
  partNo: string | null;
  description: string;
  uom: string | null;
  sellQty: string | null;
  sellUnitPrice: string | null;
  deliveryStatus: string | null;
  acceptedQty: string | null;
  finalActualCost: string | null;
  supplierLineStatus: string | null;
  revenue: string | null;
  cost: string | null;
  margin: string | null;
  marginPct: string | null;
  isLoss: boolean;
}

interface Summary {
  lineCount: number;
  pricedLines: number;
  lossLines: number;
  totalRevenue: string | null;
  totalCost: string | null;
  totalMargin: string | null;
  marginPct: string | null;
}

export default function MarginsTab() {
  const [lines, setLines] = useState<MarginLine[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [customerName, setCustomerName] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [onlyLoss, setOnlyLoss] = useState(false);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (customerName) params.set("customerName", customerName);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (onlyLoss) params.set("onlyLoss", "true");
    const qs = params.toString();
    try {
      const [mRes, sRes] = await Promise.all([
        fetch(`/api/accounts/margins${qs ? `?${qs}` : ""}`, { credentials: "include" }),
        fetch(`/api/accounts/margins/summary${qs ? `?${qs}` : ""}`, {
          credentials: "include",
        }),
      ]);
      if (!mRes.ok || !sRes.ok) throw new Error("فشل تحميل بيانات الحسابات");
      setLines(await mRes.json());
      setSummary(await sRes.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل الحسابات"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5">
      <div>
          <p className="text-muted-foreground text-sm">
            مقارنة سعر البيع للعميل بالتكلفة الفعلية من المورد لكل بند، وإبراز البنود الخاسرة
          </p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SummaryCard
            label="إجمالي الإيرادات"
            value={summary?.totalRevenue ?? "-"}
            icon={<TrendingUp size={16} className="text-emerald-600" />}
          />
          <SummaryCard
            label="إجمالي التكلفة"
            value={summary?.totalCost ?? "-"}
            icon={<TrendingDown size={16} className="text-blue-600" />}
          />
          <SummaryCard
            label="صافي الهامش"
            value={summary?.totalMargin ?? "-"}
            tone={Number(summary?.totalMargin ?? 0) < 0 ? "loss" : "profit"}
            sub={summary?.marginPct ? `${summary.marginPct}%` : undefined}
          />
          <SummaryCard
            label="بنود خاسرة"
            value={String(summary?.lossLines ?? 0)}
            icon={<AlertTriangle size={16} className="text-red-600" />}
            tone={Number(summary?.lossLines ?? 0) > 0 ? "loss" : undefined}
          />
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex-1 max-w-xs">
            <label className="text-xs text-muted-foreground mb-1 block">اسم العميل</label>
            <Input
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="بحث بالعميل"
              className="h-8 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">من تاريخ</label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">إلى تاريخ</label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground h-8">
            <input
              type="checkbox"
              checked={onlyLoss}
              onChange={(e) => setOnlyLoss(e.target.checked)}
              className="accent-primary"
            />
            البنود الخاسرة فقط
          </label>
          <Button onClick={load} size="sm" className="gap-1.5">
            تحديث
          </Button>
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
          ) : lines.length === 0 ? (
            <div className="p-12 text-center">
              <Calculator size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground text-sm">لا توجد بيانات هامش متاحة</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-left">
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">أمر شراء العميل</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">رقم أمر العميل</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">العميل</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">البند</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">كمية البيع</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">سعر البيع</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">كمية مستلمة</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">التكلفة الفعلية</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الإيراد</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">التكلفة</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الهامش</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">%</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr
                      key={`${l.customerPoId}-${l.customerPoItemId}`}
                      className={`border-b border-border last:border-0 ${
                        l.isLoss ? "bg-red-50/40" : ""
                      }`}
                    >
                      <td className="px-3 py-3 font-mono text-xs text-primary">
                        {l.internalPoNo}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-foreground">
                        {l.customerPoNo ?? "-"}
                      </td>
                      <td className="px-3 py-3 text-xs text-foreground">{l.customerName ?? "-"}</td>
                      <td className="px-3 py-3">
                        <div className="text-xs text-foreground">{l.description}</div>
                        {l.lineItem && (
                          <div className="text-muted-foreground text-xs font-mono">{l.lineItem}</div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs">{l.sellQty ?? "-"}</td>
                      <td className="px-3 py-3 text-xs">{l.sellUnitPrice ?? "-"}</td>
                      <td className="px-3 py-3 text-xs">{l.acceptedQty ?? "-"}</td>
                      <td className="px-3 py-3 text-xs">
                        {l.finalActualCost ?? "-"}
                      </td>
                      <td className="px-3 py-3 text-xs">{l.revenue ?? "-"}</td>
                      <td className="px-3 py-3 text-xs">{l.cost ?? "-"}</td>
                      <td
                        className={`px-3 py-3 text-xs font-medium ${
                          l.margin == null
                            ? "text-muted-foreground"
                            : Number(l.margin) < 0
                              ? "text-red-600"
                              : "text-emerald-600"
                        }`}
                      >
                        {l.margin ?? "-"}
                      </td>
                      <td className="px-3 py-3 text-xs text-muted-foreground">
                        {l.marginPct != null ? `${l.marginPct}%` : "-"}
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

function SummaryCard({
  label,
  value,
  sub,
  icon,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
  tone?: "profit" | "loss";
}) {
  const toneClass =
    tone === "loss"
      ? "text-red-600"
      : tone === "profit"
        ? "text-emerald-600"
        : "text-foreground";
  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        {icon}
      </div>
      <div className={`text-lg font-bold ${toneClass}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

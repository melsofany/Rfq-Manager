import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ShieldCheck, Banknote } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";
import { api, queryString } from "@/lib/accounts-api";
import { fmtMoney as fmt } from "@/lib/format";
import { TotalCard } from "../components/ui";

interface WithholdingLine {
  poId: number;
  internalPoNo: string;
  sheetPoNo: string;
  supplierName: string | null;
  poDate: string | null;
  status: string;
  netValue: number;
  rate: number;
  withholding: number;
  payableToSupplier: number;
}

interface WithholdingReport {
  withholdingRate: number;
  withholdingRateServices: number;
  withholdingRatePurchases: number;
  from: string | null;
  to: string | null;
  totalNet: number;
  totalWithholding: number;
  totalPayable: number;
  lines: WithholdingLine[];
}

export default function WithholdingTab() {
  const [data, setData] = useState<WithholdingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  async function load() {
    setLoading(true);
    const qs = queryString({ from, to });
    try {
      setData(await api.get<WithholdingReport>(`/api/accounts/withholding${qs}`));
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل الخصم تحت حساب المورد"));
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
      <p className="text-muted-foreground text-sm">
        الخصم تحت حساب المورد — مبنيّ على فواتير الموردين المُرحَّلة: يُخصم{" "}
        {data?.withholdingRate ?? 3}%؜ من قيمة كل فاتورة للمورد ويُورَّد لمصلحة الضرائب نيابةً عنه.
        النسبة للخدمات {data?.withholdingRateServices ?? 5}%؜ وللمشتريات/التوريدات{" "}
        {data?.withholdingRatePurchases ?? 1}%؜ (جدول الضرائب المصري).
      </p>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <TotalCard
          label="إجمالي صافي المشتريات"
          value={fmt(data?.totalNet)}
          icon={<Banknote size={16} className="text-blue-600" />}
        />
        <TotalCard
          label="إجمالي الخصم"
          value={fmt(data?.totalWithholding)}
          icon={<ShieldCheck size={16} className="text-amber-600" />}
          tone="highlight"
        />
        <TotalCard
          label="المستحق للموردين"
          value={fmt(data?.totalPayable)}
          icon={<Banknote size={16} className="text-emerald-600" />}
        />
      </div>

      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">من تاريخ</label>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-8 text-sm w-40"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">إلى تاريخ</label>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-8 text-sm w-40"
          />
        </div>
        <Button onClick={load} size="sm" className="gap-1.5">
          تحديث
        </Button>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
        ) : (data?.lines ?? []).length === 0 ? (
          <div className="p-12 text-center">
            <ShieldCheck size={40} className="mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-muted-foreground text-sm">
              لا توجد فواتير موردين مُرحَّلة ضمن الفترة
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">
                    فاتورة المورد
                  </th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">المورد</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">التاريخ</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">
                    صافي القيمة
                  </th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">النسبة</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الخصم</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">
                    المستحق للمورد
                  </th>
                </tr>
              </thead>
              <tbody>
                {(data?.lines ?? []).map((l) => (
                  <tr
                    key={l.poId}
                    className="border-b border-border last:border-0 hover:bg-muted/20"
                  >
                    <td className="px-3 py-3 font-mono text-xs text-primary">
                      {l.sheetPoNo || l.internalPoNo}
                    </td>
                    <td className="px-3 py-3 text-xs">{l.supplierName ?? "-"}</td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">{l.poDate ?? "-"}</td>
                    <td className="px-3 py-3 text-xs">{fmt(l.netValue)}</td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">{l.rate}%؜</td>
                    <td className="px-3 py-3 text-xs font-medium text-amber-600">
                      {fmt(l.withholding)}
                    </td>
                    <td className="px-3 py-3 text-xs font-medium text-emerald-600">
                      {fmt(l.payableToSupplier)}
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

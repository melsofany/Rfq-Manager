import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Receipt, ArrowUpCircle, ArrowDownCircle, Scale } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

interface VatLine {
  date: string | null;
  party: string | null;
  document: string | null;
  net: number;
  vat: number;
  gross: number;
}

interface VatStatement {
  vatRate: number;
  from: string | null;
  to: string | null;
  output: { net: number; vat: number };
  input: { net: number; vat: number };
  netVat: number;
  payable: number;
  credit: number;
  outputLines: VatLine[];
  inputLines: VatLine[];
}

export default function VatTab() {
  const [data, setData] = useState<VatStatement | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    try {
      const r = await fetch(`/api/accounts/vat${qs ? `?${qs}` : ""}`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error("فشل تحميل بيانات الضريبة");
      setData(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل الضريبة"));
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
        إقرار ضريبة القيمة المضافة (القانون 67 لسنة 2016) — مبنيّ على الفواتير المُرحَّلة: ضريبة
        المبيعات (الإخراج) من فواتير العملاء ناقص ضريبة المشتريات (الإدخال) من فواتير الموردين
        عند النسبة {data?.vatRate ?? 14}%؜. الفواتير غير المُرحَّلة (مسودة/ملغاة) غير مشمولة.
      </p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryCard
          label="ضريبة المبيعات"
          value={fmt(data?.output.vat)}
          icon={<ArrowUpCircle size={16} className="text-emerald-600" />}
        />
        <SummaryCard
          label="ضريبة المشتريات"
          value={fmt(data?.input.vat)}
          icon={<ArrowDownCircle size={16} className="text-blue-600" />}
        />
        <SummaryCard
          label="صافي الضريبة المستحقة"
          value={fmt(data?.netVat)}
          tone={Number(data?.netVat ?? 0) < 0 ? "credit" : "payable"}
          icon={<Scale size={16} className="text-primary" />}
        />
        <SummaryCard
          label="دائن (مُرحَّل)"
          value={fmt(data?.credit)}
          icon={<Receipt size={16} className="text-amber-600" />}
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <VatSection
          title="ضريبة المبيعات (الإخراج)"
          rows={data?.outputLines ?? []}
          loading={loading}
          total={data?.output.vat}
        />
        <VatSection
          title="ضريبة المشتريات (الإدخال)"
          rows={data?.inputLines ?? []}
          loading={loading}
          total={data?.input.vat}
        />
      </div>
    </div>
  );
}

function VatSection({
  title,
  rows,
  loading,
  total,
}: {
  title: string;
  rows: VatLine[];
  loading: boolean;
  total?: number;
}) {
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center justify-between">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">
          الإجمالي: {fmt(total)}
        </span>
      </div>
      {loading ? (
        <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-muted-foreground text-sm">لا توجد بنود</div>
      ) : (
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-left">
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">التاريخ</th>
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">الطرف</th>
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">المستند</th>
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">الصافي</th>
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">الضريبة</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 text-xs text-muted-foreground">{l.date ?? "-"}</td>
                  <td className="px-3 py-2 text-xs">{l.party ?? "-"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-foreground">
                    {l.document ?? "-"}
                  </td>
                  <td className="px-3 py-2 text-xs">{fmt(l.net)}</td>
                  <td className="px-3 py-2 text-xs font-medium">{fmt(l.vat)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function fmt(n: number | null | undefined): string {
  if (n == null) return "-";
  return n.toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  tone?: "payable" | "credit";
}) {
  const toneClass =
    tone === "credit"
      ? "text-amber-600"
      : tone === "payable"
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

import { useCallback, useEffect, useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Receipt, Truck, RefreshCw, Wallet } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";
import ExpensesPage from "@/modules/expenses/pages";

interface PoCharge {
  id: number;
  poId: number;
  internalPoNo: string | null;
  sheetPoNo: string | null;
  supplierName: string | null;
  lineItem: string | null;
  partNo: string | null;
  chargeType: string;
  description: string | null;
  amount: string;
  createdAt: string;
}

interface PoCharges {
  total: string;
  count: number;
  byType: Array<{ type: string; amount: string }>;
  charges: PoCharge[];
}

function money(v: string | null | undefined): string {
  if (v == null || v === "") return "-";
  return Number(v).toLocaleString("ar-EG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * المصاريف والتكاليف — every cost the company bears.
 *
 *  • المصاريف التشغيلية — electricity, internet, water, domains, subscriptions,
 *    transport, misc., … (the operating-expenses ledger, with attachments).
 *  • تكاليف أوامر الشراء — freight / customs / loading / storage charges tied
 *    to supplier PO lines, so the true landed cost of each line is visible.
 */
export default function ExpensesAndCostsTab() {
  return (
    <Tabs defaultValue="operating">
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="operating" className="text-xs gap-1.5">
          <Wallet size={14} /> المصاريف التشغيلية
        </TabsTrigger>
        <TabsTrigger value="po-charges" className="text-xs gap-1.5">
          <Truck size={14} /> تكاليف أوامر الشراء
        </TabsTrigger>
      </TabsList>
      <TabsContent value="operating" className="mt-5">
        <ExpensesPage />
      </TabsContent>
      <TabsContent value="po-charges" className="mt-5">
        <PoChargesPanel />
      </TabsContent>
    </Tabs>
  );
}

function PoChargesPanel() {
  const [data, setData] = useState<PoCharges | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/accounts/po-charges", { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل تكاليف أوامر الشراء");
      setData(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل تكاليف أوامر الشراء"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          تكاليف مرتبطة ببنود أوامر الشراء (نقل، شحن، جمارك، تحميل، تنزيل، تخزين، تأمين…) — تُضاف
          إلى التكلفة الفعلية للبند عند حساب الهامش المحقق.
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> تحديث
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg border border-border bg-card p-3.5">
          <div className="text-xs text-muted-foreground mb-1">إجمالي تكاليف أوامر الشراء</div>
          <div className="text-lg font-bold tabular-nums">{money(data?.total)}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3.5">
          <div className="text-xs text-muted-foreground mb-1">عدد التكاليف</div>
          <div className="text-lg font-bold tabular-nums">{data?.count ?? 0}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3.5">
          <div className="text-xs text-muted-foreground mb-1">أعلى نوع تكلفة</div>
          <div className="text-sm font-medium">
            {data?.byType[0] ? `${data.byType[0].type} — ${money(data.byType[0].amount)}` : "-"}
          </div>
        </div>
      </div>

      {(data?.byType.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-2">
          {data!.byType.map((t) => (
            <span
              key={t.type}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs"
            >
              <span className="text-muted-foreground">{t.type}</span>
              <span className="font-medium tabular-nums">{money(t.amount)}</span>
            </span>
          ))}
        </div>
      )}

      {loading && !data ? (
        <Empty text="جارٍ التحميل..." />
      ) : (data?.charges.length ?? 0) === 0 ? (
        <Empty text="لا توجد تكاليف مرتبطة بأوامر شراء بعد" />
      ) : (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="text-right p-2.5 font-medium">أمر الشراء</th>
                <th className="text-right p-2.5 font-medium">المورد</th>
                <th className="text-right p-2.5 font-medium">البند</th>
                <th className="text-right p-2.5 font-medium">نوع التكلفة</th>
                <th className="text-right p-2.5 font-medium">البيان</th>
                <th className="text-right p-2.5 font-medium">المبلغ</th>
              </tr>
            </thead>
            <tbody>
              {data!.charges.map((c) => (
                <tr key={c.id} className="border-t border-border hover:bg-muted/30">
                  <td className="p-2.5">
                    <div className="font-medium">{c.sheetPoNo ?? c.internalPoNo ?? "-"}</div>
                    {c.internalPoNo && c.sheetPoNo && (
                      <div className="text-[11px] text-muted-foreground">{c.internalPoNo}</div>
                    )}
                  </td>
                  <td className="p-2.5">{c.supplierName ?? "-"}</td>
                  <td className="p-2.5">
                    <div>{c.partNo ?? c.lineItem ?? "-"}</div>
                  </td>
                  <td className="p-2.5">
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-xs">
                      <Receipt size={11} /> {c.chargeType}
                    </span>
                  </td>
                  <td className="p-2.5 text-xs text-muted-foreground">{c.description ?? "-"}</td>
                  <td className="p-2.5 tabular-nums font-medium">{money(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="py-12 text-center text-muted-foreground text-sm border border-dashed border-border rounded-lg">
      {text}
    </div>
  );
}

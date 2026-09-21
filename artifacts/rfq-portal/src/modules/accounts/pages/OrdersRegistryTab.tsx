import { useCallback, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ShoppingCart,
  Truck,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  FileText,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";
import { money } from "@/lib/format";
import { api } from "@/lib/accounts-api";
import { Empty, TotalCard } from "../components/ui";

interface CustomerOrder {
  id: number;
  internalPoNo: string;
  customerPoNo: string;
  customerName: string | null;
  poDate: string | null;
  status: string;
  totalItems: number;
  deliveredItems: number;
  invoiceNo: string | null;
  invoiceId: number | null;
  net: string;
  vat: string;
  gross: string;
  cost: string;
  /** True when no goods were received yet, so cost comes from the supplier PO price. */
  costEstimated: boolean;
  margin: string;
  marginPct: string | null;
  isLoss: boolean;
}

interface SupplierOrder {
  id: number;
  internalPoNo: string;
  sheetPoNo: string;
  supplierNames: string[];
  status: string;
  totalItems: number;
  receivedItems: number;
  cost: string;
  invoiceNo: string | null;
  invoiceNet: string;
  invoiceVat: string;
  hasVat: boolean;
  createdAt: string;
}

interface CollectedOrders {
  vatRate: number;
  customerOrders: CustomerOrder[];
  supplierOrders: SupplierOrder[];
  totals: {
    customerOrders: number;
    supplierOrders: number;
    net: string;
    vat: string;
    cost: string;
    margin: string;
    marginPct: string | null;
  };
}

/**
 * سجل الحركات المكتملة — the accounting registry.
 *
 * An order appears here only once it is delivered / settled: a customer order
 * once a posted sales invoice exists or a line was delivered, a supplier order
 * once goods were received or a posted supplier invoice exists. Orders still in
 * progress are intentionally absent — the operational pages own those.
 */
export default function OrdersRegistryTab() {
  const [data, setData] = useState<CollectedOrders | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<CollectedOrders>("/api/accounts/collected-orders"));
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل سجل الحركات"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const s = search.trim().toLowerCase();
  const customerOrders = (data?.customerOrders ?? []).filter(
    (o) =>
      !s ||
      o.internalPoNo.toLowerCase().includes(s) ||
      o.customerPoNo.toLowerCase().includes(s) ||
      (o.customerName ?? "").toLowerCase().includes(s) ||
      (o.invoiceNo ?? "").toLowerCase().includes(s),
  );
  const supplierOrders = (data?.supplierOrders ?? []).filter(
    (o) =>
      !s ||
      o.internalPoNo.toLowerCase().includes(s) ||
      o.sheetPoNo.toLowerCase().includes(s) ||
      o.supplierNames.some((n) => n.toLowerCase().includes(s)) ||
      (o.invoiceNo ?? "").toLowerCase().includes(s),
  );

  return (
    <div className="space-y-5">
      <p className="text-muted-foreground text-sm">
        لا يظهر أمر الشراء في هذه الصفحة إلا بعد تسليمه/استلامه فعليًا (أو ترحيل فاتورته). الأوامر
        الجارية تبقى في صفحاتها التشغيلية، وهنا تظهر القيم المحاسبية النهائية — البيع بضريبة القيمة
        المضافة {data?.vatRate ?? 14}% والتكلفة الفعلية والهامش المحقق.
      </p>

      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1 max-w-sm">
          <label className="text-xs text-muted-foreground mb-1 block">بحث</label>
          <div className="relative">
            <Search
              size={14}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="رقم الأمر / العميل / المورد / الفاتورة"
              className="h-8 text-sm pr-8"
            />
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> تحديث
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <TotalCard label="إجمالي البيع (بدون ضريبة)" value={money(data?.totals.net)} />
        <TotalCard label="ض.ق.م. المخرجات" value={money(data?.totals.vat)} tone="vat" />
        <TotalCard label="التكلفة الفعلية" value={money(data?.totals.cost)} />
        <TotalCard
          label="الهامش المحقق"
          value={money(data?.totals.margin)}
          sub={data?.totals.marginPct ? `${data.totals.marginPct}%` : undefined}
          tone={Number(data?.totals.margin ?? 0) < 0 ? "loss" : "profit"}
        />
      </div>

      <Tabs defaultValue="customer">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="customer" className="text-xs gap-1.5">
            <ShoppingCart size={14} /> أوامر شراء العملاء
            <span className="text-[10px] text-muted-foreground">
              ({data?.totals.customerOrders ?? 0})
            </span>
          </TabsTrigger>
          <TabsTrigger value="supplier" className="text-xs gap-1.5">
            <Truck size={14} /> أوامر شراء الموردين
            <span className="text-[10px] text-muted-foreground">
              ({data?.totals.supplierOrders ?? 0})
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="customer" className="mt-4">
          <CustomerOrdersTable rows={customerOrders} loading={loading} />
        </TabsContent>
        <TabsContent value="supplier" className="mt-4">
          <SupplierOrdersTable rows={supplierOrders} loading={loading} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CustomerOrdersTable({ rows, loading }: { rows: CustomerOrder[]; loading: boolean }) {
  if (loading && rows.length === 0) return <Empty text="جارٍ التحميل..." />;
  if (rows.length === 0) return <Empty text="لا توجد أوامر شراء عملاء مُسلَّمة بعد" />;
  return (
    <div className="overflow-x-auto border border-border rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="text-right p-2.5 font-medium">أمر الشراء</th>
            <th className="text-right p-2.5 font-medium">العميل</th>
            <th className="text-right p-2.5 font-medium">التسليم</th>
            <th className="text-right p-2.5 font-medium">فاتورة البيع</th>
            <th className="text-right p-2.5 font-medium">الصافي</th>
            <th className="text-right p-2.5 font-medium">ض.ق.م.</th>
            <th className="text-right p-2.5 font-medium">الإجمالي</th>
            <th className="text-right p-2.5 font-medium">التكلفة الفعلية</th>
            <th className="text-right p-2.5 font-medium">التكلفة التقديرية</th>
            <th className="text-right p-2.5 font-medium">الهامش</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id} className="border-t border-border hover:bg-muted/30">
              <td className="p-2.5">
                <div className="font-medium">{o.customerPoNo}</div>
                <div className="text-[11px] text-muted-foreground">{o.internalPoNo}</div>
              </td>
              <td className="p-2.5">{o.customerName ?? "-"}</td>
              <td className="p-2.5 text-xs">
                <span className="text-muted-foreground">
                  {o.deliveredItems}/{o.totalItems} بند
                </span>
              </td>
              <td className="p-2.5">
                {o.invoiceNo ? (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                    <FileText size={12} /> {o.invoiceNo}
                  </span>
                ) : (
                  <span className="text-xs text-amber-600">بدون فاتورة مُرحَّلة</span>
                )}
              </td>
              <td className="p-2.5 tabular-nums">{money(o.net)}</td>
              <td className="p-2.5 tabular-nums">{money(o.vat)}</td>
              <td className="p-2.5 tabular-nums font-medium">{money(o.gross)}</td>
              <td className="p-2.5 tabular-nums">
              {!o.costEstimated ? money(o.cost) : "-"}
            </td>
            <td className="p-2.5 tabular-nums">
              {o.costEstimated ? money(o.cost) : "-"}
            </td>
              <td className="p-2.5 tabular-nums">
                <span
                  className={`inline-flex items-center gap-1 font-medium ${
                    o.isLoss ? "text-rose-600" : "text-emerald-600"
                  }`}
                >
                  {o.isLoss ? <TrendingDown size={12} /> : <TrendingUp size={12} />}
                  {money(o.margin)}
                  {o.marginPct && (
                    <span className="text-[10px] text-muted-foreground">({o.marginPct}%)</span>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SupplierOrdersTable({ rows, loading }: { rows: SupplierOrder[]; loading: boolean }) {
  if (loading && rows.length === 0) return <Empty text="جارٍ التحميل..." />;
  if (rows.length === 0) return <Empty text="لا توجد أوامر شراء موردين مُستلَمة بعد" />;
  return (
    <div className="overflow-x-auto border border-border rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="text-right p-2.5 font-medium">أمر الشراء</th>
            <th className="text-right p-2.5 font-medium">المورد</th>
            <th className="text-right p-2.5 font-medium">الاستلام</th>
            <th className="text-right p-2.5 font-medium">فاتورة المورد</th>
            <th className="text-right p-2.5 font-medium">التكلفة الفعلية</th>
            <th className="text-right p-2.5 font-medium">صافي الفاتورة</th>
            <th className="text-right p-2.5 font-medium">ض.ق.م. مدخلات</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id} className="border-t border-border hover:bg-muted/30">
              <td className="p-2.5">
                <div className="font-medium">{o.sheetPoNo}</div>
                <div className="text-[11px] text-muted-foreground">{o.internalPoNo}</div>
              </td>
              <td className="p-2.5">{o.supplierNames.length ? o.supplierNames.join("، ") : "-"}</td>
              <td className="p-2.5 text-xs">
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <CheckCircle2 size={12} />
                  {o.receivedItems}/{o.totalItems} بند
                </span>
              </td>
              <td className="p-2.5">
                {o.invoiceNo ? (
                  <span className="text-xs text-emerald-600">{o.invoiceNo}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </td>
              <td className="p-2.5 tabular-nums font-medium">{money(o.cost)}</td>
              <td className="p-2.5 tabular-nums">{money(o.invoiceNet)}</td>
              <td className="p-2.5 tabular-nums">
                {o.hasVat ? (
                  money(o.invoiceVat)
                ) : (
                  <span className="text-[11px] text-rose-600">بدون ض.ق.م (عجز)</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

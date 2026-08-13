import { useState } from "react";
import { useListCustomerPos, getListCustomerPosQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Truck, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

interface CustomerPoItemRow {
  id: number;
  customerPoId: number;
  lineItem: string | null;
  partNo: string | null;
  description: string;
  uom: string | null;
  qty: string | null;
  unitPrice: string | null;
  deliveryDate: string | null;
  deliveryStatus: string;
  totalDeliveredQty: string | null;
  totalRejectedByCustomerQty: string | null;
}

const DELIVERY_STATUS_LABEL: Record<string, string> = {
  pending: "بانتظار التسليم",
  partial: "تسليم جزئي",
  delivered: "تم التسليم",
  rejected: "مرفوض من العميل",
};

function statusTone(status: string): string {
  switch (status) {
    case "delivered":
      return "text-emerald-600";
    case "partial":
      return "text-amber-600";
    case "rejected":
      return "text-red-600";
    default:
      return "text-muted-foreground";
  }
}

export default function CustomerDeliveriesPage() {
  const [search, setSearch] = useState("");
  const [expandedPo, setExpandedPo] = useState<number | null>(null);
  const [items, setItems] = useState<CustomerPoItemRow[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [deliveries, setDeliveries] = useState<Record<number, DeliveryRow[]>>({});

  const { data: pos, isLoading } = useListCustomerPos(
    { search: search || undefined },
    { query: { queryKey: getListCustomerPosQueryKey({ search: search || undefined }) } },
  );

  async function loadItems(poId: number) {
    setLoadingItems(true);
    try {
      const r = await fetch(`/api/customer-po/${poId}`, { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل بنود أمر شراء العميل");
      const data = await r.json();
      setItems((data.items ?? []) as CustomerPoItemRow[]);
      setExpandedPo(poId);
      const dR = await fetch(`/api/customer-po/${poId}/deliveries`, {
        credentials: "include",
      });
      if (dR.ok) {
        const dData: DeliveryRow[] = await dR.json();
        const map: Record<number, DeliveryRow[]> = {};
        for (const d of dData) {
          (map[d.customerPoItemId] ??= []).push(d);
        }
        setDeliveries(map);
      } else {
        setDeliveries({});
      }
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل البنود"));
    } finally {
      setLoadingItems(false);
    }
  }

  async function saveDelivery(
    poId: number,
    customerPoItemId: number,
    data: { deliveredQty: string; rejectedByCustomerQty: string; rejectionReason: string },
  ) {
    try {
      const r = await fetch(`/api/customer-po/${poId}/deliveries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          customerPoItemId,
          deliveredQty: data.deliveredQty || null,
          rejectedByCustomerQty: data.rejectedByCustomerQty || null,
          rejectionReason: data.rejectionReason || null,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || "فشل حفظ التسليم");
      }
      toast.success("تم حفظ سجل التسليم");
      await loadItems(poId);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل حفظ التسليم"));
    }
  }

  async function deleteDelivery(poId: number, deliveryId: number) {
    try {
      const r = await fetch(`/api/customer-po/deliveries/${deliveryId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || "فشل حذف السجل");
      }
      toast.success("تم حذف سجل التسليم");
      await loadItems(poId);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الحذف"));
    }
  }

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Truck size={20} className="text-primary" />
            تسليمات العملاء
          </h1>
          <p className="text-muted-foreground text-sm">
            تسجيل تسليم بنود أوامر شراء العملاء ومتابعة الرفض والأرصدة
          </p>
        </div>

        <div className="relative max-w-xs">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث برقم أمر الشراء أو العميل..."
            className="pl-8 h-8 text-sm"
          />
        </div>

        <div className="space-y-3">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
          ) : !pos?.length ? (
            <div className="p-12 text-center">
              <Truck size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground text-sm">لا توجد أوامر شراء عملاء للتسليم</p>
            </div>
          ) : (
            pos.map((po) => (
              <div key={po.id} className="bg-card border border-border rounded-lg overflow-hidden">
                <button
                  onClick={() => (expandedPo === po.id ? setExpandedPo(null) : loadItems(po.id))}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/20"
                >
                  <div className="flex items-center gap-3 text-right">
                    {expandedPo === po.id ? (
                      <ChevronLeft size={16} className="text-muted-foreground" />
                    ) : (
                      <ChevronRight size={16} className="text-muted-foreground" />
                    )}
                    <span className="font-mono text-xs text-primary font-medium">
                      {po.internalPoNo}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {po.customerPoNo}
                    </span>
                    {po.customerName && (
                      <span className="text-xs text-muted-foreground">{po.customerName}</span>
                    )}
                  </div>
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${
                      po.status === "sent"
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400"
                        : "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
                    }`}
                  >
                    {po.status === "sent" ? "تم الإرسال" : "مسودة"}
                  </span>
                </button>

                {expandedPo === po.id && (
                  <div className="border-t border-border">
                    {loadingItems ? (
                      <div className="p-6 text-center text-muted-foreground text-sm">
                        جارٍ تحميل البنود...
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border bg-muted/30 text-left">
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium">البند</th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium">الكمية</th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium">الحالة</th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium">مسلّم</th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium">مرفوض من العميل</th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {items.map((it) => (
                              <DeliveryItemRow
                                key={it.id}
                                item={it}
                                rows={deliveries[it.id] ?? []}
                                onSave={(d) => saveDelivery(po.id, it.id, d)}
                                onDelete={(deliveryId) => deleteDelivery(po.id, deliveryId)}
                              />
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </Layout>
  );
}

interface DeliveryRow {
  id: number;
  customerPoItemId: number;
  deliveredQty: number | null;
  rejectedByCustomerQty: number | null;
  rejectionReason: string | null;
  deliveryStatus: string;
  deliveredBy: string | null;
  deliveredAt: string;
}

function DeliveryItemRow({
  item,
  rows,
  onSave,
  onDelete,
}: {
  item: CustomerPoItemRow;
  rows: DeliveryRow[];
  onSave: (d: { deliveredQty: string; rejectedByCustomerQty: string; rejectionReason: string }) => void;
  onDelete: (deliveryId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [deliveredQty, setDeliveredQty] = useState("");
  const [rejectedByCustomerQty, setRejectedByCustomerQty] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");

  return (
    <>
      <tr className="border-b border-border last:border-0">
        <td className="px-4 py-3">
          <div className="font-medium text-foreground text-xs">{item.description}</div>
          {item.lineItem && (
            <div className="text-muted-foreground text-xs font-mono">{item.lineItem}</div>
          )}
        </td>
        <td className="px-4 py-3 text-foreground text-xs">{item.qty ?? "-"}</td>
        <td className={`px-4 py-3 text-xs font-medium ${statusTone(item.deliveryStatus)}`}>
          {DELIVERY_STATUS_LABEL[item.deliveryStatus] ?? item.deliveryStatus}
        </td>
        <td className="px-4 py-3 text-xs text-emerald-600">{item.totalDeliveredQty ?? "-"}</td>
        <td className="px-4 py-3 text-xs text-red-600">
          {item.totalRejectedByCustomerQty ?? "-"}
        </td>
        <td className="px-4 py-3 text-left">
          <Button onClick={() => setOpen((o) => !o)} size="sm" variant="outline" className="h-7 text-xs">
            تسجيل تسليم
          </Button>
        </td>
      </tr>
      {open && (
        <tr className="bg-muted/10">
          <td colSpan={6} className="px-4 py-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">الكمية المسلّمة</label>
                <Input
                  value={deliveredQty}
                  onChange={(e) => setDeliveredQty(e.target.value)}
                  type="number"
                  placeholder={String(item.qty ?? "")}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">مرفوض من العميل</label>
                <Input
                  value={rejectedByCustomerQty}
                  onChange={(e) => setRejectedByCustomerQty(e.target.value)}
                  type="number"
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">سبب الرفض</label>
                <Input
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="تالف/خطأ في الصنف/..."
                  className="h-8 text-sm"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <Button onClick={() => setOpen(false)} size="sm" variant="ghost" className="h-8">
                إلغاء
              </Button>
              <Button
                onClick={() =>
                  onSave({ deliveredQty, rejectedByCustomerQty, rejectionReason })
                }
                size="sm"
                className="h-8"
              >
                حفظ
              </Button>
            </div>
            {rows.length > 0 && (
              <div className="mt-3 border-t border-border pt-2">
                <div className="text-xs text-muted-foreground mb-1">سجلات التسليم السابقة:</div>
                <div className="space-y-1">
                  {rows.map((r) => (
                    <div
                      key={r.id}
                      className="text-xs text-muted-foreground flex items-center gap-3 flex-wrap"
                    >
                      <span>مسلّم: {r.deliveredQty ?? "-"}</span>
                      <span>مرفوض: {r.rejectedByCustomerQty ?? "-"}</span>
                      {r.rejectionReason && <span>السبب: {r.rejectionReason}</span>}
                      {r.deliveredBy && <span>· {r.deliveredBy}</span>}
                      <span>· {new Date(r.deliveredAt).toLocaleDateString()}</span>
                      <button
                        onClick={() => onDelete(r.id)}
                        className="text-red-600 hover:underline mr-1"
                      >
                        حذف
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

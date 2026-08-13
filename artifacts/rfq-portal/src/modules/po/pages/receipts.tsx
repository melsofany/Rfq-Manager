import { useState } from "react";
import { useLocation } from "wouter";
import { useListPurchaseOrders, getListPurchaseOrdersQueryKey } from "@workspace/api-client-react";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, PackageCheck, Truck, Send, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

interface PoItemRow {
  id: number;
  poId: number;
  supplierId: number | null;
  supplierName: string | null;
  lineItem: string | null;
  partNo: string | null;
  description: string;
  uom: string | null;
  qty: number | null;
  referencePrice: number | null;
  customerPoItemId: number | null;
  totalReceivedQty: number | null;
  totalAcceptedQty: number | null;
  totalRejectedQty: number | null;
  finalActualCost: number | null;
  lineStatus: string;
}

const LINE_STATUS_LABEL: Record<string, string> = {
  pending: "بانتظار الاستلام",
  partial: "استلام جزئي",
  fulfilled: "تم الاستلام",
  rejected: "مرفوض",
  postponed: "مؤجّل",
};

function statusTone(status: string): string {
  switch (status) {
    case "fulfilled":
      return "text-emerald-600";
    case "partial":
      return "text-amber-600";
    case "rejected":
      return "text-red-600";
    case "postponed":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

export default function GoodsReceiptPage() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [expandedPo, setExpandedPo] = useState<number | null>(null);
  const [items, setItems] = useState<PoItemRow[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [receipts, setReceipts] = useState<Record<number, ReceiptRow[]>>({});
  const [repPhone, setRepPhone] = useState("");
  const [repName, setRepName] = useState("");
  const [sending, setSending] = useState(false);

  // Only dispatched (sent) POs are eligible for goods receipt.
  const { data: purchaseOrders, isLoading } = useListPurchaseOrders(
    { status: "sent", search: search || undefined },
    {
      query: {
        queryKey: getListPurchaseOrdersQueryKey({
          status: "sent",
          search: search || undefined,
        }),
      },
    },
  );

  async function loadItems(poId: number) {
    setLoadingItems(true);
    try {
      const r = await fetch(`/api/po/${poId}/items`, { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل بنود أمر الشراء");
      const data: PoItemRow[] = await r.json();
      setItems(data);
      setExpandedPo(poId);
      // Load receipts for each item.
      const recR = await fetch(`/api/po/${poId}/receipts`, { credentials: "include" });
      if (recR.ok) {
        const recData: ReceiptRow[] = await recR.json();
        const map: Record<number, ReceiptRow[]> = {};
        for (const rec of recData) {
          (map[rec.poItemId] ??= []).push(rec);
        }
        setReceipts(map);
      } else {
        setReceipts({});
      }
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل البنود"));
    } finally {
      setLoadingItems(false);
    }
  }

  async function saveReceipt(
    poId: number,
    poItemId: number,
    data: { receivedQty: string; acceptedQty: string; rejectedQty: string; rejectionReason: string; actualCost: string },
  ) {
    try {
      const r = await fetch(`/api/po/${poId}/receipts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          poItemId,
          receivedQty: data.receivedQty || null,
          acceptedQty: data.acceptedQty || null,
          rejectedQty: data.rejectedQty || null,
          rejectionReason: data.rejectionReason || null,
          actualCost: data.actualCost || null,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || "فشل حفظ الاستلام");
      }
      toast.success("تم حفظ سجل الاستلام");
      await loadItems(poId);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل حفظ الاستلام"));
    }
  }

  async function postpone(poId: number, poItemId: number) {
    try {
      const r = await fetch(`/api/po/${poId}/receipts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ poItemId, postpone: true }),
      });
      if (!r.ok) throw new Error("فشل تأجيل البند");
      toast.success("تم تأجيل البند");
      await loadItems(poId);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل التأجيل"));
    }
  }

  async function sendReceiptPrompts(poId: number) {
    if (!repPhone.trim() || !repName.trim()) {
      toast.error("أدخل اسم ورقم المندوب أولاً");
      return;
    }
    setSending(true);
    try {
      const r = await fetch(`/api/po/${poId}/send-receipt-prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone: repPhone, representativeName: repName }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "فشل إرسال الطلبات");
      const sent = (body.results as { sent: boolean }[]).filter((x) => x.sent).length;
      toast.success(`تم إرسال ${sent} رسالة استلام للمندوب عبر واتساب`);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الإرسال"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
          <PackageCheck size={20} className="text-primary" />
            استلام التوريدات
          </h1>
          <p className="text-muted-foreground text-sm">
            متابعة استلام بنود أوامر الشراء من الموردين وتسجيل التكلفة الفعلية والرفض
          </p>
        </div>

        <div className="relative max-w-xs">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث برقم أمر الشراء..."
            className="pl-8 h-8 text-sm"
          />
        </div>

        <div className="space-y-3">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
          ) : purchaseOrders?.length === 0 ? (
            <div className="p-12 text-center">
              <Truck size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground text-sm">لا توجد أوامر شراء مُرسلة للاستلام</p>
            </div>
          ) : (
            purchaseOrders?.map((po) => (
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
                    <span className="font-mono text-xs text-muted-foreground">{po.sheetPoNo}</span>
                    {po.receiverName && (
                      <span className="text-xs text-muted-foreground">
                        المندوب: {po.receiverName}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={po.status} />
                    <span className="inline-flex items-center justify-center w-6 h-6 bg-muted rounded text-xs font-medium text-foreground">
                      {po.itemCount}
                    </span>
                  </div>
                </button>

                {expandedPo === po.id && (
                  <div className="border-t border-border">
                    {/* Representative dispatch controls */}
                    <div className="px-4 py-3 bg-muted/20 flex flex-col sm:flex-row sm:items-end gap-3">
                      <div className="flex-1">
                        <label className="text-xs text-muted-foreground mb-1 block">اسم المندوب</label>
                        <Input
                          value={repName}
                          onChange={(e) => setRepName(e.target.value)}
                          placeholder="اسم المستلم"
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="text-xs text-muted-foreground mb-1 block">رقم واتساب</label>
                        <Input
                          value={repPhone}
                          onChange={(e) => setRepPhone(e.target.value)}
                          placeholder="01xxxxxxxxx"
                          className="h-8 text-sm"
                          dir="ltr"
                        />
                      </div>
                      <Button
                        onClick={() => sendReceiptPrompts(po.id)}
                        disabled={sending}
                        size="sm"
                        className="gap-1.5"
                      >
                        <Send size={14} /> إرسال طلبات الاستلام
                      </Button>
                    </div>

                    {loadingItems ? (
                      <div className="p-6 text-center text-muted-foreground text-sm">جارٍ تحميل البنود...</div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border bg-muted/30 text-left">
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium">البند</th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium">الكمية</th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium">الحالة</th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium">مستلم/مقبول</th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium">مرفوض</th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium">التكلفة الفعلية</th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {items.map((it) => (
                              <ReceiptItemRow
                                key={it.id}
                                item={it}
                                rows={receipts[it.id] ?? []}
                                onSave={(d) => saveReceipt(po.id, it.id, d)}
                                onPostpone={() => postpone(po.id, it.id)}
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
  );
}

interface ReceiptRow {
  id: number;
  poItemId: number;
  receivedQty: number | null;
  acceptedQty: number | null;
  rejectedQty: number | null;
  rejectionReason: string | null;
  actualCost: number | null;
  receiptStatus: string;
  receivedBy: string | null;
  receivedAt: string;
}

function ReceiptItemRow({
  item,
  rows,
  onSave,
  onPostpone,
}: {
  item: PoItemRow;
  rows: ReceiptRow[];
  onSave: (d: { receivedQty: string; acceptedQty: string; rejectedQty: string; rejectionReason: string; actualCost: string }) => void;
  onPostpone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [receivedQty, setReceivedQty] = useState("");
  const [acceptedQty, setAcceptedQty] = useState("");
  const [rejectedQty, setRejectedQty] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [actualCost, setActualCost] = useState("");

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
        <td className={`px-4 py-3 text-xs font-medium ${statusTone(item.lineStatus)}`}>
          {LINE_STATUS_LABEL[item.lineStatus] ?? item.lineStatus}
        </td>
        <td className="px-4 py-3 text-xs text-muted-foreground">
          {item.totalReceivedQty != null && item.totalAcceptedQty != null
            ? `${item.totalAcceptedQty} / ${item.totalReceivedQty}`
            : "-"}
        </td>
        <td className="px-4 py-3 text-xs text-red-600">{item.totalRejectedQty ?? "-"}</td>
        <td className="px-4 py-3 text-xs text-foreground">{item.finalActualCost ?? "-"}</td>
        <td className="px-4 py-3 text-left">
          <Button onClick={() => setOpen((o) => !o)} size="sm" variant="outline" className="h-7 text-xs">
            تسجيل استلام
          </Button>
          {item.lineStatus === "pending" && (
            <Button onClick={onPostpone} size="sm" variant="ghost" className="h-7 text-xs ml-1">
              تأجيل
            </Button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="bg-muted/10">
          <td colSpan={7} className="px-4 py-3">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">مستلم</label>
                <Input
                  value={receivedQty}
                  onChange={(e) => setReceivedQty(e.target.value)}
                  type="number"
                  placeholder={String(item.qty ?? "")}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">مقبول</label>
                <Input
                  value={acceptedQty}
                  onChange={(e) => setAcceptedQty(e.target.value)}
                  type="number"
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">مرفوض</label>
                <Input
                  value={rejectedQty}
                  onChange={(e) => setRejectedQty(e.target.value)}
                  type="number"
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">التكلفة الفعلية</label>
                <Input
                  value={actualCost}
                  onChange={(e) => setActualCost(e.target.value)}
                  type="number"
                  step="0.0001"
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">سبب الرفض</label>
                <Input
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="تالف/خطأ/..."
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
                  onSave({ receivedQty, acceptedQty, rejectedQty, rejectionReason, actualCost })
                }
                size="sm"
                className="h-8"
              >
                حفظ
              </Button>
            </div>
            {rows.length > 0 && (
              <div className="mt-3 border-t border-border pt-2">
                <div className="text-xs text-muted-foreground mb-1">سجلات الاستلام السابقة:</div>
                <div className="space-y-1">
                  {rows.map((r) => (
                    <div key={r.id} className="text-xs text-muted-foreground flex gap-3">
                      <span>مستلم: {r.receivedQty ?? "-"}</span>
                      <span>مقبول: {r.acceptedQty ?? "-"}</span>
                      <span>مرفوض: {r.rejectedQty ?? "-"}</span>
                      <span>تكلفة: {r.actualCost ?? "-"}</span>
                      {r.rejectionReason && <span>السبب: {r.rejectionReason}</span>}
                      <span>· {new Date(r.receivedAt).toLocaleDateString()}</span>
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

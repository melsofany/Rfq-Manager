import { useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCustomerPo,
  useUpdateCustomerPo,
  useDeleteCustomerPo,
  useListCustomerPosCustomerRfqs,
  getGetCustomerPoQueryKey,
  getListCustomerPosQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { CustomerCombobox } from "@/components/CustomerCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Trash2, AlertCircle, AlertTriangle, Pencil, Lock, ChevronDown } from "lucide-react";
import { getApiErrorMessage } from "@/lib/api-error";

// Per-item combobox to pick a customer RFQ by number. Sets customerRfqId on the
// row (and clears customerRfqItemId, since the specific rfq line link must be
// re-established against the newly chosen RFQ).
function RfqCellPicker({
  rfqs,
  rfqId,
  rfqNo,
  onPick,
}: {
  rfqs: { id: number; customerRfqNo: string; internalNo: string; customerName: string }[] | undefined;
  rfqId: number | null;
  rfqNo: string;
  onPick: (rfq: { id: number; customerRfqNo: string } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const selected = rfqs?.find((r) => r.id === rfqId);
  const display = selected ? selected.customerRfqNo : rfqNo || filter;

  const filtered = filter
    ? (rfqs ?? [])
        .filter(
          (r) =>
            r.customerRfqNo.toLowerCase().includes(filter.toLowerCase()) ||
            r.internalNo.toLowerCase().includes(filter.toLowerCase()),
        )
        .slice(0, 50)
    : (rfqs ?? []).slice(0, 50);

  return (
    <div className="relative">
      <div className="flex">
        <Input
          value={display}
          onChange={(e) => {
            setFilter(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="—"
          className="h-7 text-xs rounded-l-none"
          dir="ltr"
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="border border-r-0 border-border rounded-r-md px-1 bg-muted hover:bg-muted/80 text-muted-foreground"
        >
          <ChevronDown size={12} />
        </button>
      </div>
      {open && (
        <ul className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto bg-popover border border-border rounded-md shadow-md text-xs">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">لا توجد طلبات تسعير</li>
          ) : (
            filtered.map((r) => (
              <li
                key={r.id}
                className="px-2 py-1 cursor-pointer hover:bg-accent hover:text-accent-foreground"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick({ id: r.id, customerRfqNo: r.customerRfqNo });
                  setOpen(false);
                  setFilter("");
                }}
              >
                <div className="font-mono font-medium" dir="ltr">{r.customerRfqNo}</div>
                <div className="text-muted-foreground text-[10px]">{r.internalNo}</div>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// Strip trailing zeros from a NUMERIC value: "3.0000" → "3", "3.5000" → "3.5".
function formatQty(qty: unknown): string {
  if (qty == null || qty === "") return "";
  const s = String(qty);
  if (!s.includes(".")) return s;
  const trimmed = s.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" ? "0" : trimmed;
}

function formatLineTotal(qty: unknown, price: unknown): string {
  const q = Number(qty);
  const p = Number(price);
  if (!isFinite(q) || !isFinite(p) || q === 0 || p === 0) return "";
  const n = Math.round(q * p * 10000) / 10000;
  return formatQty(n);
}

interface ItemRow {
  id?: number;
  customerRfqId: number | null;
  customerRfqItemId: number | null;
  customerRfqNo: string;
  partNo: string;
  lineItem: string;
  description: string;
  uom: string;
  qty: string;
  unitPrice: string;
  deliveryDate: string;
}

export default function CustomerPoDetailPage() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id, 10);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const { data: po, isLoading } = useGetCustomerPo(id);
  const { data: rfqOptions } = useListCustomerPosCustomerRfqs();
  const isDraft = po?.status === "draft";

  const [editing, setEditing] = useState(false);
  const [customerPoNo, setCustomerPoNo] = useState("");
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [poDate, setPoDate] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<ItemRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmFinalize, setConfirmFinalize] = useState(false);

  const updateMutation = useUpdateCustomerPo({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCustomerPoQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListCustomerPosQueryKey() });
        setEditing(false);
        setConfirmFinalize(false);
        setError(null);
      },
      onError: (err: unknown) => {
        setError(getApiErrorMessage(err, "فشل تحديث أمر الشراء"));
        setConfirmFinalize(false);
      },
    },
  });

  const deleteMutation = useDeleteCustomerPo({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCustomerPosQueryKey() });
        navigate("/customer-po");
      },
      onError: (err: unknown) => {
        setError(getApiErrorMessage(err, "فشل حذف أمر الشراء"));
        setConfirmDelete(false);
      },
    },
  });

  const startEdit = () => {
    if (!po) return;
    setCustomerPoNo(po.customerPoNo);
    setCustomerId(po.customerId ?? null);
    setCustomerName(po.customerName ?? "");
    setPoDate(po.poDate ?? "");
    setBuyerName(po.buyerName ?? "");
    setNotes(po.notes ?? "");
    setItems(
      (po.items ?? []).map((i) => ({
        id: i.id,
        customerRfqId: i.customerRfqId ?? null,
        customerRfqItemId: i.customerRfqItemId ?? null,
        customerRfqNo: i.customerRfqNo ?? "",
        partNo: i.partNo ?? "",
        lineItem: i.lineItem ?? "",
        description: i.description ?? "",
        uom: i.uom ?? "",
        qty: formatQty(i.qty),
        unitPrice: formatQty(i.unitPrice),
        deliveryDate: i.deliveryDate ?? "",
      })),
    );
    setEditing(true);
    setError(null);
  };

  const addItem = () =>
    setItems((prev) => [
      ...prev,
      {
        customerRfqId: null,
        customerRfqItemId: null,
        customerRfqNo: "",
        partNo: "",
        lineItem: "",
        description: "",
        uom: "",
        qty: "",
        unitPrice: "",
        deliveryDate: "",
      },
    ]);
  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));
  const updateItem = (i: number, patch: Partial<ItemRow>) =>
    setItems((prev) => prev.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerPoNo.trim()) {
      setError("رقم أمر شراء العميل مطلوب");
      return;
    }
    if (!customerName.trim()) {
      setError("يجب اختيار اسم العميل");
      return;
    }
    const validItems = items
      .filter(
        (it) =>
          (it.partNo.trim() || it.lineItem.trim() || it.description.trim()) && it.qty,
      )
      .map((it) => ({
        customerRfqId: it.customerRfqId,
        customerRfqItemId: it.customerRfqItemId,
        partNo: it.partNo.trim() || undefined,
        lineItem: it.lineItem ? it.lineItem.replace(/\s+/g, "") : undefined,
        description: it.description.trim() || undefined,
        uom: it.uom.trim() || undefined,
        qty: it.qty ? Number(it.qty) : undefined,
        unitPrice: it.unitPrice ? Number(it.unitPrice) : undefined,
        deliveryDate: it.deliveryDate || undefined,
      }));
    updateMutation.mutate({
      id,
      data: {
        customerPoNo: customerPoNo.trim(),
        customerId: customerId ?? undefined,
        customerName: customerName.trim(),
        poDate: poDate || undefined,
        buyerName: buyerName.trim(),
        notes: notes.trim(),
        items: validItems,
      } as Parameters<typeof updateMutation.mutate>[0]["data"],
    });
  };

  const handleFinalize = () => {
    updateMutation.mutate({
      id,
      data: { status: "sent" } as Parameters<typeof updateMutation.mutate>[0]["data"],
    });
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="p-6 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
      </Layout>
    );
  }

  if (!po) {
    return (
      <Layout>
        <div className="p-6 text-center">
          <p className="text-muted-foreground text-sm">أمر الشراء غير موجود</p>
          <Link href="/customer-po">
            <a className="text-primary text-sm hover:underline mt-2 inline-block">
              العودة لأوامر الشراء
            </a>
          </Link>
        </div>
      </Layout>
    );
  }

  const grandTotalStr = (() => {
    const sum = (po.items ?? []).reduce((acc, it) => acc + Number(formatLineTotal(it.qty, it.unitPrice) || 0), 0);
    return formatQty(Math.round(sum * 10000) / 10000);
  })();

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5 max-w-5xl">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Link href="/customer-po">
              <a className="text-muted-foreground hover:text-foreground">
                <ArrowLeft size={18} />
              </a>
            </Link>
            <h1 className="text-xl font-bold text-foreground font-mono" dir="ltr">
              {po.internalPoNo}
            </h1>
            <span
              className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${
                po.status === "sent"
                  ? "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400"
                  : "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
              }`}
            >
              {po.status === "sent" ? "تم الإرسال" : "مسودة"}
            </span>
            {po.fulfillmentStatus ? (
              <span
                className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${
                  {
                    draft: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
                    sent: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
                    po_issued:
                      "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-400",
                    ready_to_deliver:
                      "bg-cyan-100 text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-400",
                    delivered:
                      "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
                    fulfilled:
                      "bg-green-200 text-green-800 dark:bg-green-900/50 dark:text-green-300",
                  }[po.fulfillmentStatus.stage] ??
                  "bg-muted text-muted-foreground"
                }`}
                title={
                  po.fulfillmentStatus.totalItems
                    ? `${po.fulfillmentStatus.receivedItems ?? 0}/${po.fulfillmentStatus.totalItems} مُستلَم · ${po.fulfillmentStatus.deliveredItems ?? 0}/${po.fulfillmentStatus.totalItems} مُسلّم`
                    : undefined
                }
              >
                {po.fulfillmentStatus.label}
              </span>
            ) : null}
          </div>
        </div>

        {!editing ? (
          <>
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">رقم أمر العميل</Label>
                  <p className="text-sm text-foreground font-mono" dir="ltr">
                    {po.customerPoNo}
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">تاريخ الأمر</Label>
                  <p className="text-sm text-foreground" dir="ltr">
                    {po.poDate ?? "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">العميل</Label>
                  <p className="text-sm text-foreground">{po.customerName ?? "—"}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">المشتري</Label>
                  <p className="text-sm text-foreground">{po.buyerName ?? "—"}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">المدخل</Label>
                  <p className="text-sm text-foreground">{po.employeeName ?? "—"}</p>
                </div>
                {po.notes && (
                  <div className="space-y-1 col-span-2 sm:col-span-2">
                    <Label className="text-muted-foreground text-xs">ملاحظات</Label>
                    <p className="text-sm text-foreground whitespace-pre-wrap">{po.notes}</p>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="px-5 py-3 border-b border-border">
                <h2 className="font-semibold text-sm text-foreground">
                  البنود <span className="text-muted-foreground font-normal">({po.items?.length ?? 0})</span>
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/30 border-b border-border text-right">
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium w-8">#</th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Part No</th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Line Item</th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">التوصيف</th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">UOM</th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">الكمية</th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">سعر الوحدة</th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">الإجمالي</th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">تاريخ التسليم</th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">طلب التسعير</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(po.items ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={10} className="px-4 py-6 text-center text-muted-foreground text-sm">
                          لا توجد بنود
                        </td>
                      </tr>
                    ) : (
                      (po.items ?? []).map((it, i) => (
                        <tr key={it.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                          <td className="px-4 py-2.5 text-muted-foreground text-xs text-center">{i + 1}</td>
                          <td className="px-4 py-2.5 font-mono text-xs" dir="ltr">{it.partNo ?? "—"}</td>
                          <td className="px-4 py-2.5 font-mono text-xs" dir="ltr">{it.lineItem ?? "—"}</td>
                          <td className="px-4 py-2.5 text-xs">{it.description ?? "—"}</td>
                          <td className="px-4 py-2.5 text-xs">{it.uom ?? "—"}</td>
                          <td className="px-4 py-2.5 text-xs" dir="ltr">{formatQty(it.qty) || "—"}</td>
                          <td className="px-4 py-2.5 text-xs" dir="ltr">{formatQty(it.unitPrice) || "—"}</td>
                          <td className="px-4 py-2.5 text-xs" dir="ltr">{formatQty(it.total) || "—"}</td>
                          <td className="px-4 py-2.5 text-xs" dir="ltr">{it.deliveryDate ?? "—"}</td>
                          <td className="px-4 py-2.5 text-xs" dir="ltr">
                            {it.customerRfqNo ? (
                              <Link href={`/customer-rfq/${it.customerRfqId}`}>
                                <a className="text-primary hover:underline font-mono">{it.customerRfqNo}</a>
                              </Link>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  {(po.items ?? []).length > 0 && (
                    <tfoot>
                      <tr className="bg-muted/20 border-t-2 border-border font-semibold">
                        <td colSpan={8} className="px-4 py-2.5 text-left text-xs text-muted-foreground">
                          الإجمالي الكلي
                        </td>
                        <td className="px-4 py-2.5 text-sm" dir="ltr">{grandTotalStr || "—"}</td>
                        <td />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              {isDraft && (
                <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <AlertTriangle size={13} className="text-amber-500" />
                    إرسال الأمر يمنع أي تعديل لاحق.
                  </p>
                  {confirmFinalize ? (
                    <div className="flex gap-2">
                      <Button variant="ghost" onClick={() => setConfirmFinalize(false)}>
                        إلغاء
                      </Button>
                      <Button disabled={updateMutation.isPending} onClick={handleFinalize}>
                        {updateMutation.isPending ? "جارٍ الإرسال..." : "تأكيد الإرسال"}
                      </Button>
                    </div>
                  ) : (
                    <Button onClick={() => setConfirmFinalize(true)} className="gap-1.5">
                      <Lock size={15} /> إرسال أمر الشراء
                    </Button>
                  )}
                </div>
              )}
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
                <AlertCircle size={14} />
                <span>{error}</span>
              </div>
            )}

            {isDraft && (
              <div className="flex gap-3 justify-end">
                {confirmDelete ? (
                  <>
                    <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                      إلغاء
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={deleteMutation.isPending}
                      onClick={() => deleteMutation.mutate({ id })}
                    >
                      {deleteMutation.isPending ? "جارٍ الحذف..." : "تأكيد الحذف"}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      onClick={() => setConfirmDelete(true)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 size={15} className="ml-1" /> حذف
                    </Button>
                    <Button variant="outline" onClick={startEdit} className="gap-1.5">
                      <Pencil size={15} /> تعديل
                    </Button>
                  </>
                )}
              </div>
            )}
          </>
        ) : (
          <form onSubmit={handleSave} className="space-y-5">
            <div className="bg-card border border-border rounded-lg p-5 space-y-4">
              <h2 className="font-semibold text-sm text-foreground">بيانات أمر الشراء</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label>رقم أمر الشراء *</Label>
                  <Input
                    value={customerPoNo}
                    onChange={(e) => setCustomerPoNo(e.target.value)}
                    required
                    dir="ltr"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>تاريخ أمر الشراء</Label>
                  <Input
                    type="date"
                    value={poDate}
                    onChange={(e) => setPoDate(e.target.value)}
                    dir="ltr"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>المشتري (المرجع من العميل)</Label>
                  <Input
                    value={buyerName}
                    onChange={(e) => setBuyerName(e.target.value)}
                    placeholder="اسم المشتري / المرجع"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>اسم العميل *</Label>
                <CustomerCombobox
                  value={customerName}
                  onChange={(v) => {
                    setCustomerName(v);
                    setCustomerId(null);
                  }}
                  onPick={(c) => {
                    setCustomerId(c.id);
                    setCustomerName(c.name);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label>ملاحظات</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                />
              </div>
            </div>

            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-border">
                <h2 className="font-semibold text-sm text-foreground">
                  البنود <span className="text-muted-foreground font-normal">({items.length})</span>
                </h2>
                <Button
                  type="button"
                  onClick={addItem}
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 h-7 text-xs"
                >
                  إضافة بند
                </Button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/30 border-b border-border text-right">
                      <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-8">#</th>
                      <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-32">Part No</th>
                      <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-36">Line Item</th>
                      <th className="px-3 py-2 text-muted-foreground text-xs font-medium">التوصيف</th>
                      <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-20">UOM</th>
                      <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-24">الكمية</th>
                      <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-24">سعر الوحدة</th>
                      <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-32">تاريخ التسليم</th>
                      <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-36">طلب التسعير</th>
                      <th className="px-3 py-2 w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row, i) => {
                      const total = formatLineTotal(row.qty, row.unitPrice);
                      return (
                        <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/20">
                          <td className="px-3 py-2 text-muted-foreground text-xs text-center">{i + 1}</td>
                          <td className="px-2 py-1.5">
                            <Input
                              value={row.partNo}
                              onChange={(e) => updateItem(i, { partNo: e.target.value })}
                              className="h-7 text-xs"
                              dir="ltr"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input
                              value={row.lineItem}
                              onChange={(e) => updateItem(i, { lineItem: e.target.value })}
                              className="h-7 text-xs"
                              dir="ltr"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input
                              value={row.description}
                              onChange={(e) => updateItem(i, { description: e.target.value })}
                              className="h-7 text-xs"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input
                              value={row.uom}
                              onChange={(e) => updateItem(i, { uom: e.target.value })}
                              className="h-7 text-xs"
                              placeholder="pc"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input
                              value={row.qty}
                              onChange={(e) => updateItem(i, { qty: e.target.value })}
                              className="h-7 text-xs"
                              type="number"
                              dir="ltr"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input
                              value={row.unitPrice}
                              onChange={(e) => updateItem(i, { unitPrice: e.target.value })}
                              className="h-7 text-xs"
                              type="number"
                              dir="ltr"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input
                              type="date"
                              value={row.deliveryDate}
                              onChange={(e) => updateItem(i, { deliveryDate: e.target.value })}
                              className="h-7 text-xs"
                              dir="ltr"
                            />
                          </td>
                          <td className="px-2 py-1.5 text-xs text-center" dir="ltr">
                            {total || "—"}
                          </td>
                          <td className="px-2 py-1.5">
                            <RfqCellPicker
                              rfqs={rfqOptions?.rfqs}
                              rfqId={row.customerRfqId}
                              rfqNo={row.customerRfqNo}
                              onPick={(rfq) =>
                                updateItem(i, {
                                  customerRfqId: rfq ? rfq.id : null,
                                  customerRfqNo: rfq ? rfq.customerRfqNo : "",
                                  customerRfqItemId: null,
                                })
                              }
                            />
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            {items.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeItem(i)}
                                className="text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
                <AlertCircle size={14} />
                <span>{error}</span>
              </div>
            )}

            <div className="flex gap-3 justify-end">
              <Button variant="ghost" onClick={() => setEditing(false)}>
                إلغاء
              </Button>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? "جارٍ الحفظ..." : "حفظ التعديلات"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Layout>
  );
}

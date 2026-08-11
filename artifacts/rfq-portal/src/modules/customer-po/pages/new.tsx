import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateCustomerPo,
  getListCustomerPosQueryKey,
  useListCustomerPosCustomerRfqs,
  getListCustomerPosCustomerRfqsQueryKey,
  useGetCustomerRfq,
  getGetCustomerRfqQueryKey,
  type CustomerPoLineItemInput,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Plus, Trash2, ChevronDown, AlertCircle, FileText } from "lucide-react";
import { getApiErrorMessage } from "@/lib/api-error";

interface ItemRow {
  // identity
  customerRfqId: number | null;
  customerRfqItemId: number | null;
  partNo: string;
  lineItem: string;
  description: string;
  uom: string;
  qty: string;
  unitPrice: string;
  deliveryDate: string;
  // marks lines pulled from an RFQ so they show a source badge; the user may
  // still edit qty/price/deliveryDate on them.
  fromRfq: boolean;
}

const emptyRow: ItemRow = {
  customerRfqId: null,
  customerRfqItemId: null,
  partNo: "",
  lineItem: "",
  description: "",
  uom: "",
  qty: "",
  unitPrice: "",
  deliveryDate: "",
  fromRfq: false,
};

function makeEmptyRow(): ItemRow {
  return { ...emptyRow };
}

// Combobox to pick a customer RFQ by its number. Loads the RFQ's items on pick
// (via useGetCustomerRfq keyed by the selected id) so the user can check the
// items they want to include in this PO.
function CustomerRfqPicker({
  rfqs,
  isLoading,
  selectedId,
  onSelect,
}: {
  rfqs: { id: number; customerRfqNo: string; internalNo: string; customerName: string; status: string }[] | undefined;
  isLoading: boolean;
  selectedId: number | null;
  onSelect: (rfq: { id: number; customerRfqNo: string; customerName: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const filtered = filter
    ? (rfqs ?? [])
        .filter(
          (r) =>
            r.customerRfqNo.toLowerCase().includes(filter.toLowerCase()) ||
            r.internalNo.toLowerCase().includes(filter.toLowerCase()) ||
            r.customerName.toLowerCase().includes(filter.toLowerCase()),
        )
        .slice(0, 50)
    : (rfqs ?? []).slice(0, 50);

  const selected = rfqs?.find((r) => r.id === selectedId);

  return (
    <div className="relative">
      <div className="flex">
        <Input
          value={selected ? selected.customerRfqNo : filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="اختر رقم طلب التسعير لجلب بنوده..."
          className="rounded-l-none"
          dir="ltr"
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="border border-r-0 border-border rounded-r-md px-2 bg-muted hover:bg-muted/80 text-muted-foreground"
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {open && (
        <ul className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto bg-popover border border-border rounded-md shadow-md text-sm">
          {isLoading ? (
            <li className="px-3 py-2 text-muted-foreground">جارٍ التحميل...</li>
          ) : filtered.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">لا توجد طلبات تسعير مطابقة</li>
          ) : (
            filtered.map((r) => (
              <li
                key={r.id}
                className="px-3 py-1.5 cursor-pointer hover:bg-accent hover:text-accent-foreground"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect({ id: r.id, customerRfqNo: r.customerRfqNo, customerName: r.customerName });
                  setOpen(false);
                  setFilter("");
                }}
              >
                <div className="font-mono font-medium text-xs" dir="ltr">
                  {r.customerRfqNo}
                </div>
                <div className="text-xs text-muted-foreground">
                  {r.customerName} · {r.internalNo}
                </div>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

export default function NewCustomerPoPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  // Top-level PO fields
  const [customerPoNo, setCustomerPoNo] = useState("");
  const [poDate, setPoDate] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<ItemRow[]>([makeEmptyRow()]);
  const [serverError, setServerError] = useState<string | null>(null);

  // The selected customer RFQ (its items are loaded so the user can check which
  // to include). Cleared selection stops fetching the detail.
  const [selectedRfq, setSelectedRfq] = useState<{
    id: number;
    customerRfqNo: string;
    customerName: string;
  } | null>(null);

  const { data: rfqOptions, isLoading: rfqsLoading } = useListCustomerPosCustomerRfqs({
    query: { queryKey: getListCustomerPosCustomerRfqsQueryKey() },
  });

  // Fetch the selected RFQ's items (only when an RFQ is picked).
  const { data: rfqDetail, isLoading: rfqDetailLoading } = useGetCustomerRfq(selectedRfq?.id ?? 0, {
    query: {
      // Avoid fetching with id 0 (no selection). A falsy id disables the query.
      enabled: selectedRfq != null && !!selectedRfq.id,
      queryKey: getGetCustomerRfqQueryKey(selectedRfq?.id ?? 0),
    },
  });

  const createMutation = useCreateCustomerPo({
    mutation: {
      onSuccess: (po) => {
        queryClient.invalidateQueries({ queryKey: getListCustomerPosQueryKey() });
        navigate(`/customer-po/${po.id}`);
      },
      onError: (err: unknown) => {
        setServerError(getApiErrorMessage(err, "حدث خطأ أثناء حفظ أمر الشراء"));
      },
    },
  });

  const addItem = () => setItems((prev) => [...prev, makeEmptyRow()]);
  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));
  const updateItem = (i: number, patch: Partial<ItemRow>) =>
    setItems((prev) => prev.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  // When an RFQ's items are loaded, show them as a checklist; checking an item
  // appends it to the PO items table (with its partNo/desc/uom pre-filled). The
  // user then enters qty/price/deliveryDate on the appended row.
  const onToggleRfqItem = (it: {
    id: number;
    partNo?: string | null;
    lineItem?: string | null;
    description?: string | null;
    uom?: string | null;
    unitPrice?: number | null;
  }, checked: boolean) => {
    if (!selectedRfq) return;
    if (checked) {
      setItems((prev) => [
        ...prev,
        {
          customerRfqId: selectedRfq.id,
          customerRfqItemId: it.id,
          partNo: it.partNo ?? "",
          lineItem: it.lineItem ?? "",
          description: it.description ?? "",
          uom: it.uom ?? "",
          qty: "",
          unitPrice: it.unitPrice != null ? String(it.unitPrice) : "",
          deliveryDate: "",
          fromRfq: true,
        },
      ]);
    } else {
      setItems((prev) => prev.filter((row) => row.customerRfqItemId !== it.id || row.fromRfq === false ? true : false));
    }
  };

  const isRfqItemSelected = (itemId: number) =>
    items.some((r) => r.fromRfq && r.customerRfqItemId === itemId);

  const buildPayload = () => {
    const validItems = items
      .filter(
        (it) =>
          (it.partNo.trim() || it.lineItem.trim() || it.description.trim()) && it.qty,
      )
      .map<CustomerPoLineItemInput>((it) => ({
        customerRfqId: it.customerRfqId ?? null,
        customerRfqItemId: it.customerRfqItemId ?? null,
        partNo: it.partNo.trim() || undefined,
        lineItem: it.lineItem ? it.lineItem.replace(/\s+/g, "") : undefined,
        description: it.description.trim() || undefined,
        uom: it.uom.trim() || undefined,
        qty: it.qty ? Number(it.qty) : undefined,
        unitPrice: it.unitPrice ? Number(it.unitPrice) : undefined,
        deliveryDate: it.deliveryDate || undefined,
      }));
    return {
      customerPoNo: customerPoNo.trim(),
      poDate: poDate || undefined,
      buyerName: buyerName.trim() || undefined,
      notes: notes.trim() || undefined,
      items: validItems,
    } as Parameters<typeof createMutation.mutate>[0]["data"];
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    if (!customerPoNo.trim()) {
      setServerError("رقم أمر شراء العميل مطلوب");
      return;
    }
    const validCount = items.filter(
      (it) =>
        (it.partNo.trim() || it.lineItem.trim() || it.description.trim()) && it.qty,
    ).length;
    if (validCount === 0) {
      setServerError("يجب إدخال بند واحد على الأقل");
      return;
    }
    createMutation.mutate({ data: buildPayload() });
  };

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5 max-w-5xl">
        <div className="flex items-center gap-2">
          <Link href="/customer-po">
            <a className="text-muted-foreground hover:text-foreground">
              <ArrowLeft size={18} />
            </a>
          </Link>
          <h1 className="text-xl font-bold text-foreground">أمر شراء عميل جديد</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Top-level fields */}
          <div className="bg-card border border-border rounded-lg p-5 space-y-4">
            <h2 className="font-semibold text-sm text-foreground">بيانات أمر الشراء</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label>رقم أمر الشراء (من العميل) *</Label>
                <Input
                  value={customerPoNo}
                  onChange={(e) => setCustomerPoNo(e.target.value)}
                  placeholder="PO-..."
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
                <Label>اسم الموظف / Buyer</Label>
                <Input
                  value={buyerName}
                  onChange={(e) => setBuyerName(e.target.value)}
                  placeholder="اسم المشتري"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>ملاحظات</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="ملاحظات داخلية..."
                rows={2}
              />
            </div>
          </div>

          {/* Customer RFQ picker — optional. Lets the user pull items from one
              or more customer RFQs into this PO. POs without an RFQ number are
              entered entirely as free/manual rows below. */}
          <div className="bg-card border border-border rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm text-foreground">طلب تسعير العميل (اختياري)</h2>
              {selectedRfq && (
                <button
                  type="button"
                  onClick={() => setSelectedRfq(null)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  مسح الاختيار
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              اختر رقم طلب تسعير العميل لجلب بنوده ثم حدّد البنود التي صدر لها أمر شراء مع
              الكمية والسعر وتاريخ التسليم. لأوامر الشراء بدون رقم طلب تسعير، أضف البنود يدوياً
              بالجدول بالأسفل.
            </p>
            <CustomerRfqPicker
              rfqs={rfqOptions?.rfqs}
              isLoading={rfqsLoading}
              selectedId={selectedRfq?.id ?? null}
              onSelect={(r) =>
                setSelectedRfq({ id: r.id, customerRfqNo: r.customerRfqNo, customerName: r.customerName })
              }
            />

            {selectedRfq && (
              <div className="border border-border rounded-md overflow-hidden">
                <div className="px-3 py-2 bg-muted/30 border-b border-border text-xs text-muted-foreground">
                  {rfqDetailLoading
                    ? "جارٍ تحميل البنود..."
                    : `${selectedRfq.customerName} — ${rfqDetail?.items?.length ?? 0} بنود`}
                </div>
                {rfqDetail?.items && rfqDetail.items.length > 0 ? (
                  <div className="max-h-64 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card">
                        <tr className="border-b border-border text-right">
                          <th className="px-2 py-1.5 w-8"></th>
                          <th className="px-2 py-1.5 text-muted-foreground font-medium">Part No</th>
                          <th className="px-2 py-1.5 text-muted-foreground font-medium">Line Item</th>
                          <th className="px-2 py-1.5 text-muted-foreground font-medium">التوصيف</th>
                          <th className="px-2 py-1.5 text-muted-foreground font-medium">السعر</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rfqDetail.items.map((it) => {
                          const checked = isRfqItemSelected(it.id);
                          return (
                            <tr
                              key={it.id}
                              className={`border-b border-border last:border-0 ${checked ? "bg-primary/5" : ""}`}
                            >
                              <td className="px-2 py-1.5 text-center">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => onToggleRfqItem(it, e.target.checked)}
                                  className="h-3.5 w-3.5"
                                />
                              </td>
                              <td className="px-2 py-1.5 font-mono" dir="ltr">
                                {it.partNo ?? "—"}
                              </td>
                              <td className="px-2 py-1.5 font-mono" dir="ltr">
                                {it.lineItem ?? "—"}
                              </td>
                              <td className="px-2 py-1.5">{it.description ?? "—"}</td>
                              <td className="px-2 py-1.5" dir="ltr">
                                {it.unitPrice ?? "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  !rfqDetailLoading && (
                    <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                      لا توجد بنود في هذا الطلب
                    </div>
                  )
                )}
              </div>
            )}
          </div>

          {/* Items table */}
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
                <Plus size={13} /> إضافة بند يدوي
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-right">
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-8">#</th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-32">
                      Part No
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-36">
                      Line Item
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium">
                      التوصيف
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-20">
                      UOM
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-24">
                      الكمية
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-24">
                      سعر الوحدة
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-32">
                      تاريخ التسليم
                    </th>
                    <th className="px-3 py-2 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row, i) => (
                    <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/20">
                      <td className="px-3 py-2 text-muted-foreground text-xs text-center">
                        {row.fromRfq ? (
                          <FileText size={12} className="text-primary inline" />
                        ) : (
                          i + 1
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.partNo}
                          onChange={(e) => updateItem(i, { partNo: e.target.value })}
                          className="h-7 text-xs"
                          placeholder="رقم الجزء"
                          dir="ltr"
                          readOnly={row.fromRfq}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.lineItem}
                          onChange={(e) => updateItem(i, { lineItem: e.target.value })}
                          className="h-7 text-xs"
                          placeholder="تُحذف المسافات"
                          dir="ltr"
                          readOnly={row.fromRfq}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.description}
                          onChange={(e) => updateItem(i, { description: e.target.value })}
                          className="h-7 text-xs"
                          placeholder="توصيف البند"
                          readOnly={row.fromRfq}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.uom}
                          onChange={(e) => updateItem(i, { uom: e.target.value })}
                          className="h-7 text-xs"
                          placeholder="pc"
                          readOnly={row.fromRfq}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.qty}
                          onChange={(e) => updateItem(i, { qty: e.target.value })}
                          className="h-7 text-xs"
                          type="number"
                          placeholder="0"
                          dir="ltr"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.unitPrice}
                          onChange={(e) => updateItem(i, { unitPrice: e.target.value })}
                          className="h-7 text-xs"
                          type="number"
                          placeholder="0"
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
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {serverError && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
              <AlertCircle size={14} />
              <span>{serverError}</span>
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row gap-3 sm:justify-end">
            <Link href="/customer-po">
              <a className="inline-flex items-center px-4 py-2 text-sm rounded border border-border text-muted-foreground hover:text-foreground">
                إلغاء
              </a>
            </Link>
            <Button
              type="submit"
              disabled={createMutation.isPending || !customerPoNo.trim()}
            >
              {createMutation.isPending ? "جارٍ الحفظ..." : "حفظ أمر الشراء"}
            </Button>
          </div>
        </form>
      </div>
    </Layout>
  );
}

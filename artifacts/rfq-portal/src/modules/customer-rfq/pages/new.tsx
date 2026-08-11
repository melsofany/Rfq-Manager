import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateCustomerRfq,
  getListCustomerRfqsQueryKey,
  useListCustomers,
  getListCustomersQueryKey,
  type Customer,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Plus, Trash2, ChevronDown, AlertTriangle, AlertCircle } from "lucide-react";
import { getApiErrorMessage } from "@/lib/api-error";

interface ItemRow {
  partNo: string;
  lineItem: string;
  description: string;
  uom: string;
  qty: string;
}

const COMMON_UOMS = ["pc", "set", "kg", "g", "m", "cm", "mm", "L", "box", "unit", "pair"];

// Combobox: type to filter, or pick from existing customers. Free text allowed so
// a customer name can be entered even if not yet registered.
function CustomerCombobox({
  value,
  onChange,
  onPick,
  customers,
  isLoading,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (c: Customer) => void;
  customers: Customer[] | undefined;
  isLoading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = filter
    ? (customers ?? [])
        .filter(
          (c) =>
            c.name.toLowerCase().includes(filter.toLowerCase()) ||
            (c.nickname ?? "").toLowerCase().includes(filter.toLowerCase()) ||
            (c.customerId ?? "").toLowerCase().includes(filter.toLowerCase()),
        )
        .slice(0, 50)
    : (customers ?? []).slice(0, 50);

  useEffect(() => {
    setFilter(value);
  }, [value]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="flex">
        <Input
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="اختر العميل أو اكتب اسمه"
          required
          className="rounded-l-none"
          dir="rtl"
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
            <li className="px-3 py-2 text-muted-foreground">
              لا يوجد عملاء مطابقون — سيُسجّل الاسم كما هو.
            </li>
          ) : (
            filtered.map((c) => (
              <li
                key={c.id}
                className="px-3 py-1.5 cursor-pointer hover:bg-accent hover:text-accent-foreground"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(c);
                  setFilter(c.name);
                  setOpen(false);
                }}
              >
                <div className="font-medium">{c.name}</div>
                {c.nickname && (
                  <div className="text-xs text-muted-foreground">{c.nickname}</div>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// Input with a datalist of common UOMs — lets the user pick or type freely.
function UomInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useRef(`uom-${Math.random().toString(36).slice(2, 9)}`).current;
  return (
    <>
      <Input
        list={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 text-xs"
        placeholder="pc"
      />
      <datalist id={id}>
        {COMMON_UOMS.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
    </>
  );
}

export default function NewCustomerRfqPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const [customerName, setCustomerName] = useState("");
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerRfqNo, setCustomerRfqNo] = useState("");
  const [entryDate, setEntryDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<ItemRow[]>([
    { partNo: "", lineItem: "", description: "", uom: "", qty: "" },
  ]);
  const [serverError, setServerError] = useState<string | null>(null);

  const { data: customers, isLoading: customersLoading } = useListCustomers(
    {},
    { query: { queryKey: getListCustomersQueryKey({}) } },
  );

  const createMutation = useCreateCustomerRfq({
    mutation: {
      onSuccess: (rfq) => {
        queryClient.invalidateQueries({ queryKey: getListCustomerRfqsQueryKey() });
        if (rfq.numberAutoGenerated) {
          // Warning surfaced after a successful save: the customer RFQ number was
          // auto-generated because the field was left blank.
          navigate(`/customer-rfq/${rfq.id}?warn=auto-number`);
        } else {
          navigate(`/customer-rfq/${rfq.id}`);
        }
      },
      onError: (err: unknown) => {
        setServerError(getApiErrorMessage(err, "حدث خطأ أثناء حفظ طلب التسعير"));
      },
    },
  });

  const addItem = () =>
    setItems((prev) => [...prev, { partNo: "", lineItem: "", description: "", uom: "", qty: "" }]);

  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));

  const updateItem = (i: number, field: keyof ItemRow, value: string) =>
    setItems((prev) => prev.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    if (!customerName.trim()) {
      setServerError("اسم العميل مطلوب");
      return;
    }
    const validItems = items
      .filter((it) => (it.partNo.trim() || it.lineItem.trim()) && it.qty)
      .map((it) => ({
        partNo: it.partNo.trim() || undefined,
        lineItem: it.lineItem ? it.lineItem.replace(/\s+/g, "") : undefined,
        description: it.description.trim() || undefined,
        uom: it.uom.trim() || undefined,
        qty: it.qty ? Number(it.qty) : undefined,
      }));
    createMutation.mutate({
      data: {
        customerId: customerId ?? null,
        customerName: customerName.trim(),
        customerRfqNo: customerRfqNo.trim() || undefined,
        entryDate: entryDate || undefined,
        expiryDate: expiryDate || undefined,
        buyerName: buyerName.trim() || undefined,
        notes: notes.trim() || undefined,
        items: validItems,
      } as Parameters<typeof createMutation.mutate>[0]["data"],
    });
  };

  return (
    <Layout>
      <div className="p-4 sm:p-6 max-w-4xl space-y-5">
        <div className="flex items-center gap-3">
          <Link href="/customer-rfq">
            <a className="text-muted-foreground hover:text-foreground">
              <ArrowLeft size={18} />
            </a>
          </Link>
          <div>
            <h1 className="text-xl font-bold text-foreground">طلب تسعير عميل جديد</h1>
            <p className="text-muted-foreground text-sm">تسجيل طلب تسعير وارد من عميل</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Customer & RFQ info */}
          <div className="bg-card border border-border rounded-lg p-5 space-y-4">
            <h2 className="font-semibold text-sm text-foreground">بيانات الطلب</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>اسم العميل *</Label>
                <CustomerCombobox
                  value={customerName}
                  onChange={(v) => {
                    setCustomerName(v);
                    setCustomerId(null);
                  }}
                  onPick={(c) => {
                    setCustomerName(c.name);
                    setCustomerId(c.id);
                  }}
                  customers={customers}
                  isLoading={customersLoading}
                />
              </div>
              <div className="space-y-1.5">
                <Label>رقم طلب تسعير العميل</Label>
                <Input
                  value={customerRfqNo}
                  onChange={(e) => setCustomerRfqNo(e.target.value)}
                  placeholder="اتركه فارغاً لإنشائه تلقائياً"
                  dir="ltr"
                />
                <p className="text-xs text-muted-foreground">
                  إذا تُرك فارغاً ينشئ النظام رقماً تلقائياً مع رسالة تحذيرية عند الحفظ.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>تاريخ دخول الطلب</Label>
                <Input
                  type="date"
                  value={entryDate}
                  onChange={(e) => setEntryDate(e.target.value)}
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <Label>تاريخ انتهاء الطلب</Label>
                <Input
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <Label>المشتري / الموظف المسئول</Label>
                <Input
                  value={buyerName}
                  onChange={(e) => setBuyerName(e.target.value)}
                  placeholder="اسم الـ Buyer"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>ملاحظات</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="ملاحظات داخلية..."
                  rows={2}
                />
              </div>
            </div>
          </div>

          {/* Auto-number warning */}
          {customerRfqNo.trim() === "" && (
            <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded px-3 py-2">
              <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
              <span>
                رقم طلب التسعير فارغ — سيتم إنشاؤه تلقائياً عند الحفظ، وستظهر رسالة تحذيرية
                تؤكد ذلك.
              </span>
            </div>
          )}

          {/* Items */}
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
                <Plus size={13} /> إضافة بند
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-right">
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-8">#</th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-36">
                      Part No
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-40">
                      Line Item
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium">
                      التوصيف
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-28">
                      UOM
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-28">
                      الكمية
                    </th>
                    <th className="px-3 py-2 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row, i) => (
                    <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/20">
                      <td className="px-3 py-2 text-muted-foreground text-xs text-center">
                        {i + 1}
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.partNo}
                          onChange={(e) => updateItem(i, "partNo", e.target.value)}
                          className="h-7 text-xs"
                          placeholder="رقم الجزء"
                          dir="ltr"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.lineItem}
                          onChange={(e) => updateItem(i, "lineItem", e.target.value)}
                          className="h-7 text-xs"
                          placeholder="تُحذف المسافات تلقائياً"
                          dir="ltr"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.description}
                          onChange={(e) => updateItem(i, "description", e.target.value)}
                          className="h-7 text-xs"
                          placeholder="توصيف البند"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <UomInput
                          value={row.uom}
                          onChange={(v) => updateItem(i, "uom", v)}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.qty}
                          onChange={(e) => updateItem(i, "qty", e.target.value)}
                          className="h-7 text-xs"
                          type="number"
                          placeholder="0"
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
            <Link href="/customer-rfq">
              <a className="inline-flex items-center px-4 py-2 text-sm rounded border border-border text-muted-foreground hover:text-foreground">
                إلغاء
              </a>
            </Link>
            <Button
              type="submit"
              disabled={createMutation.isPending || !customerName.trim()}
            >
              {createMutation.isPending ? "جارٍ الحفظ..." : "حفظ طلب التسعير"}
            </Button>
          </div>
        </form>
      </div>
    </Layout>
  );
}

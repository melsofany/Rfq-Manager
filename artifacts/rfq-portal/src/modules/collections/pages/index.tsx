import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Banknote, AlertCircle, Clock, CheckCircle2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

interface CollectionRow {
  customerPoId: number;
  internalPoNo: string;
  customerPoNo: string;
  customerName: string | null;
  poDate: string | null;
  poStatus: string;
  receivable: string | null;
  collected: string | null;
  remaining: string | null;
  collectionStartDate: string | null;
  collectionDays: number | null;
  dueDate: string | null;
  status: string;
  statusLabel: string;
  statusTone: string;
}

interface CollectionDetail {
  customerPoId: number;
  internalPoNo: string;
  customerPoNo: string;
  customerName: string | null;
  receivable: string | null;
  collected: string | null;
  remaining: string | null;
  terms: {
    id: number;
    collectionStartDate: string | null;
    collectionDays: number;
    dueDate: string | null;
    notes: string | null;
  } | null;
  status: string;
  statusLabel: string;
  statusTone: string;
  payments: PaymentRow[];
}

interface PaymentRow {
  id: number;
  paymentDate: string;
  amount: string | null;
  method: string | null;
  reference: string | null;
  notes: string | null;
  employeeName: string | null;
}

const STATUS_FILTERS = [
  { value: "", label: "الكل" },
  { value: "overdue", label: "متأخر" },
  { value: "due_soon", label: "قريب الاستحقاق" },
  { value: "partial", label: "تحصيل جزئي" },
  { value: "pending", label: "مستحق للتحصيل" },
  { value: "collected", label: "تم التحصيل" },
];

function fmt(n: string | null): string {
  if (n == null) return "-";
  return Number(n).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusIcon(status: string) {
  switch (status) {
    case "overdue":
      return <AlertCircle size={14} className="text-red-600" />;
    case "due_soon":
      return <Clock size={14} className="text-amber-600" />;
    case "collected":
      return <CheckCircle2 size={14} className="text-emerald-600" />;
    default:
      return <Banknote size={14} className="text-muted-foreground" />;
  }
}

export default function CollectionsPage() {
  const [, navigate] = useLocation();
  const [rows, setRows] = useState<CollectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [alerts, setAlerts] = useState({ dueSoonCount: 0, overdueCount: 0 });

  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<CollectionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // terms form
  const [termsForm, setTermsForm] = useState({
    collectionStartDate: "",
    collectionDays: "30",
    notes: "",
  });
  const [savingTerms, setSavingTerms] = useState(false);

  // payment form
  const [payForm, setPayForm] = useState({
    paymentDate: new Date().toISOString().slice(0, 10),
    amount: "",
    method: "",
    reference: "",
    notes: "",
  });
  const [savingPay, setSavingPay] = useState(false);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (customerName) params.set("customerName", customerName);
    try {
      const r = await fetch(`/api/collections?${params.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error("fetch failed");
      setRows(await r.json());
      const a = await fetch("/api/collections/alerts", { credentials: "include" });
      if (a.ok) setAlerts(await a.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل التحصيلات"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openDetail(poId: number) {
    setDetailOpen(true);
    setDetailLoading(true);
    setPayForm({ ...payForm, amount: "" });
    try {
      const r = await fetch(`/api/collections/${poId}`, { credentials: "include" });
      if (!r.ok) throw new Error("fetch failed");
      const d: CollectionDetail = await r.json();
      setDetail(d);
      setTermsForm({
        collectionStartDate: d.terms?.collectionStartDate ?? new Date().toISOString().slice(0, 10),
        collectionDays: String(d.terms?.collectionDays ?? 30),
        notes: d.terms?.notes ?? "",
      });
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل التفاصيل"));
    } finally {
      setDetailLoading(false);
    }
  }

  async function saveTerms() {
    if (!detail) return;
    setSavingTerms(true);
    try {
      const r = await fetch(`/api/collections/${detail.customerPoId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          collectionStartDate: termsForm.collectionStartDate || null,
          collectionDays: Number(termsForm.collectionDays) || 30,
          notes: termsForm.notes || null,
        }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error ?? "فشل الحفظ");
      }
      toast.success("تم حفظ شروط التحصيل");
      openDetail(detail.customerPoId);
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الحفظ"));
    } finally {
      setSavingTerms(false);
    }
  }

  async function addPayment() {
    if (!detail) return;
    if (!payForm.amount || Number(payForm.amount) <= 0) {
      toast.error("أدخل قيمة الدفعة");
      return;
    }
    setSavingPay(true);
    try {
      const r = await fetch(`/api/collections/${detail.customerPoId}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          paymentDate: payForm.paymentDate,
          amount: Number(payForm.amount),
          method: payForm.method || null,
          reference: payForm.reference || null,
          notes: payForm.notes || null,
        }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error ?? "فشل تسجيل الدفعة");
      }
      toast.success("تم تسجيل الدفعة");
      setPayForm({ ...payForm, amount: "" });
      openDetail(detail.customerPoId);
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تسجيل الدفعة"));
    } finally {
      setSavingPay(false);
    }
  }

  async function deletePayment(id: number) {
    if (!confirm("هل أنت متأكد من حذف هذه الدفعة؟")) return;
    try {
      const r = await fetch(`/api/collections/payments/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error ?? "فشل الحذف");
      }
      toast.success("تم حذف الدفعة");
      if (detail) openDetail(detail.customerPoId);
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الحذف (يتطلب صلاحية مدير)"));
    }
  }

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Banknote size={20} className="text-primary" />
            تحصيل مستحقات العملاء
          </h1>
          <p className="text-muted-foreground text-sm">
            متابعة تحصيل دفعات العملاء وحساب تاريخ الاستحقاق والتنبيهات
          </p>
        </div>

        {/* Alert summary */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2">
            <AlertCircle size={18} className="text-red-600" />
            <div>
              <p className="text-xs text-red-700">متأخرات</p>
              <p className="text-lg font-bold text-red-700">{alerts.overdueCount}</p>
            </div>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-center gap-2">
            <Clock size={18} className="text-amber-600" />
            <div>
              <p className="text-xs text-amber-700">قريب الاستحقاق</p>
              <p className="text-lg font-bold text-amber-700">{alerts.dueSoonCount}</p>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <Input
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="بحث باسم العميل..."
            className="h-8 text-sm max-w-xs"
          />
          <div className="flex gap-1 overflow-x-auto pb-0.5 flex-nowrap">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s.value}
                onClick={() => setStatusFilter(s.value)}
                className={`px-3 py-1 text-xs rounded-md border whitespace-nowrap ${
                  statusFilter === s.value
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <Button onClick={load} size="sm" className="gap-1.5">
            تحديث
          </Button>
        </div>

        {/* List */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
          ) : rows.length === 0 ? (
            <div className="p-12 text-center">
              <Banknote size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground text-sm">لا توجد تحصيلات</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-left">
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">أمر الشراء</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">العميل</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">المستحق</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">المحصّل</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">المتبقي</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">تاريخ الاستحقاق</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.customerPoId}
                      className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                      onClick={() => openDetail(r.customerPoId)}
                    >
                      <td className="px-3 py-3 font-mono text-xs text-primary">{r.internalPoNo}</td>
                      <td className="px-3 py-3 text-xs">{r.customerName ?? "-"}</td>
                      <td className="px-3 py-3 text-xs">{fmt(r.receivable)}</td>
                      <td className="px-3 py-3 text-xs text-emerald-600">{fmt(r.collected)}</td>
                      <td className="px-3 py-3 text-xs font-medium text-amber-600">{fmt(r.remaining)}</td>
                      <td className="px-3 py-3 text-xs text-muted-foreground">{r.dueDate ?? "-"}</td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${r.statusTone}`}>
                          {statusIcon(r.status)}
                          {r.statusLabel}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Detail dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>تحصيل أمر الشراء</DialogTitle>
          </DialogHeader>
          {detailLoading || !detail ? (
            <div className="p-6 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
          ) : (
            <div className="space-y-4">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-sm text-primary">{detail.internalPoNo}</p>
                  <p className="text-xs text-muted-foreground">{detail.customerName ?? "-"}</p>
                </div>
                <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs ${detail.statusTone}`}>
                  {statusIcon(detail.status)}
                  {detail.statusLabel}
                </span>
              </div>

              {/* Amounts */}
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-muted/30 rounded-md p-2.5">
                  <p className="text-xs text-muted-foreground">المستحق</p>
                  <p className="font-bold">{fmt(detail.receivable)}</p>
                </div>
                <div className="bg-emerald-50 rounded-md p-2.5">
                  <p className="text-xs text-emerald-700">المحصّل</p>
                  <p className="font-bold text-emerald-700">{fmt(detail.collected)}</p>
                </div>
                <div className="bg-amber-50 rounded-md p-2.5">
                  <p className="text-xs text-amber-700">المتبقي</p>
                  <p className="font-bold text-amber-700">{fmt(detail.remaining)}</p>
                </div>
              </div>

              {/* Terms */}
              <div className="border-t border-border pt-3">
                <p className="text-sm font-medium mb-2">شروط التحصيل</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1">تاريخ بدء التحصيل</Label>
                    <Input
                      type="date"
                      value={termsForm.collectionStartDate}
                      onChange={(e) => setTermsForm({ ...termsForm, collectionStartDate: e.target.value })}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1">عدد أيام التحصيل</Label>
                    <Input
                      type="number"
                      value={termsForm.collectionDays}
                      onChange={(e) => setTermsForm({ ...termsForm, collectionDays: e.target.value })}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
                <div className="mt-2">
                  <Label className="text-xs text-muted-foreground mb-1">ملاحظات</Label>
                  <Textarea
                    value={termsForm.notes}
                    onChange={(e) => setTermsForm({ ...termsForm, notes: e.target.value })}
                    className="text-sm"
                    rows={2}
                  />
                </div>
                <Button onClick={saveTerms} disabled={savingTerms} size="sm" className="mt-2">
                  {savingTerms ? "جارٍ الحفظ..." : "حفظ الشروط"}
                </Button>
                {detail.terms?.dueDate && (
                  <p className="text-xs text-muted-foreground mt-2">
                    تاريخ الاستحقاق المحسوب: <span className="font-medium">{detail.terms.dueDate}</span>
                  </p>
                )}
              </div>

              {/* Record payment */}
              <div className="border-t border-border pt-3">
                <p className="text-sm font-medium mb-2">تسجيل دفعة</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1">تاريخ الدفعة</Label>
                    <Input
                      type="date"
                      value={payForm.paymentDate}
                      onChange={(e) => setPayForm({ ...payForm, paymentDate: e.target.value })}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1">القيمة</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={payForm.amount}
                      onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1">طريقة الدفع</Label>
                    <Input
                      value={payForm.method}
                      onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}
                      className="h-8 text-sm"
                      placeholder="تحويل / شيك / نقد"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1">مرجع</Label>
                    <Input
                      value={payForm.reference}
                      onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
                <Button onClick={addPayment} disabled={savingPay} size="sm" className="mt-2 gap-1.5">
                  <Plus size={14} />
                  {savingPay ? "جارٍ التسجيل..." : "تسجيل الدفعة"}
                </Button>
              </div>

              {/* Payments history */}
              <div className="border-t border-border pt-3">
                <p className="text-sm font-medium mb-2">سجل الدفعات</p>
                {detail.payments.length === 0 ? (
                  <p className="text-xs text-muted-foreground">لا توجد دفعات مسجّلة</p>
                ) : (
                  <div className="space-y-1.5">
                    {detail.payments.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between bg-muted/30 rounded-md px-3 py-2"
                      >
                        <div>
                          <p className="text-xs font-medium text-emerald-700">{fmt(p.amount)}</p>
                          <p className="text-xs text-muted-foreground">
                            {p.paymentDate}
                            {p.method ? ` · ${p.method}` : ""}
                            {p.reference ? ` · ${p.reference}` : ""}
                          </p>
                        </div>
                        <button
                          onClick={() => deletePayment(p.id)}
                          className="text-red-600 hover:text-red-700 p-1"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => navigate(`/customer-po/${detail.customerPoId}`)}
                  size="sm"
                >
                  عرض أمر الشراء
                </Button>
                <Button variant="outline" onClick={() => setDetailOpen(false)} size="sm">
                  إغلاق
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Layout>
  );
}

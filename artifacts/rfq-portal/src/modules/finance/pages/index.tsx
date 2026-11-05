import { useEffect, useState } from "react";
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
import {
  Banknote,
  Landmark,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Trash2,
  Receipt,
  History,
  Printer,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";
import { money } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { canConfirmPayment } from "@/lib/permissions";

interface PaymentRow {
  id: number;
  /** `PAY-YYYY-NNNNNN` — the printed payment order's reference. */
  paymentNo: string | null;
  amount: string | null;
  paymentDate: string;
  method: string;
  reference: string | null;
  notes: string | null;
  employeeName: string | null;
  createdAt: string;
}

interface FinanceRequest {
  id: number;
  poId: number;
  supplierId: number;
  poNo: string | null;
  internalPoNo: string | null;
  supplierName: string;
  dueAmount: string;
  paidAmount: string;
  remainingAmount: string;
  status: string;
  bank: {
    bankName: string | null;
    bankAccountHolder: string | null;
    bankAccountNumber: string | null;
    iban: string | null;
    swiftCode: string | null;
    bankBranch: string | null;
  };
  hasBankDetails: boolean;
  notes: string | null;
  selectedByName: string | null;
  selectedAt: string;
  paidAt: string | null;
  payments: PaymentRow[];
}

interface Summary {
  totalDue: string;
  totalPaid: string;
  remaining: string;
  openCount: number;
  paidCount: number;
  count: number;
}

const STATUS_FILTERS = [
  { value: "", label: "الكل" },
  { value: "unpaid", label: "لم يُسدد" },
  { value: "partial", label: "سداد جزئي" },
  { value: "paid", label: "تم السداد" },
];

const PAYMENT_METHODS = ["تحويل بنكي", "شيك", "نقدية", "محفظة إلكترونية", "أخرى"];

function statusBadge(status: string) {
  switch (status) {
    case "paid":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
          <CheckCircle2 size={12} /> تم السداد
        </span>
      );
    case "partial":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
          <Clock size={12} /> سداد جزئي
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
          <AlertTriangle size={12} /> لم يُسدد
        </span>
      );
  }
}

function BankDetails({ r }: { r: FinanceRequest }) {
  if (!r.hasBankDetails) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
        بيانات بنكية غير مكتملة — يُطلب استكمال بيانات المورد قبل السداد
      </div>
    );
  }
  const rows: [string, string | null][] = [
    ["البنك", r.bank.bankName],
    ["اسم صاحب الحساب", r.bank.bankAccountHolder],
    ["رقم الحساب", r.bank.bankAccountNumber],
    ["IBAN", r.bank.iban],
    ["SWIFT", r.bank.swiftCode],
    ["الفرع", r.bank.bankBranch],
  ];
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
      {rows
        .filter(([, v]) => v)
        .map(([label, v]) => (
          <div key={label} className="flex gap-1">
            <span className="text-muted-foreground">{label}:</span>
            <span className="font-medium break-all" dir="ltr">
              {v}
            </span>
          </div>
        ))}
    </div>
  );
}

export default function FinancePage() {
  const { employee } = useAuth();
  const [rows, setRows] = useState<FinanceRequest[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");

  const mayConfirm = canConfirmPayment(employee?.role, employee?.permissions);

  // payment dialog
  const [payOpen, setPayOpen] = useState(false);
  const [target, setTarget] = useState<FinanceRequest | null>(null);
  const [payForm, setPayForm] = useState({
    paymentDate: new Date().toISOString().slice(0, 10),
    amount: "",
    method: PAYMENT_METHODS[0],
    reference: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      const [r, s] = await Promise.all([
        fetch(`/api/finance/requests?${params.toString()}`, { credentials: "include" }),
        fetch("/api/finance/summary", { credentials: "include" }),
      ]);
      if (!r.ok) throw new Error("fetch failed");
      setRows(await r.json());
      if (s.ok) setSummary(await s.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل الماليات"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  function openPay(row: FinanceRequest) {
    setTarget(row);
    setPayForm({
      paymentDate: new Date().toISOString().slice(0, 10),
      amount: row.remainingAmount,
      method: PAYMENT_METHODS[0],
      reference: "",
      notes: "",
    });
    setPayOpen(true);
  }

  async function submitPayment() {
    if (!target) return;
    const amount = Number(payForm.amount);
    if (!(amount > 0)) {
      toast.error("أدخل مبلغًا صحيحًا");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/finance/requests/${target.id}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          amount,
          paymentDate: payForm.paymentDate,
          method: payForm.method,
          reference: payForm.reference || null,
          notes: payForm.notes || null,
        }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error ?? "فشل تسجيل السداد");
      }
      const body = await r.json();
      toast.success(body.settled ? "تم تأكيد سداد أمر الشراء بالكامل" : "تم تسجيل سداد جزئي");
      setPayOpen(false);
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تسجيل السداد"));
    } finally {
      setSaving(false);
    }
  }

  async function removePayment(row: FinanceRequest, paymentId: number) {
    if (!confirm("حذف هذا السداد؟")) return;
    try {
      const r = await fetch(`/api/finance/payments/${paymentId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error ?? "فشل الحذف");
      }
      toast.success("تم حذف السداد");
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل حذف السداد"));
    }
  }

  async function removeRequest(row: FinanceRequest) {
    if (!confirm(`إزالة ${row.supplierName} من الماليات؟`)) return;
    try {
      const r = await fetch(`/api/finance/requests/${row.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error ?? "فشل الحذف");
      }
      toast.success("تمت الإزالة من الماليات");
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الحذف"));
    }
  }

  const filtered = rows.filter((r) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      r.supplierName.toLowerCase().includes(q) ||
      (r.poNo ?? "").toLowerCase().includes(q) ||
      (r.internalPoNo ?? "").toLowerCase().includes(q)
    );
  });

  /**
   * The PDFs are served by the API, not built in the browser, so the print
   * dialog gets the exact document the server generated. The tab is opened
   * first (a synchronous response to the click) so the pop-up blocker does not
   * swallow it, then pointed at the URL.
   */
  function openPdfTab(url: string) {
    const tab = window.open("", "_blank");
    if (!tab) {
      toast.error("المتصفح منع فتح نافذة الطباعة — اسمح بالنوافذ المنبثقة");
      return;
    }
    tab.location.href = url;
  }

  function printPaymentOrder(paymentId: number) {
    openPdfTab(`/api/finance/payments/${paymentId}/pdf`);
  }

  function printStatement(supplierId: number) {
    openPdfTab(`/api/finance/suppliers/${supplierId}/statement.pdf`);
  }

  return (
    <Layout>
      <div className="space-y-5 p-1">
        <div className="flex items-center gap-2">
          <Banknote className="text-emerald-600" />
          <h1 className="text-xl font-bold text-foreground">الماليات</h1>
          <span className="text-sm text-muted-foreground">
            سداد أوامر الشراء للموردين — لكل مورد مبلغه وبياناته البنكية
          </span>
        </div>

        {/* Summary cards */}
        {summary && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-muted-foreground">إجمالي المستحق</p>
              <p className="text-lg font-bold">{money(summary.totalDue)}</p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-muted-foreground">إجمالي المسدَّد</p>
              <p className="text-lg font-bold text-emerald-700">{money(summary.totalPaid)}</p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-muted-foreground">المتبقي</p>
              <p className="text-lg font-bold text-red-700">{money(summary.remaining)}</p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-muted-foreground">مفتوح / مسدَّد</p>
              <p className="text-lg font-bold">
                {summary.openCount} / {summary.paidCount}
              </p>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث بالمورد أو رقم أمر الشراء..."
            className="sm:max-w-xs"
          />
          <div className="flex gap-2">
            {STATUS_FILTERS.map((f) => (
              <Button
                key={f.value}
                size="sm"
                variant={statusFilter === f.value ? "default" : "outline"}
                onClick={() => setStatusFilter(f.value)}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </div>

        {/* List */}
        {loading ? (
          <p className="py-10 text-center text-muted-foreground">جارٍ التحميل...</p>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed py-14 text-center">
            <Receipt className="mx-auto mb-2 text-muted-foreground" />
            <p className="text-muted-foreground">
              لا توجد أوامر شراء في الماليات. اختر أوامر الشراء من صفحة أوامر الشراء وأضفها.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((r) => (
              <div key={r.id} className="rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Landmark size={16} className="text-muted-foreground" />
                      <span className="font-semibold">{r.supplierName}</span>
                      {statusBadge(r.status)}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      أمر الشراء: <span dir="ltr">{r.internalPoNo ?? `#${r.poId}`}</span>
                      {r.poNo ? (
                        <>
                          {" · "}
                          <span dir="ltr">{r.poNo}</span>
                        </>
                      ) : null}
                      {r.selectedByName ? ` · أضافه ${r.selectedByName}` : ""}
                    </p>
                  </div>

                  <div className="text-end">
                    <p className="text-xs text-muted-foreground">المستحق</p>
                    <p className="text-lg font-bold">{money(r.dueAmount)}</p>
                    <p className="text-xs text-muted-foreground">
                      مسدَّد {money(r.paidAmount)} · متبقٍ {money(r.remainingAmount)}
                    </p>
                  </div>
                </div>

                <div className="mt-3 rounded-md bg-muted/40 p-2">
                  <BankDetails r={r} />
                </div>

                {r.payments.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <History size={12} /> سجل السداد
                    </p>
                    <div className="space-y-1">
                      {r.payments.map((p) => (
                        <div
                          key={p.id}
                          className="flex items-center justify-between gap-2 rounded border bg-background px-2 py-1 text-xs"
                        >
                          <span dir="ltr" className="font-mono text-[11px] text-primary">
                            {p.paymentNo ?? "-"}
                          </span>
                          <span dir="ltr">{p.paymentDate}</span>
                          <span className="font-medium">{money(p.amount)}</span>
                          <span className="text-muted-foreground">{p.method}</span>
                          <span className="text-muted-foreground">{p.employeeName ?? "-"}</span>
                          <span className="ms-auto flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-1"
                              title="طباعة أمر الدفع"
                              onClick={() => printPaymentOrder(p.id)}
                            >
                              <Printer size={12} />
                            </Button>
                            {mayConfirm && r.status !== "paid" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-1 text-red-600"
                                onClick={() => removePayment(r, p.id)}
                              >
                                <Trash2 size={12} />
                              </Button>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  {mayConfirm && r.status !== "paid" && (
                    <Button size="sm" onClick={() => openPay(r)}>
                      <Banknote size={14} className="me-1" /> تأكيد السداد
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => printStatement(r.supplierId)}>
                    <FileText size={14} className="me-1" /> كشف حساب المورد
                  </Button>
                  {r.status === "paid" && (
                    <span className="text-xs text-emerald-700">
                      تم السداد بالكامل — لا يمكن السداد مرة أخرى
                    </span>
                  )}
                  {r.paidAmount === "0" && (
                    <Button size="sm" variant="outline" onClick={() => removeRequest(r)}>
                      <Trash2 size={14} className="me-1" /> إزالة من الماليات
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Payment dialog */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>تأكيد السداد — {target?.supplierName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md bg-muted/40 p-2 text-sm">
              <span className="text-muted-foreground">المتبقي: </span>
              <span className="font-bold">{money(target?.remainingAmount)}</span>
            </div>
            <div>
              <Label>المبلغ</Label>
              <Input
                type="number"
                step="0.01"
                value={payForm.amount}
                onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                يمكن إدخال مبلغ أقل من المتبقي لسداد جزئي.
              </p>
            </div>
            <div>
              <Label>تاريخ السداد</Label>
              <Input
                type="date"
                value={payForm.paymentDate}
                onChange={(e) => setPayForm({ ...payForm, paymentDate: e.target.value })}
              />
            </div>
            <div>
              <Label>طريقة السداد</Label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={payForm.method}
                onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>المرجع (اختياري)</Label>
              <Input
                value={payForm.reference}
                onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })}
                placeholder="رقم الحوالة / الشيك"
              />
            </div>
            <div>
              <Label>ملاحظات (اختياري)</Label>
              <Textarea
                value={payForm.notes}
                onChange={(e) => setPayForm({ ...payForm, notes: e.target.value })}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayOpen(false)}>
              إلغاء
            </Button>
            <Button onClick={submitPayment} disabled={saving}>
              {saving ? "جارٍ الحفظ..." : "تأكيد السداد"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}

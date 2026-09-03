import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { BookCopy, Plus, Eye, CheckCircle, Send, XCircle, Trash2, Wallet } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

interface Account {
  id: number;
  code: string;
  nameAr: string;
  type: string;
  isActive: boolean;
}

interface JournalEntry {
  id: number;
  entryNo: string;
  entryDate: string;
  description: string;
  source: string | null;
  status: string;
  totalDebit: string | null;
  totalCredit: string | null;
  employeeName: string | null;
  reviewedByName: string | null;
  postedAt: string | null;
}

interface JournalDetail {
  id: number;
  entryNo: string;
  entryDate: string;
  description: string;
  source: string | null;
  status: string;
  totalDebit: string | null;
  totalCredit: string | null;
  employeeName: string | null;
  reviewedByName: string | null;
  postedAt: string | null;
  lines: Array<{
    id: number;
    accountCode: string;
    accountName: string | null;
    accountType: string | null;
    lineNo: number;
    description: string | null;
    debit: string | null;
    credit: string | null;
  }>;
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  draft: { label: "مسودة", cls: "bg-amber-100 text-amber-700" },
  posted: { label: "مُرحّل", cls: "bg-emerald-100 text-emerald-700" },
  void: { label: "ملغى", cls: "bg-muted text-muted-foreground" },
};

const SOURCE_LABELS: Record<string, string> = {
  manual: "يدوي",
  supplier_invoice: "فاتورة مورد",
  supplier_payment: "سند صرف",
  sales_invoice: "فاتورة بيع",
  operating_expense: "مصروف تشغيلي",
};

/** خريطة أنواع المصروفات إلى أكواد الحسابات (تطابق accounts/integration.ts). */
const EXPENSE_CATEGORIES: { code: string; label: string }[] = [
  { code: "5300", label: "إيجارات" },
  { code: "5401", label: "كهرباء" },
  { code: "5402", label: "مياه" },
  { code: "5412", label: "انترنت" },
  { code: "5700", label: "دومينات واستضافة وخدمات تقنية" },
  { code: "5750", label: "اشتراكات ودعم فني" },
  { code: "5805", label: "نقل وتنقل" },
  { code: "5410", label: "اتصالات" },
  { code: "5990", label: "نثريات" },
  { code: "5500", label: "صيانة" },
  { code: "5600", label: "مصروفات إدارية" },
  { code: "5200", label: "رواتب" },
  { code: "5900", label: "عمولات ومصاريف بنكية" },
  { code: "5990", label: "أخرى" },
];

const PAYMENT_METHODS = [
  { code: "1001", label: "نقدية (الخزينة)" },
  { code: "1010", label: "تحويل بنكي" },
];

export default function JournalTab() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ from: "", to: "", status: "" });
  const [createOpen, setCreateOpen] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [detail, setDetail] = useState<JournalDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [form, setForm] = useState({
    entryDate: new Date().toISOString().slice(0, 10),
    description: "",
    lines: [{ accountCode: "", description: "", debit: "", credit: "" }, { accountCode: "", description: "", debit: "", credit: "" }],
  });
  const [expenseForm, setExpenseForm] = useState({
    expenseDate: new Date().toISOString().slice(0, 10),
    category: EXPENSE_CATEGORIES[0].label,
    expenseAccountCode: EXPENSE_CATEGORIES[0].code,
    cashAccountCode: PAYMENT_METHODS[0].code,
    amount: "",
    description: "",
    post: true,
  });

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.status) params.set("status", filters.status);
    const qs = params.toString();
    try {
      const r = await fetch(`/api/accounts/journal${qs ? `?${qs}` : ""}`, { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل القيود");
      setEntries(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل القيود"));
    } finally {
      setLoading(false);
    }
  }

  async function loadAccounts() {
    try {
      const r = await fetch("/api/accounts/coa", { credentials: "include" });
      if (r.ok) setAccounts(await r.json());
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    load();
    loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openDetail(id: number) {
    try {
      const r = await fetch(`/api/accounts/journal/${id}`, { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل تفاصيل القيد");
      setDetail(await r.json());
      setDetailOpen(true);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل التفاصيل"));
    }
  }

  async function create() {
    const debit = form.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
    const credit = form.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
    if (Math.abs(debit - credit) > 0.01) {
      toast.error(`القيد غير متوازن: مدين ${debit} ≠ دائن ${credit}`);
      return;
    }
    try {
      const r = await fetch("/api/accounts/journal", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryDate: form.entryDate, description: form.description, status: "draft", lines: form.lines }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "فشل الإنشاء");
      }
      toast.success("تم إنشاء القيد (مسودة)");
      setCreateOpen(false);
      setForm({ entryDate: new Date().toISOString().slice(0, 10), description: "", lines: [{ accountCode: "", description: "", debit: "", credit: "" }, { accountCode: "", description: "", debit: "", credit: "" }] });
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الإنشاء"));
    }
  }

  async function createExpense() {
    const amount = Number(expenseForm.amount);
    if (!amount || amount <= 0) {
      toast.error("أدخل مبلغًا صحيحًا");
      return;
    }
    if (!expenseForm.expenseAccountCode || !expenseForm.cashAccountCode) {
      toast.error("اختر حساب المصروف وطريقة السداد");
      return;
    }
    const desc = expenseForm.description
      ? `${expenseForm.category} — ${expenseForm.description}`
      : expenseForm.category;
    try {
      const r = await fetch("/api/accounts/journal", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryDate: expenseForm.expenseDate,
          description: `مصروف تشغيلي — ${desc}`,
          status: expenseForm.post ? "posted" : "draft",
          lines: [
            { accountCode: expenseForm.expenseAccountCode, description: expenseForm.category, debit: amount },
            { accountCode: expenseForm.cashAccountCode, description: "سداد مصروف", credit: amount },
          ],
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "فشل تسجيل المصروف");
      }
      toast.success(expenseForm.post ? "تم تسجيل المصروف وترحيل القيد" : "تم إنشاء قيد المصروف (مسودة)");
      setExpenseOpen(false);
      setExpenseForm({
        expenseDate: new Date().toISOString().slice(0, 10),
        category: EXPENSE_CATEGORIES[0].label,
        expenseAccountCode: EXPENSE_CATEGORIES[0].code,
        cashAccountCode: PAYMENT_METHODS[0].code,
        amount: "",
        description: "",
        post: true,
      });
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تسجيل المصروف"));
    }
  }

  async function review(id: number) {
    try {
      const r = await fetch(`/api/accounts/journal/${id}/review`, { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error("فشلت المراجعة");
      toast.success("تم اعتماد القيد");
      load();
      openDetail(id);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشلت المراجعة"));
    }
  }

  async function post(id: number) {
    try {
      const r = await fetch(`/api/accounts/journal/${id}/post`, { method: "POST", credentials: "include" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "فشل الترحيل");
      }
      toast.success("تم ترحيل القيد");
      load();
      openDetail(id);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الترحيل"));
    }
  }

  async function voidEntry(id: number) {
    if (!confirm("هل أنت متأكد من إلغاء هذا القيد؟ الإجراء يتطلب صلاحية مدير.")) return;
    try {
      const r = await fetch(`/api/accounts/journal/${id}/void`, { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error("فشل الإلغاء");
      toast.success("تم إلغاء القيد");
      load();
      setDetailOpen(false);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الإلغاء"));
    }
  }

  const totalDebit = form.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = form.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          قيود اليومية بالقيد المزدوج — إنشاء، مراجعة، وترحيل. القيد المُرحّل غير قابل للتعديل.
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
          <Plus size={14} /> قيد جديد
        </Button>
        <Button size="sm" variant="outline" onClick={() => setExpenseOpen(true)} className="gap-1.5">
          <Wallet size={14} /> قيد مصروف سريع
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div>
          <Label className="text-xs mb-1 block">من تاريخ</Label>
          <Input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} className="h-8 text-sm w-40" />
        </div>
        <div>
          <Label className="text-xs mb-1 block">إلى تاريخ</Label>
          <Input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} className="h-8 text-sm w-40" />
        </div>
        <div>
          <Label className="text-xs mb-1 block">الحالة</Label>
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-sm">
            <option value="">الكل</option>
            <option value="draft">مسودة</option>
            <option value="posted">مُرحّل</option>
            <option value="void">ملغى</option>
          </select>
        </div>
        <Button onClick={load} size="sm" className="gap-1.5">تحديث</Button>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
        ) : entries.length === 0 ? (
          <div className="p-12 text-center">
            <BookCopy size={40} className="mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-muted-foreground text-sm">لا توجد قيود</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">رقم القيد</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">التاريخ</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الوصف</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">المصدر</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">المبلغ</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الحالة</th>
                  <th className="px-3 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-3 py-2.5 font-mono text-xs text-primary">{e.entryNo}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{e.entryDate}</td>
                    <td className="px-3 py-2.5 text-xs max-w-xs truncate">{e.description}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{e.source ? SOURCE_LABELS[e.source] ?? e.source : "—"}</td>
                    <td className="px-3 py-2.5 text-xs font-medium">{e.totalDebit ?? "-"}</td>
                    <td className="px-3 py-2.5">
                      <span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_LABELS[e.status]?.cls ?? "bg-muted"}`}>
                        {STATUS_LABELS[e.status]?.label ?? e.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-left">
                      <Button size="sm" variant="ghost" onClick={() => openDetail(e.id)} className="h-7 px-2">
                        <Eye size={13} />
                      </Button>
                      {e.status === "draft" && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => review(e.id)} className="h-7 px-2" title="اعتماد">
                            <CheckCircle size={13} className="text-amber-600" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => post(e.id)} className="h-7 px-2" title="ترحيل">
                            <Send size={13} className="text-emerald-600" />
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>قيد يومية جديد (مسودة)</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">التاريخ</Label>
                <Input type="date" value={form.entryDate} onChange={(e) => setForm({ ...form, entryDate: e.target.value })} className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-xs">الوصف</Label>
                <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="h-8 text-sm" placeholder="قيد ..." />
              </div>
            </div>
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/30">
                  <tr className="text-left">
                    <th className="px-2 py-2 text-muted-foreground text-xs font-medium">الحساب</th>
                    <th className="px-2 py-2 text-muted-foreground text-xs font-medium">البيان</th>
                    <th className="px-2 py-2 text-muted-foreground text-xs font-medium w-24">مدين</th>
                    <th className="px-2 py-2 text-muted-foreground text-xs font-medium w-24">دائن</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {form.lines.map((l, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="px-2 py-1.5">
                        <select value={l.accountCode} onChange={(e) => updateLine(i, "accountCode", e.target.value)} className="w-full h-7 rounded border border-input bg-background px-1 text-xs">
                          <option value="">— اختر —</option>
                          {accounts.filter((a) => a.isActive).map((a) => (
                            <option key={a.id} value={a.code}>{a.code} — {a.nameAr}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1.5">
                        <Input value={l.description} onChange={(e) => updateLine(i, "description", e.target.value)} className="h-7 text-xs" />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input type="number" value={l.debit} onChange={(e) => updateLine(i, "debit", e.target.value)} className="h-7 text-xs" />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input type="number" value={l.credit} onChange={(e) => updateLine(i, "credit", e.target.value)} className="h-7 text-xs" />
                      </td>
                      <td className="px-1">
                        {form.lines.length > 2 && (
                          <Button size="sm" variant="ghost" onClick={() => removeLine(i)} className="h-7 px-1">
                            <Trash2 size={12} className="text-red-500" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-muted/20">
                    <td colSpan={2} className="px-2 py-2 text-xs text-left">
                      <Button size="sm" variant="outline" onClick={addLine} className="h-7 gap-1">
                        <Plus size={12} /> إضافة بند
                      </Button>
                    </td>
                    <td className="px-2 py-2 text-xs font-bold">{totalDebit.toFixed(2)}</td>
                    <td className="px-2 py-2 text-xs font-bold">{totalCredit.toFixed(2)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className={`text-xs font-medium ${Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0 ? "text-emerald-600" : "text-red-600"}`}>
              {Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0
                ? "✓ القيد متوازن"
                : `⚠ القيد غير متوازن (الفرق: ${Math.abs(totalDebit - totalCredit).toFixed(2)})`}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>إلغاء</Button>
            <Button onClick={create}>حفظ كمسودة</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick expense dialog */}
      <Dialog open={expenseOpen} onOpenChange={setExpenseOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>قيد مصروف سريع</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-muted-foreground text-xs">
              تسجيل مصروف تشغيلي كقيد يومية مزدوج: من ح/ المصروف إلى ح/ النقدية أو البنك. القيد يظهر في
              قيود اليومية والقوائم المالية مباشرة.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">التاريخ</Label>
                <Input
                  type="date"
                  value={expenseForm.expenseDate}
                  onChange={(e) => setExpenseForm({ ...expenseForm, expenseDate: e.target.value })}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs">المبلغ</Label>
                <Input
                  type="number"
                  value={expenseForm.amount}
                  onChange={(e) => setExpenseForm({ ...expenseForm, amount: e.target.value })}
                  className="h-8 text-sm"
                  placeholder="0.00"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">نوع المصروف (الحساب المدين)</Label>
              <select
                value={expenseForm.expenseAccountCode}
                onChange={(e) => {
                  const opt = EXPENSE_CATEGORIES.find((c) => c.code === e.target.value);
                  setExpenseForm({ ...expenseForm, expenseAccountCode: e.target.value, category: opt?.label ?? "أخرى" });
                }}
                className="w-full h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={`${c.label}-${c.code}`} value={c.code}>{c.label} — {c.code}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">طريقة السداد (الحساب الدائن)</Label>
              <select
                value={expenseForm.cashAccountCode}
                onChange={(e) => setExpenseForm({ ...expenseForm, cashAccountCode: e.target.value })}
                className="w-full h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.code} value={m.code}>{m.label} — {m.code}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">بيان تفصيلي (اختياري)</Label>
              <Textarea
                value={expenseForm.description}
                onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })}
                className="text-sm"
                rows={2}
                placeholder="تفاصيل المصروف..."
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={expenseForm.post}
                onChange={(e) => setExpenseForm({ ...expenseForm, post: e.target.checked })}
                className="rounded"
              />
              ترحيل القيد مباشرةً (مُرحّل) — ألغِ التحديد لحفظه كمسودة للمراجعة
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExpenseOpen(false)}>إلغاء</Button>
            <Button onClick={createExpense}>تسجيل المصروف</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>تفاصيل القيد {detail?.entryNo}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-muted-foreground">التاريخ: </span>{detail.entryDate}</div>
                <div><span className="text-muted-foreground">المصدر: </span>{detail.source ? SOURCE_LABELS[detail.source] ?? detail.source : "يدوي"}</div>
                <div><span className="text-muted-foreground">المُدخِل: </span>{detail.employeeName ?? "—"}</div>
                <div><span className="text-muted-foreground">المُراجِع: </span>{detail.reviewedByName ?? "—"}</div>
              </div>
              <div className="text-sm font-medium border border-border rounded p-2">{detail.description}</div>
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 text-left">
                    <tr>
                      <th className="px-2 py-2 text-muted-foreground text-xs">الحساب</th>
                      <th className="px-2 py-2 text-muted-foreground text-xs">البيان</th>
                      <th className="px-2 py-2 text-muted-foreground text-xs">مدين</th>
                      <th className="px-2 py-2 text-muted-foreground text-xs">دائن</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((l) => (
                      <tr key={l.id} className="border-t border-border">
                        <td className="px-2 py-2 text-xs"><span className="font-mono text-primary">{l.accountCode}</span> {l.accountName}</td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">{l.description ?? "—"}</td>
                        <td className="px-2 py-2 text-xs">{l.debit ?? "—"}</td>
                        <td className="px-2 py-2 text-xs">{l.credit ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border bg-muted/20">
                      <td colSpan={2} className="px-2 py-2 text-xs font-bold text-left">الإجمالي</td>
                      <td className="px-2 py-2 text-xs font-bold">{detail.totalDebit}</td>
                      <td className="px-2 py-2 text-xs font-bold">{detail.totalCredit}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="flex items-center justify-between">
                <span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_LABELS[detail.status]?.cls}`}>{STATUS_LABELS[detail.status]?.label}</span>
                <div className="flex gap-2">
                  {detail.status === "draft" && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => review(detail.id)} className="gap-1.5">
                        <CheckCircle size={14} className="text-amber-600" /> اعتماد
                      </Button>
                      <Button size="sm" onClick={() => post(detail.id)} className="gap-1.5">
                        <Send size={14} /> ترحيل
                      </Button>
                    </>
                  )}
                  {detail.status === "posted" && (
                    <Button size="sm" variant="destructive" onClick={() => voidEntry(detail.id)} className="gap-1.5">
                      <XCircle size={14} /> إلغاء
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );

  function updateLine(i: number, field: string, value: string) {
    const lines = [...form.lines];
    (lines[i] as Record<string, string>)[field] = value;
    setForm({ ...form, lines });
  }
  function addLine() {
    setForm({ ...form, lines: [...form.lines, { accountCode: "", description: "", debit: "", credit: "" }] });
  }
  function removeLine(i: number) {
    setForm({ ...form, lines: form.lines.filter((_, idx) => idx !== i) });
  }
}

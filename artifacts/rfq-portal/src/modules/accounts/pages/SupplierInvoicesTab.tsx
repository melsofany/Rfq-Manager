import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Receipt, Plus, Eye, Send, XCircle, CheckCircle } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

interface SupplierInvoice {
  id: number;
  invoiceNo: string;
  supplierInvoiceNo: string | null;
  supplierId: number | null;
  supplierName: string;
  poId: number | null;
  poNo: string | null;
  invoiceDate: string;
  dueDate: string | null;
  netAmount: string | null;
  vatAmount: string | null;
  withholdingRate: string | null;
  withholdingAmount: string | null;
  grossAmount: string | null;
  paidAmount: string | null;
  balance: string | null;
  status: string;
  postedAt: string | null;
}

interface SupplierInvoiceDetail extends SupplierInvoice {
  notes: string | null;
  journalEntryId: number | null;
  payments: Array<{ paymentNo: string; paymentDate: string; amount: string | null; method: string | null; reference: string | null }>;
}

interface Supplier { id: number; name: string; }
interface PoOption { id: number; internalPoNo: string; }

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  draft: { label: "مسودة", cls: "bg-amber-100 text-amber-700" },
  posted: { label: "مُرحّلة", cls: "bg-blue-100 text-blue-700" },
  paid: { label: "مدفوعة", cls: "bg-emerald-100 text-emerald-700" },
  void: { label: "ملغاة", cls: "bg-muted text-muted-foreground" },
};

export default function SupplierInvoicesTab() {
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ from: "", to: "", status: "" });
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<SupplierInvoiceDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [form, setForm] = useState({
    supplierId: "",
    supplierName: "",
    poId: "",
    invoiceDate: new Date().toISOString().slice(0, 10),
    dueDate: "",
    netAmount: "",
    applyWithholding: true,
    supplierInvoiceNo: "",
    notes: "",
  });
  const [preview, setPreview] = useState({ vat: 0, gross: 0, withholding: 0, balance: 0 });

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.status) params.set("status", filters.status);
    const qs = params.toString();
    try {
      const r = await fetch(`/api/accounts/supplier-invoices${qs ? `?${qs}` : ""}`, { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل الفواتير");
      setInvoices(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل الفواتير"));
    } finally {
      setLoading(false);
    }
  }

  async function loadSuppliers() {
    try {
      const r = await fetch("/api/suppliers", { credentials: "include" });
      if (r.ok) {
        const j = await r.json();
        setSuppliers(Array.isArray(j) ? j : j.items ?? j.suppliers ?? []);
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    load();
    loadSuppliers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const net = Number(form.netAmount) || 0;
    const vat = net * 0.14;
    const gross = net + vat;
    const withholding = form.applyWithholding ? (net * 3) / 100 : 0;
    setPreview({ vat, gross, withholding, balance: gross - withholding });
  }, [form.netAmount, form.applyWithholding]);

  async function openDetail(id: number) {
    try {
      const r = await fetch(`/api/accounts/supplier-invoices/${id}`, { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل التفاصيل");
      setDetail(await r.json());
      setDetailOpen(true);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل التفاصيل"));
    }
  }

  async function create() {
    try {
      const r = await fetch("/api/accounts/supplier-invoices", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId: form.supplierId ? Number(form.supplierId) : null,
          supplierName: form.supplierName,
          poId: form.poId ? Number(form.poId) : null,
          invoiceDate: form.invoiceDate,
          dueDate: form.dueDate || null,
          netAmount: Number(form.netAmount),
          applyWithholding: form.applyWithholding,
          supplierInvoiceNo: form.supplierInvoiceNo || null,
          notes: form.notes || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "فشل الإنشاء");
      }
      toast.success("تم إنشاء فاتورة المورد (مسودة)");
      setCreateOpen(false);
      setForm({ supplierId: "", supplierName: "", poId: "", invoiceDate: new Date().toISOString().slice(0, 10), dueDate: "", netAmount: "", applyWithholding: true, supplierInvoiceNo: "", notes: "" });
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الإنشاء"));
    }
  }

  async function post(id: number) {
    try {
      const r = await fetch(`/api/accounts/supplier-invoices/${id}/post`, { method: "POST", credentials: "include" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "فشل الترحيل");
      }
      toast.success("تم ترحيل الفاتورة");
      load();
      openDetail(id);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الترحيل"));
    }
  }

  async function voidInv(id: number) {
    if (!confirm("هل أنت متأكد من إلغاء هذه الفاتورة؟")) return;
    try {
      const r = await fetch(`/api/accounts/supplier-invoices/${id}/void`, { method: "POST", credentials: "include" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "فشل الإلغاء");
      }
      toast.success("تم إلغاء الفاتورة");
      setDetailOpen(false);
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الإلغاء"));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          فواتير الموردين (ذمم دائنة) — صافي التوريد + ض.ق.م. مدخلات 14% − خصم تحت حساب المورد 3%.
          ترحيل الفاتورة يُنشئ القيد تلقائيًا.
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
          <Plus size={14} /> فاتورة مورد
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div><Label className="text-xs mb-1 block">من تاريخ</Label><Input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} className="h-8 text-sm w-40" /></div>
        <div><Label className="text-xs mb-1 block">إلى تاريخ</Label><Input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} className="h-8 text-sm w-40" /></div>
        <div><Label className="text-xs mb-1 block">الحالة</Label>
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-sm">
            <option value="">الكل</option>
            <option value="draft">مسودة</option>
            <option value="posted">مُرحّلة</option>
            <option value="paid">مدفوعة</option>
            <option value="void">ملغاة</option>
          </select>
        </div>
        <Button onClick={load} size="sm" className="gap-1.5">تحديث</Button>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
        ) : invoices.length === 0 ? (
          <div className="p-12 text-center"><Receipt size={40} className="mx-auto text-muted-foreground/30 mb-3" /><p className="text-muted-foreground text-sm">لا توجد فواتير</p></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">رقم الفاتورة</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">المورد</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">التاريخ</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الصافي</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">ض.ق.م.</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الخصم</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الرصيد</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الحالة</th>
                  <th className="px-3 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-3 py-2.5 font-mono text-xs text-primary">{inv.invoiceNo}</td>
                    <td className="px-3 py-2.5 text-xs">{inv.supplierName}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{inv.invoiceDate}</td>
                    <td className="px-3 py-2.5 text-xs">{inv.netAmount ?? "-"}</td>
                    <td className="px-3 py-2.5 text-xs">{inv.vatAmount ?? "-"}</td>
                    <td className="px-3 py-2.5 text-xs text-amber-600">{inv.withholdingAmount ?? "-"}</td>
                    <td className="px-3 py-2.5 text-xs font-medium">{inv.balance ?? "-"}</td>
                    <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_LABELS[inv.status]?.cls}`}>{STATUS_LABELS[inv.status]?.label}</span></td>
                    <td className="px-3 py-2.5 text-left">
                      <Button size="sm" variant="ghost" onClick={() => openDetail(inv.id)} className="h-7 px-2"><Eye size={13} /></Button>
                      {inv.status === "draft" && <Button size="sm" variant="ghost" onClick={() => post(inv.id)} className="h-7 px-2" title="ترحيل"><Send size={13} className="text-emerald-600" /></Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>فاتورة مورد جديدة</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">المورد</Label>
              <Input list="suppliers-list" value={form.supplierName} onChange={(e) => setForm({ ...form, supplierName: e.target.value })} className="h-8 text-sm" placeholder="اسم المورد" />
              <datalist id="suppliers-list">
                {suppliers.map((s) => <option key={s.id} value={s.name} />)}
              </datalist>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">رقم فاتورة المورد</Label><Input value={form.supplierInvoiceNo} onChange={(e) => setForm({ ...form, supplierInvoiceNo: e.target.value })} className="h-8 text-sm" /></div>
              <div><Label className="text-xs">تاريخ الفاتورة</Label><Input type="date" value={form.invoiceDate} onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })} className="h-8 text-sm" /></div>
            </div>
            <div><Label className="text-xs">صافي قيمة التوريد (قبل الضريبة)</Label><Input type="number" value={form.netAmount} onChange={(e) => setForm({ ...form, netAmount: e.target.value })} className="h-8 text-sm" /></div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={form.applyWithholding} onChange={(e) => setForm({ ...form, applyWithholding: e.target.checked })} className="accent-primary" /> تطبيق الخصم تحت حساب المورد (3%)</label>
            <div className="bg-muted/30 rounded-lg p-3 space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">ض.ق.م. المدخلات (14%)</span><span className="font-medium">{preview.vat.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">الإجمالي شامل الضريبة</span><span className="font-medium">{preview.gross.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">الخصم تحت حساب المورد (3%)</span><span className="font-medium text-amber-600">{preview.withholding.toFixed(2)}</span></div>
              <div className="flex justify-between border-t border-border pt-1"><span className="font-medium">المستحق للمورد</span><span className="font-bold text-emerald-600">{preview.balance.toFixed(2)}</span></div>
            </div>
            <div><Label className="text-xs">ملاحظات</Label><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="text-sm" rows={2} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>إلغاء</Button><Button onClick={create}>حفظ كمسودة</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>فاتورة {detail?.invoiceNo}</DialogTitle></DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-muted-foreground">المورد: </span>{detail.supplierName}</div>
                <div><span className="text-muted-foreground">التاريخ: </span>{detail.invoiceDate}</div>
                <div><span className="text-muted-foreground">صافي: </span>{detail.netAmount}</div>
                <div><span className="text-muted-foreground">ض.ق.م.: </span>{detail.vatAmount}</div>
                <div><span className="text-muted-foreground">خصم: </span>{detail.withholdingAmount}</div>
                <div><span className="text-muted-foreground">الرصيد: </span>{detail.balance}</div>
              </div>
              {detail.payments.length > 0 && (
                <div className="border border-border rounded p-2">
                  <div className="text-xs font-semibold mb-1">المدفوعات</div>
                  {detail.payments.map((p, i) => (
                    <div key={i} className="text-xs flex justify-between"><span className="font-mono text-primary">{p.paymentNo}</span><span>{p.paymentDate}</span><span className="font-medium">{p.amount}</span></div>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_LABELS[detail.status]?.cls}`}>{STATUS_LABELS[detail.status]?.label}</span>
                <div className="flex gap-2">
                  {detail.status === "draft" && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => {}} className="gap-1.5"><CheckCircle size={14} className="text-amber-600" /> اعتماد</Button>
                      <Button size="sm" onClick={() => post(detail.id)} className="gap-1.5"><Send size={14} /> ترحيل</Button>
                    </>
                  )}
                  {(detail.status === "posted" || detail.status === "draft") && (
                    <Button size="sm" variant="destructive" onClick={() => voidInv(detail.id)} className="gap-1.5"><XCircle size={14} /> إلغاء</Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

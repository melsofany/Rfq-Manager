import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { FileText, Plus, Eye, Send, XCircle, Download, Trash2, Search } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

interface SalesInvoice {
  id: number;
  invoiceNo: string;
  customerPoId: number | null;
  customerPoNo: string | null;
  customerId: number | null;
  customerName: string;
  invoiceDate: string;
  dueDate: string | null;
  netAmount: string | null;
  vatAmount: string | null;
  grossAmount: string | null;
  cogsAmount: string | null;
  collectedAmount: string | null;
  balance: string | null;
  status: string;
  postedAt: string | null;
}

interface SalesInvoiceDetail extends SalesInvoice {
  notes: string | null;
  journalEntryId: number | null;
  items: Array<{ id: number; customerPoItemId: number | null; lineItem: string | null; partNo: string | null; description: string; uom: string | null; qty: string | null; unitPrice: string | null; total: string | null }>;
}

interface CustomerPoOption { id: number; internalPoNo: string; customerPoNo: string | null; customerName: string | null; status: string; }

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  draft: { label: "مسودة", cls: "bg-amber-100 text-amber-700" },
  posted: { label: "مُرحّلة", cls: "bg-blue-100 text-blue-700" },
  paid: { label: "مدفوعة", cls: "bg-emerald-100 text-emerald-700" },
  void: { label: "ملغاة", cls: "bg-muted text-muted-foreground" },
};

export default function SalesInvoicesTab() {
  const [invoices, setInvoices] = useState<SalesInvoice[]>([]);
  const [customerPos, setCustomerPos] = useState<CustomerPoOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ from: "", to: "", status: "" });
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<SalesInvoiceDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [form, setForm] = useState({
    customerPoId: "",
    customerName: "",
    invoiceDate: new Date().toISOString().slice(0, 10),
    dueDate: "",
    notes: "",
    items: [{ description: "", qty: "", unitPrice: "" }],
  });

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.status) params.set("status", filters.status);
    const qs = params.toString();
    try {
      const r = await fetch(`/api/accounts/sales-invoices${qs ? `?${qs}` : ""}`, { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل الفواتير");
      setInvoices(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل الفواتير"));
    } finally {
      setLoading(false);
    }
  }

  async function loadCustomerPos() {
    try {
      const r = await fetch("/api/customer-po?limit=100", { credentials: "include" });
      if (r.ok) {
        const j = await r.json();
        setCustomerPos(Array.isArray(j) ? j : j.items ?? []);
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    load();
    loadCustomerPos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onPoSelect(id: string) {
    setForm({ ...form, customerPoId: id });
    if (id) {
      const po = customerPos.find((p) => p.id === Number(id));
      if (po?.customerName) setForm((f) => ({ ...f, customerPoId: id, customerName: po.customerName! }));
    }
  }

  async function openDetail(id: number) {
    try {
      const r = await fetch(`/api/accounts/sales-invoices/${id}`, { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل التفاصيل");
      setDetail(await r.json());
      setDetailOpen(true);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل التفاصيل"));
    }
  }

  async function create() {
    try {
      const r = await fetch("/api/accounts/sales-invoices", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerPoId: form.customerPoId ? Number(form.customerPoId) : null,
          customerName: form.customerName || undefined,
          invoiceDate: form.invoiceDate,
          dueDate: form.dueDate || null,
          notes: form.notes || null,
          items: form.items.filter((it) => it.description).map((it) => ({ ...it, qty: Number(it.qty) || 0, unitPrice: Number(it.unitPrice) || 0 })),
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "فشل الإنشاء");
      }
      toast.success("تم إنشاء فاتورة البيع (مسودة)");
      setCreateOpen(false);
      setForm({ customerPoId: "", customerName: "", invoiceDate: new Date().toISOString().slice(0, 10), dueDate: "", notes: "", items: [{ description: "", qty: "", unitPrice: "" }] });
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الإنشاء"));
    }
  }

  async function post(id: number) {
    try {
      const r = await fetch(`/api/accounts/sales-invoices/${id}/post`, { method: "POST", credentials: "include" });
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
      const r = await fetch(`/api/accounts/sales-invoices/${id}/void`, { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error("فشل الإلغاء");
      toast.success("تم إلغاء الفاتورة");
      setDetailOpen(false);
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الإلغاء"));
    }
  }

  function downloadPdf(id: number, no: string) {
    window.open(`/api/accounts/sales-invoices/${id}/pdf`, "_blank");
  }

  const netTotal = form.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0);
  const vatTotal = netTotal * 0.14;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          فواتير البيع (ذمم مدينة) — إصدار فاتورة ضريبية للعميل + ض.ق.م. مخرجات 14%. الترحيل يُنشئ القيد
          ويُعترف بتكلفة البضاعة المباعة تلقائيًا.
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
          <Plus size={14} /> فاتورة بيع
        </Button>
      </div>

      <div className="relative">
        <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="بحث في الفواتير (رقم الفاتورة، العميل، رقم أمر شراء العميل، التاريخ، الحالة...)"
          className="h-9 text-sm pr-9"
        />
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
          <div className="p-12 text-center"><FileText size={40} className="mx-auto text-muted-foreground/30 mb-3" /><p className="text-muted-foreground text-sm">لا توجد فواتير</p></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">رقم الفاتورة</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">العميل</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">رقم أمر شراء العميل</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">التاريخ</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الصافي</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">ض.ق.م.</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الإجمالي</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الرصيد</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الحالة</th>
                  <th className="px-3 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {invoices
                  .filter((inv) => {
                    if (!search.trim()) return true;
                    const q = search.trim().toLowerCase();
                    return [
                      inv.invoiceNo,
                      inv.customerName,
                      inv.customerPoNo,
                      inv.invoiceDate,
                      inv.netAmount,
                      inv.vatAmount,
                      inv.grossAmount,
                      inv.balance,
                      STATUS_LABELS[inv.status]?.label ?? inv.status,
                    ]
                      .filter(Boolean)
                      .some((v) => String(v).toLowerCase().includes(q));
                  })
                  .map((inv) => (
                  <tr key={inv.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-3 py-2.5 font-mono text-xs text-primary">{inv.invoiceNo}</td>
                    <td className="px-3 py-2.5 text-xs">{inv.customerName}</td>
                    <td className="px-3 py-2.5 font-mono text-xs">{inv.customerPoNo ?? "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{inv.invoiceDate}</td>
                    <td className="px-3 py-2.5 text-xs">{inv.netAmount ?? "-"}</td>
                    <td className="px-3 py-2.5 text-xs">{inv.vatAmount ?? "-"}</td>
                    <td className="px-3 py-2.5 text-xs font-medium">{inv.grossAmount ?? "-"}</td>
                    <td className="px-3 py-2.5 text-xs font-medium">{inv.balance ?? "-"}</td>
                    <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_LABELS[inv.status]?.cls}`}>{STATUS_LABELS[inv.status]?.label}</span></td>
                    <td className="px-3 py-2.5 text-left whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => openDetail(inv.id)} className="h-7 px-2"><Eye size={13} /></Button>
                      <Button size="sm" variant="ghost" onClick={() => downloadPdf(inv.id, inv.invoiceNo)} className="h-7 px-2" title="فاتورة PDF"><Download size={13} className="text-primary" /></Button>
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
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>فاتورة بيع جديدة</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">أمر شراء العميل (تعبئة تلقائية)</Label>
                <select value={form.customerPoId} onChange={(e) => onPoSelect(e.target.value)} className="w-full h-8 rounded-md border border-input bg-background px-2 text-sm">
                  <option value="">— بدون —</option>
                  {customerPos.map((po) => (
                    <option key={po.id} value={po.id}>{po.internalPoNo}{po.customerPoNo ? ` (${po.customerPoNo})` : ""}</option>
                  ))}
                </select>
              </div>
              <div><Label className="text-xs">اسم العميل</Label><Input value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} className="h-8 text-sm" /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">تاريخ الفاتورة</Label><Input type="date" value={form.invoiceDate} onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })} className="h-8 text-sm" /></div>
              <div><Label className="text-xs">تاريخ الاستحقاق</Label><Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className="h-8 text-sm" /></div>
            </div>
            {!form.customerPoId && (
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 text-left">
                    <tr><th className="px-2 py-2 text-xs text-muted-foreground">الوصف</th><th className="px-2 py-2 text-xs text-muted-foreground w-24">الكمية</th><th className="px-2 py-2 text-xs text-muted-foreground w-28">السعر</th><th className="w-8"></th></tr>
                  </thead>
                  <tbody>
                    {form.items.map((it, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-2 py-1"><Input value={it.description} onChange={(e) => updateItem(i, "description", e.target.value)} className="h-7 text-xs" /></td>
                        <td className="px-2 py-1"><Input type="number" value={it.qty} onChange={(e) => updateItem(i, "qty", e.target.value)} className="h-7 text-xs" /></td>
                        <td className="px-2 py-1"><Input type="number" value={it.unitPrice} onChange={(e) => updateItem(i, "unitPrice", e.target.value)} className="h-7 text-xs" /></td>
                        <td className="px-1">{form.items.length > 1 && <Button size="sm" variant="ghost" onClick={() => removeItem(i)} className="h-7 px-1"><Trash2 size={12} className="text-red-500" /></Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="p-2 border-t border-border"><Button size="sm" variant="outline" onClick={() => setForm({ ...form, items: [...form.items, { description: "", qty: "", unitPrice: "" }] })} className="h-7 gap-1"><Plus size={12} /> إضافة بند</Button></div>
              </div>
            )}
            {form.customerPoId && <p className="text-xs text-muted-foreground">ستُعبّأ بنود الفاتورة تلقائيًا من أمر شراء العميل عند الحفظ.</p>}
            <div className="bg-muted/30 rounded-lg p-3 text-xs flex justify-between">
              <span className="text-muted-foreground">الصافي + ض.ق.م. (14%)</span>
              <span className="font-bold">{(netTotal + vatTotal).toFixed(2)} ({netTotal.toFixed(2)} + {vatTotal.toFixed(2)})</span>
            </div>
            <div><Label className="text-xs">ملاحظات</Label><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="text-sm" rows={2} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>إلغاء</Button><Button onClick={create}>حفظ كمسودة</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>فاتورة {detail?.invoiceNo}</DialogTitle></DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-muted-foreground">العميل: </span>{detail.customerName}</div>
                <div><span className="text-muted-foreground">التاريخ: </span>{detail.invoiceDate}</div>
                <div><span className="text-muted-foreground">الصافي: </span>{detail.netAmount}</div>
                <div><span className="text-muted-foreground">ض.ق.م.: </span>{detail.vatAmount}</div>
                <div><span className="text-muted-foreground">الإجمالي: </span>{detail.grossAmount}</div>
                <div><span className="text-muted-foreground">تكلفة البضاعة المباعة: </span>{detail.cogsAmount}</div>
              </div>
              {detail.items.length > 0 && (
                <div className="border border-border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/30 text-left"><tr><th className="px-2 py-2 text-xs text-muted-foreground">الوصف</th><th className="px-2 py-2 text-xs text-muted-foreground">الكمية</th><th className="px-2 py-2 text-xs text-muted-foreground">السعر</th><th className="px-2 py-2 text-xs text-muted-foreground">الإجمالي</th></tr></thead>
                    <tbody>
                      {detail.items.map((it) => (
                        <tr key={it.id} className="border-t border-border"><td className="px-2 py-1.5 text-xs">{it.description}</td><td className="px-2 py-1.5 text-xs">{it.qty}</td><td className="px-2 py-1.5 text-xs">{it.unitPrice}</td><td className="px-2 py-1.5 text-xs">{it.total}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_LABELS[detail.status]?.cls}`}>{STATUS_LABELS[detail.status]?.label}</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => downloadPdf(detail.id, detail.invoiceNo)} className="gap-1.5"><Download size={14} /> فاتورة PDF</Button>
                  {detail.status === "draft" && <Button size="sm" onClick={() => post(detail.id)} className="gap-1.5"><Send size={14} /> ترحيل</Button>}
                  {(detail.status === "posted" || detail.status === "draft") && <Button size="sm" variant="destructive" onClick={() => voidInv(detail.id)} className="gap-1.5"><XCircle size={14} /> إلغاء</Button>}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );

  function updateItem(i: number, field: string, value: string) {
    const items = [...form.items];
    (items[i] as Record<string, string>)[field] = value;
    setForm({ ...form, items });
  }
  function removeItem(i: number) {
    setForm({ ...form, items: form.items.filter((_, idx) => idx !== i) });
  }
}

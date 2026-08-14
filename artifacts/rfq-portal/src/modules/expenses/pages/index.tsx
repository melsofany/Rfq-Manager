import { useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Receipt, Plus, Paperclip, Trash2, Download, X } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

const CATEGORIES = [
  "إيجارات",
  "دومينات واستضافة وخدمات تقنية",
  "كهرباء ومياه",
  "اتصالات",
  "نثريات",
  "صيانة",
  "مصروفات إدارية",
  "رواتب",
  "أخرى",
];

interface ExpenseRow {
  id: number;
  category: string;
  description: string | null;
  expenseDate: string;
  amount: string | null;
  notes: string | null;
  employeeName: string | null;
  createdAt: string;
}

interface Attachment {
  id: number;
  originalName: string;
  mimeType: string;
  size: number;
  sizeLabel: string;
  downloadUrl: string;
  createdAt: string;
}

function fmt(n: string | null): string {
  if (n == null) return "-";
  return Number(n).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function ExpensesPage() {
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [grandTotal, setGrandTotal] = useState<number | null>(null);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({
    category: CATEGORIES[0],
    description: "",
    expenseDate: new Date().toISOString().slice(0, 10),
    amount: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);

  // detail dialog
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<(ExpenseRow & { attachments: Attachment[] }) | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    try {
      const r = await fetch(`/api/expenses?${params.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error("fetch failed");
      setRows(await r.json());
      const s = await fetch(`/api/expenses/summary?${params.toString()}`, {
        credentials: "include",
      });
      if (s.ok) {
        const sj = await s.json();
        setGrandTotal(sj.grandTotal ? Number(sj.grandTotal) : null);
      }
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل المصروفات"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openCreate() {
    setEditingId(null);
    setForm({
      category: CATEGORIES[0],
      description: "",
      expenseDate: new Date().toISOString().slice(0, 10),
      amount: "",
      notes: "",
    });
    setOpen(true);
  }

  function openEdit(row: ExpenseRow) {
    setEditingId(row.id);
    setForm({
      category: row.category,
      description: row.description ?? "",
      expenseDate: row.expenseDate,
      amount: row.amount ?? "",
      notes: row.notes ?? "",
    });
    setOpen(true);
  }

  async function save() {
    if (!form.amount || Number(form.amount) <= 0) {
      toast.error("أدخل قيمة صحيحة للمصروف");
      return;
    }
    setSaving(true);
    try {
      const url = editingId ? `/api/expenses/${editingId}` : "/api/expenses";
      const method = editingId ? "PATCH" : "POST";
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error ?? "فشل الحفظ");
      }
      toast.success(editingId ? "تم تحديث المصروف" : "تم إضافة المصروف");
      setOpen(false);
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الحفظ"));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("هل أنت متأكد من حذف هذا المصروف؟")) return;
    try {
      const r = await fetch(`/api/expenses/${id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error ?? "فشل الحذف");
      }
      toast.success("تم حذف المصروف");
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الحذف (يتطلب صلاحية مدير)"));
    }
  }

  async function openDetail(id: number) {
    setDetailId(id);
    setDetailOpen(true);
    setDetailLoading(true);
    try {
      const r = await fetch(`/api/expenses/${id}`, { credentials: "include" });
      if (!r.ok) throw new Error("fetch failed");
      setDetail(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل التفاصيل"));
    } finally {
      setDetailLoading(false);
    }
  }

  async function uploadAttachment(file: File) {
    if (!detailId) return;
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch(`/api/expenses/${detailId}/attachments`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error ?? "فشل رفع الملف");
      }
      toast.success("تم رفع المرفق");
      openDetail(detailId);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل رفع الملف"));
    } finally {
      setUploading(false);
    }
  }

  async function removeAttachment(attId: number) {
    try {
      const r = await fetch(`/api/expenses/attachments/${attId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error("فشل الحذف");
      toast.success("تم حذف المرفق");
      if (detailId) openDetail(detailId);
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل حذف المرفق"));
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <Button onClick={openCreate} size="sm" className="gap-1.5 self-start sm:self-auto">
          <Plus size={15} />
          إضافة مصروف
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground mb-1">النوع</Label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-8 w-full text-sm rounded-md border border-border bg-card px-2"
            >
              <option value="">الكل</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">من تاريخ</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-sm" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">إلى تاريخ</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-sm" />
          </div>
          <div className="flex items-end">
            <Button onClick={load} size="sm" className="gap-1.5 w-full">
              تحديث
            </Button>
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg p-3 flex items-center justify-between">
          <span className="text-sm text-muted-foreground">إجمالي المصروفات للفترة</span>
          <span className="text-lg font-bold text-foreground">
            {grandTotal != null ? fmt(String(grandTotal)) : "-"}
          </span>
        </div>

        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
          ) : rows.length === 0 ? (
            <div className="p-12 text-center">
              <Receipt size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground text-sm">لا توجد مصروفات مسجّلة</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-left">
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">التاريخ</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">النوع</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الوصف</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">القيمة</th>
                    <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الموظف</th>
                    <th className="px-3 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                      <td className="px-3 py-3 text-xs text-muted-foreground">{r.expenseDate}</td>
                      <td className="px-3 py-3 text-xs font-medium">{r.category}</td>
                      <td className="px-3 py-3 text-xs">{r.description ?? "-"}</td>
                      <td className="px-3 py-3 text-xs font-semibold">{fmt(r.amount)}</td>
                      <td className="px-3 py-3 text-xs text-muted-foreground">{r.employeeName ?? "-"}</td>
                      <td className="px-3 py-3 text-left">
                        <div className="flex gap-1 justify-end">
                          <Button variant="ghost" size="sm" onClick={() => openDetail(r.id)} className="h-7 px-2 text-xs">
                            تفاصيل
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => openEdit(r)} className="h-7 px-2 text-xs">
                            تعديل
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => remove(r.id)}
                            className="h-7 px-2 text-xs text-red-600 hover:text-red-700"
                          >
                            <Trash2 size={13} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      {/* Create/Edit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? "تعديل مصروف" : "إضافة مصروف تشغيلي"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1">النوع</Label>
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="h-9 w-full text-sm rounded-md border border-border bg-card px-2"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground mb-1">التاريخ</Label>
                <Input
                  type="date"
                  value={form.expenseDate}
                  onChange={(e) => setForm({ ...form, expenseDate: e.target.value })}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1">القيمة</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  className="h-9 text-sm"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1">الوصف</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="h-9 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1">ملاحظات</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="text-sm"
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} size="sm">
              إلغاء
            </Button>
            <Button onClick={save} disabled={saving} size="sm">
              {saving ? "جارٍ الحفظ..." : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail dialog with attachments */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>تفاصيل المصروف</DialogTitle>
          </DialogHeader>
          {detailLoading || !detail ? (
            <div className="p-6 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-xs text-muted-foreground">النوع</span>
                  <p className="font-medium">{detail.category}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">القيمة</span>
                  <p className="font-medium">{fmt(detail.amount)}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">التاريخ</span>
                  <p className="font-medium">{detail.expenseDate}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">الموظف</span>
                  <p className="font-medium">{detail.employeeName ?? "-"}</p>
                </div>
              </div>
              {detail.description && (
                <div>
                  <span className="text-xs text-muted-foreground">الوصف</span>
                  <p className="text-sm">{detail.description}</p>
                </div>
              )}
              {detail.notes && (
                <div>
                  <span className="text-xs text-muted-foreground">ملاحظات</span>
                  <p className="text-sm">{detail.notes}</p>
                </div>
              )}

              <div className="border-t border-border pt-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium flex items-center gap-1.5">
                    <Paperclip size={14} />
                    المرفقات
                  </span>
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadAttachment(f);
                      e.target.value = "";
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    className="h-7 text-xs gap-1"
                  >
                    <Plus size={13} />
                    {uploading ? "جارٍ الرفع..." : "إرفاق ملف"}
                  </Button>
                </div>
                {detail.attachments.length === 0 ? (
                  <p className="text-xs text-muted-foreground">لا توجد مرفقات</p>
                ) : (
                  <div className="space-y-1.5">
                    {detail.attachments.map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center justify-between bg-muted/30 rounded-md px-2 py-1.5"
                      >
                        <a
                          href={`/api${a.downloadUrl}`}
                          className="text-xs text-primary hover:underline flex items-center gap-1.5 flex-1 min-w-0"
                        >
                          <Download size={13} className="shrink-0" />
                          <span className="truncate">{a.originalName}</span>
                          <span className="text-muted-foreground">({a.sizeLabel})</span>
                        </a>
                        <button
                          onClick={() => removeAttachment(a.id)}
                          className="text-red-600 hover:text-red-700 p-1"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailOpen(false)} size="sm">
              إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

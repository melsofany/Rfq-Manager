import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, BookOpen, Pencil } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

interface Account {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  type: string;
  isControl: boolean;
  isActive: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  asset: "أصول",
  liability: "خصوم",
  equity: "حقوق ملكية",
  revenue: "إيرادات",
  expense: "مصروفات",
};

const TYPE_COLORS: Record<string, string> = {
  asset: "text-blue-600",
  liability: "text-amber-600",
  equity: "text-purple-600",
  revenue: "text-emerald-600",
  expense: "text-red-600",
};

export default function ChartOfAccountsTab() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [form, setForm] = useState({ code: "", nameAr: "", nameEn: "", type: "expense", isControl: false });

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/accounts/coa", { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل دليل الحسابات");
      setAccounts(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل دليل الحسابات"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openCreate() {
    setEditing(null);
    setForm({ code: "", nameAr: "", nameEn: "", type: "expense", isControl: false });
    setDialogOpen(true);
  }

  function openEdit(a: Account) {
    setEditing(a);
    setForm({ code: a.code, nameAr: a.nameAr, nameEn: a.nameEn ?? "", type: a.type, isControl: a.isControl });
    setDialogOpen(true);
  }

  async function save() {
    try {
      if (editing) {
        const r = await fetch(`/api/accounts/coa/${editing.id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        if (!r.ok) throw new Error("فشل التحديث");
        toast.success("تم تحديث الحساب");
      } else {
        const r = await fetch("/api/accounts/coa", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        if (!r.ok) throw new Error("فشل الإنشاء");
        toast.success("تم إنشاء الحساب");
      }
      setDialogOpen(false);
      load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل الحفظ"));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          دليل الحسابات الهرمي وفق الترقيم المصري — الأصول (1xxx)، الخصوم (2xxx)، حقوق الملكية (3xxx)،
          الإيرادات (4xxx)، المصروفات (5xxx).
        </p>
        <Button size="sm" onClick={openCreate} className="gap-1.5">
          <Plus size={14} /> حساب جديد
        </Button>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الكود</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">اسم الحساب</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">النوع</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">حساب تحكّم</th>
                  <th className="px-3 py-3 text-muted-foreground text-xs font-medium">الحالة</th>
                  <th className="px-3 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-3 py-2.5 font-mono text-xs text-primary">{a.code}</td>
                    <td className="px-3 py-2.5 text-xs">
                      <span className="text-foreground">{a.nameAr}</span>
                      {a.nameEn && <span className="text-muted-foreground block text-xs">{a.nameEn}</span>}
                    </td>
                    <td className={`px-3 py-2.5 text-xs font-medium ${TYPE_COLORS[a.type] ?? ""}`}>
                      {TYPE_LABELS[a.type] ?? a.type}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {a.isControl ? "نعم" : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      <span className={`px-2 py-0.5 rounded-full text-xs ${a.isActive ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>
                        {a.isActive ? "نشط" : "موقوف"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-left">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(a)} className="h-7 px-2">
                        <Pencil size={13} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && accounts.length === 0 && (
          <div className="p-12 text-center">
            <BookOpen size={40} className="mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-muted-foreground text-sm">لا توجد حسابات</p>
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "تعديل حساب" : "إنشاء حساب جديد"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">كود الحساب</Label>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} disabled={!!editing} className="h-8 text-sm font-mono" placeholder="1100" />
            </div>
            <div>
              <Label className="text-xs">الاسم بالعربية</Label>
              <Input value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} className="h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs">الاسم بالإنجليزية (اختياري)</Label>
              <Input value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} className="h-8 text-sm" dir="ltr" />
            </div>
            <div>
              <Label className="text-xs">النوع</Label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full h-8 rounded-md border border-input bg-background px-2 text-sm">
                <option value="asset">أصول</option>
                <option value="liability">خصوم</option>
                <option value="equity">حقوق ملكية</option>
                <option value="revenue">إيرادات</option>
                <option value="expense">مصروفات</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={form.isControl} onChange={(e) => setForm({ ...form, isControl: e.target.checked })} className="accent-primary" />
              حساب تحكّم (Control Account)
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>إلغاء</Button>
            <Button onClick={save}>حفظ</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

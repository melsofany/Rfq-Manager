import { useCallback, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Lock, Unlock, CalendarCheck, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

interface ClosingRow {
  id: number;
  period: string;
  closedAt: string | null;
  closedBy: number | null;
  closedByName: string | null;
  notes: string | null;
}

const MONTHS_AR = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

export default function ClosingTab() {
  const [rows, setRows] = useState<ClosingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/accounts/closings", { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل الإقفالات");
      setRows(await r.json());
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل الإقفالات"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const now = new Date();
  const defaultPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  async function lockMonth() {
    const p = period || defaultPeriod;
    if (!/^\d{4}-\d{2}$/.test(p)) {
      toast.error("الفترة يجب أن تكون بصيغة YYYY-MM");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/accounts/closings", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: p, notes: notes || null }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? "تعذر إقفال الشهر");
      toast.success(`تم إقفال شهر ${p}`);
      setNotes("");
      await load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "تعذر إقفال الشهر"));
    } finally {
      setBusy(false);
    }
  }

  async function unlockMonth(id: number, period: string) {
    if (!window.confirm(`فتح شهر ${period}؟ سيسمح بإدخال قيود جديدة فيه.`)) return;
    try {
      const r = await fetch(`/api/accounts/closings/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? "تعذر فتح الشهر");
      toast.success(`تم فتح شهر ${period}`);
      await load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "تعذر فتح الشهر"));
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm flex items-center gap2">
        <CalendarCheck size={16} className="text-primary" />
        بعد إقفال شهر، يُجمَّد دفتر الأستاذ — لا يمكن إنشاء أو ترحيل أو إلغاء أي قيد بتاريخ ضمن ذلك الشهر،
        فتبقى القوائم المالية ثابتة وقابلة للمراجعة. لا يُقفل شهر يحتوي قيودًا غير مُرحَّلة.
      </p>

      <div className="bg-card border border-border rounded-lg p-3 space-y-3">
        <div className="flex flex-col sm:flex-row gap3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">الشهر (YYYY-MM)</label>
            <Input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              placeholder={defaultPeriod}
              className="h-8 text-sm w-44"
            />
          </div>
          <div className="flex-1">
            <label className="text-xs text-muted-foreground mb-1 block">ملاحظات</label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="إقفال شهر … (اختياري)"
              className="h-8 text-sm"
            />
          </div>
          <div className="flex items-end">
            <Button onClick={lockMonth} disabled={busy} size="sm" className="gap1.5">
              <Lock size={14} /> إقفال الشهر
            </Button>
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center justify-between">
          <span className="text-sm font-semibold">الإقفالات الشهرية</span>
          {loading && <span className="text-xs text-muted-foreground">جارٍ التحميل...</span>}
        </div>
        {!loading && rows.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            لا توجد إقفالات بعد — كل الشهور مفتوحة.

          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">الشهر</th>
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">تاريخ الإقفال</th>
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">الموظف</th>
                <th className="px-3 py-2 text-muted-foreground text-xs font-medium">ملاحظات</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{formatMonth(r.period)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {r.closedAt ? new Date(r.closedAt).toLocaleDateString("ar-EG") : "-"}
                  </td>
                  <td className="px-3 py-2 text-xs">{r.closedByName ?? `#${r.closedBy ?? "-"}`}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.notes ?? "-"}</td>
                  <td className="px-3 py-2 text-left">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap1"
                      onClick={() => unlockMonth(r.id, r.period)}
                    >
                      <Unlock size={13} /> فتح
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-900 rounded-lg p-3 flex items-start gap2">
        <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-800 dark:text-amber-200">
          أُنشئت عجز ض.ق.م (مشتريات بدون ضريبة) تلقائيًا في تبويب «ضريبة القيمة المضافة» فواتير الموردين
          غير المسجلين تُحمَّل بالكامل على المصروفات، ويُسجَّل عجز التسوية المستحق للمصلحة عند الإقفال.
 من
          الأفضل إقفال الشهر بعد ترحيل كل قيوده واستيفاء فواتير العملاء.

        </p>
      </div>
    </div>
  );
}

function formatMonth(period: string) {
  const [y, m] = period.split("-");
  const idx = Number(m) - 1;
  return `${MONTHS_AR[idx] ?? m} ${y}`;
}
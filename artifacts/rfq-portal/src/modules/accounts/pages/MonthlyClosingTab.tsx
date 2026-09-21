import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Lock, Unlock, CalendarCheck, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/accounts-api";
import { periodLabel } from "@/lib/format";

interface Closing {
  id: number;
  period: string;
  closedAt: string | null;
  closedBy: number | null;
  closedByName: string | null;
  notes: string | null;
}

/**
 * الإقفال الشهري — monthly closing.
 *
 * Locking a month freezes the ledger: no journal entry may be created, posted
 * or voided with an entry_date in that month, so the financial statements stay
 * stable and audits remain consistent. Unlocking is admin-only and audited.
 */
export default function MonthlyClosingTab() {
  const { employee } = useAuth();
  // The Employee role enum in the OpenAPI spec does not list "accountant" yet
  // (the backend does), so widen to string for the permission checks below.
  const role = employee?.role as string | undefined;
  const canClose = role === "admin" || role === "manager" || role === "accountant";
  const canUnlock = role === "admin";

  const [rows, setRows] = useState<Closing[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.get<Closing[]>("/api/accounts/closings"));
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل الإقفالات"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function close() {
    if (!/^\d{4}-\d{2}$/.test(period)) {
      toast.error("اختر الشهر بصيغة صحيحة");
      return;
    }
    setSaving(true);
    try {
      await api.post("/api/accounts/closings", { period, notes: notes || null });
      toast.success(`تم إقفال شهر ${periodLabel(period)}`);
      setNotes("");
      await load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل إقفال الشهر"));
    } finally {
      setSaving(false);
    }
  }

  async function unlock(row: Closing) {
    if (!confirm(`فتح شهر ${periodLabel(row.period)} مرة أخرى؟ سيصبح تسجيل القيود فيه متاحًا.`))
      return;
    try {
      await api.del(`/api/accounts/closings/${row.id}`);
      toast.success(`تم فتح شهر ${periodLabel(row.period)}`);
      await load();
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل فتح الشهر"));
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-3.5 flex items-start gap-2.5">
        <ShieldAlert size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
          إقفال الشهر يمنع تسجيل أو ترحيل أي قيد بتاريخ داخل ذلك الشهر. لا يمكن إقفال شهر ما زال
          يحتوي على قيود غير مُرحَّلة (مسودة) — راجعها ثم أعد المحاولة. هذا يحافظ على ثبات القوائم
          المالية وأرصدة ميزان المراجعة للفترات المقفلة.
        </p>
      </div>

      {canClose && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <CalendarCheck size={15} className="text-primary" /> إقفال شهر
          </h3>
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div>
              <Label className="text-xs mb-1 block">الشهر</Label>
              <Input
                type="month"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="h-8 text-sm w-44"
              />
            </div>
            <div className="flex-1 max-w-sm">
              <Label className="text-xs mb-1 block">ملاحظات (اختياري)</Label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="مثال: تم جرد المخزون وتسوية المستحقات"
                className="h-8 text-sm"
              />
            </div>
            <Button onClick={close} disabled={saving} size="sm" className="gap-1.5">
              <Lock size={14} /> {saving ? "جارٍ الإقفال..." : "إقفال الشهر"}
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">الأشهر المقفلة</h3>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> تحديث
        </Button>
      </div>

      {loading && rows.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground text-sm border border-dashed border-border rounded-lg">
          جارٍ التحميل...
        </div>
      ) : rows.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground text-sm border border-dashed border-border rounded-lg">
          لا توجد أشهر مقفلة بعد — يمكن تسجيل القيود في كل الشهور.
        </div>
      ) : (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="text-right p-2.5 font-medium">الشهر</th>
                <th className="text-right p-2.5 font-medium">تاريخ الإقفال</th>
                <th className="text-right p-2.5 font-medium">بواسطة</th>
                <th className="text-right p-2.5 font-medium">ملاحظات</th>
                <th className="text-right p-2.5 font-medium">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border hover:bg-muted/30">
                  <td className="p-2.5 font-medium">{periodLabel(r.period)}</td>
                  <td className="p-2.5 text-xs text-muted-foreground">
                    {r.closedAt ? new Date(r.closedAt).toLocaleString("en-GB") : "-"}
                  </td>
                  <td className="p-2.5">{r.closedByName ?? "-"}</td>
                  <td className="p-2.5 text-xs text-muted-foreground">{r.notes ?? "-"}</td>
                  <td className="p-2.5">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200 px-2 py-0.5 text-xs">
                        <Lock size={11} /> مقفل
                      </span>
                      {canUnlock && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs gap-1 text-rose-600"
                          onClick={() => unlock(r)}
                        >
                          <Unlock size={12} /> فتح
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!canClose && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Plus size={12} /> إقفال الشهور متاح للمحاسب والمدير والمسؤول فقط.
        </p>
      )}
    </div>
  );
}

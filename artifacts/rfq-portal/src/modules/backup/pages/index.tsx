/**
 * Backup admin page — النسخ الاحتياطي
 *
 * Shows the durable backup history (last success / last attempt / counts), lets
 * an admin test the Service Account connection to the Google Shared Drive, run
 * a backup now, and configure alert recipients + retention/schedule.
 *
 * Endpoints are admin/manager-only on the backend.
 */
import { useCallback, useEffect, useState } from "react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DatabaseBackup,
  Play,
  Plug,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Save,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

interface BackupRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  sizeBytes: number | null;
  fileName: string | null;
  driveFileId: string | null;
  error: string | null;
  attempts: number;
  trigger: string;
}

interface BackupStatus {
  configured: boolean;
  configProblems: string[];
  folderId: string;
  driveId: string;
  serviceAccountEmail: string | null;
  retentionDays: number;
  scheduleHourUtc: number;
  running: boolean;
  lastRun: BackupRun | null;
  lastSuccess: BackupRun | null;
  counts: { success: number; failed: number };
  compensationNeeded: boolean;
  recent: BackupRun[];
}

interface Recipient {
  employeeId: number;
  email?: string | null;
  phone?: string | null;
  whatsapp?: boolean;
}

interface BackupSettings {
  recipients: Recipient[];
  retentionDays: number;
  hourUtc: number;
  alertsEnabled: boolean;
  lastAlertAt: string | null;
}

interface EmployeeOption {
  id: number;
  name: string;
  role: string;
  email: string;
  phone: string | null;
}

async function apiGet<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as T;
}

async function apiSend<T>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${r.status}`), { data });
  return data as T;
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString("en-GB");
  } catch {
    return s;
  }
}

const STATUS_LABEL: Record<string, string> = {
  SUCCESS: "ناجحة",
  FAILED: "فاشلة",
  RUNNING: "قيد التنفيذ",
};

const TRIGGER_LABEL: Record<string, string> = {
  schedule: "مجدولة",
  manual: "يدوية",
  compensation: "تعويضية",
  test: "اختبار",
};

export default function BackupPage() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"" | "test" | "run" | "save">("");
  const [draft, setDraft] = useState<BackupSettings | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [st, se, emp] = await Promise.all([
        apiGet<BackupStatus>("/api/backup/status"),
        apiGet<BackupSettings>("/api/backup/settings"),
        apiGet<EmployeeOption[]>("/api/employees"),
      ]);
      setStatus(st);
      setDraft(se);
      setEmployees(emp.filter((e) => e.role === "admin" || e.role === "manager"));
    } catch (err) {
      toast.error(getApiErrorMessage(err, "فشل تحميل حالة النسخ الاحتياطي"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleTest = async () => {
    setBusy("test");
    try {
      const r = await apiSend<{ ok: boolean; folderName?: string; error?: string }>(
        "/api/backup/test-connection",
        "POST",
      );
      if (r.ok) toast.success(`تم الاتصال بنجاح — الفولدر: ${r.folderName ?? "؟"}`);
      else toast.error(`فشل الاتصال: ${r.error ?? "غير معروف"}`);
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err, "فشل اختبار الاتصال"));
    } finally {
      setBusy("");
    }
  };

  const handleRun = async () => {
    setBusy("run");
    try {
      const r = await apiSend<{ ok: boolean; name: string; sizeBytes: number }>(
        "/api/backup/run",
        "POST",
      );
      toast.success(`تم النسخ الاحتياطي: ${r.name} (${fmtBytes(r.sizeBytes)})`);
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err, "فشل النسخ الاحتياطي"));
    } finally {
      setBusy("");
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    setBusy("save");
    try {
      const saved = await apiSend<BackupSettings>("/api/backup/settings", "PUT", {
        recipients: draft.recipients,
        retentionDays: draft.retentionDays,
        hourUtc: draft.hourUtc,
        alertsEnabled: draft.alertsEnabled,
      });
      setDraft(saved);
      toast.success("تم حفظ الإعدادات");
    } catch (err) {
      toast.error(getApiErrorMessage(err, "فشل حفظ الإعدادات"));
    } finally {
      setBusy("");
    }
  };

  const addRecipient = (employeeId: number) => {
    if (!draft) return;
    if (draft.recipients.some((r) => r.employeeId === employeeId)) return;
    setDraft({ ...draft, recipients: [...draft.recipients, { employeeId, whatsapp: true }] });
  };

  const removeRecipient = (employeeId: number) => {
    if (!draft) return;
    setDraft({ ...draft, recipients: draft.recipients.filter((r) => r.employeeId !== employeeId) });
  };

  const empName = (id: number) => employees.find((e) => e.id === id)?.name ?? `#${id}`;

  return (
    <Layout>
      <div className="space-y-6" dir="rtl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <DatabaseBackup className="h-7 w-7 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">النسخ الاحتياطي</h1>
              <p className="text-sm text-muted-foreground">
                نسخ يومي لقاعدة البيانات إلى Google Shared Drive (Service Account)
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={handleTest} disabled={busy !== ""}>
              {busy === "test" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plug className="h-4 w-4" />
              )}
              اختبار الاتصال
            </Button>
            <Button onClick={handleRun} disabled={busy !== "" || status?.running}>
              {busy === "run" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              تشغيل نسخة الآن
            </Button>
            <Button variant="ghost" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {status && !status.configured && (
          <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-semibold">النسخ الاحتياطي غير مُهيّأ</div>
              <ul className="mt-1 list-inside list-disc">
                {status.configProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {status?.compensationNeeded && (
          <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4" />
            لا توجد نسخة ناجحة اليوم — سيتم تشغيل نسخة تعويضية تلقائيًا.
          </div>
        )}

        {status && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  آخر نسخة ناجحة
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-lg font-semibold">
                  {status.lastSuccess ? fmtDate(status.lastSuccess.finishedAt) : "لا يوجد"}
                </div>
                {status.lastSuccess && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {status.lastSuccess.fileName} · {fmtBytes(status.lastSuccess.sizeBytes)}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  آخر محاولة
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  {status.lastRun?.status === "SUCCESS" ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                  ) : status.lastRun?.status === "FAILED" ? (
                    <XCircle className="h-5 w-5 text-red-600" />
                  ) : (
                    <Loader2 className="h-5 w-5 animate-spin text-amber-600" />
                  )}
                  <span className="text-lg font-semibold">
                    {status.lastRun
                      ? (STATUS_LABEL[status.lastRun.status] ?? status.lastRun.status)
                      : "—"}
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {status.lastRun ? fmtDate(status.lastRun.startedAt) : "—"}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  النسخ الناجحة / الفاشلة
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-lg font-semibold">
                  <span className="text-emerald-600">{status.counts.success}</span> /{" "}
                  <span className="text-red-600">{status.counts.failed}</span>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  الجدولة والاحتفاظ
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-sm">
                  يوميًا {String(status.scheduleHourUtc).padStart(2, "0")}:00 UTC
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  الاحتفاظ {status.retentionDays} يومًا
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {status && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">إعداد الاتصال</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <span className="text-muted-foreground">حساب الخدمة: </span>
                <span className="font-mono text-xs">
                  {status.serviceAccountEmail ?? "غير مضبوط"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">الفولدر / Shared Drive: </span>
                <span className="font-mono text-xs">{status.folderId || "غير مضبوط"}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">الحالة: </span>
                {status.configured ? (
                  <Badge className="bg-emerald-600">مُهيّأ</Badge>
                ) : (
                  <Badge variant="destructive">غير مُهيّأ</Badge>
                )}
                {status.running && <Badge className="bg-amber-500">قيد التنفيذ الآن</Badge>}
              </div>
            </CardContent>
          </Card>
        )}

        {draft && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">الإعدادات والتنبيهات</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Switch
                  checked={draft.alertsEnabled}
                  onCheckedChange={(v) => setDraft({ ...draft, alertsEnabled: v })}
                />
                <Label>إرسال تنبيه (إيميل + واتساب) عند فشل النسخ</Label>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label>مدة الاحتفاظ (يوم)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={3650}
                    value={draft.retentionDays}
                    onChange={(e) =>
                      setDraft({ ...draft, retentionDays: Number(e.target.value) || 30 })
                    }
                  />
                </div>
                <div>
                  <Label>ساعة التشغيل (UTC)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    value={draft.hourUtc}
                    onChange={(e) => setDraft({ ...draft, hourUtc: Number(e.target.value) || 0 })}
                  />
                </div>
              </div>

              <div>
                <Label>المستلمون (لازم صلاحية «backup:alerts» أو مدير/أدمن)</Label>
                <div className="mt-2 flex flex-wrap gap-2">
                  {draft.recipients.length === 0 && (
                    <span className="text-sm text-muted-foreground">لا يوجد مستلمون</span>
                  )}
                  {draft.recipients.map((r) => (
                    <Badge key={r.employeeId} variant="secondary" className="gap-1">
                      {empName(r.employeeId)}
                      <button
                        type="button"
                        onClick={() => removeRecipient(r.employeeId)}
                        className="text-red-600"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {employees
                    .filter((e) => !draft.recipients.some((r) => r.employeeId === e.id))
                    .map((e) => (
                      <Button
                        key={e.id}
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => addRecipient(e.id)}
                      >
                        <Plus className="h-3 w-3" />
                        {e.name}
                      </Button>
                    ))}
                </div>
              </div>

              <Button onClick={handleSave} disabled={busy !== ""}>
                {busy === "save" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                حفظ الإعدادات
              </Button>
            </CardContent>
          </Card>
        )}

        {status && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">سجل المحاولات (آخر 20)</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>البداية</TableHead>
                    <TableHead>النهاية</TableHead>
                    <TableHead>الحالة</TableHead>
                    <TableHead>المُشغِّل</TableHead>
                    <TableHead>الحجم</TableHead>
                    <TableHead>الملف</TableHead>
                    <TableHead>الخطأ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {status.recent.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground">
                        لا توجد سجلات بعد
                      </TableCell>
                    </TableRow>
                  )}
                  {status.recent.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {fmtDate(r.startedAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {fmtDate(r.finishedAt)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={
                            r.status === "SUCCESS"
                              ? "bg-emerald-600"
                              : r.status === "FAILED"
                                ? "bg-red-600"
                                : "bg-amber-500"
                          }
                        >
                          {STATUS_LABEL[r.status] ?? r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {TRIGGER_LABEL[r.trigger] ?? r.trigger}
                      </TableCell>
                      <TableCell className="text-xs">{fmtBytes(r.sizeBytes)}</TableCell>
                      <TableCell
                        className="max-w-[180px] truncate text-xs"
                        title={r.fileName ?? ""}
                      >
                        {r.fileName ?? "—"}
                      </TableCell>
                      <TableCell
                        className="max-w-[240px] truncate text-xs text-red-700"
                        title={r.error ?? ""}
                      >
                        {r.error ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}

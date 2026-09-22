/**
 * AI Assistant admin page — المساعد الذكي
 *
 * Manage the allowlisted WhatsApp numbers (admins/managers) and the assistant
 * settings. All endpoints are admin/manager-only on the backend too.
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
import { Bot, Plus, Trash2, Save, RefreshCw, ShieldAlert, Mail, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";
import { useAuth } from "@/contexts/AuthContext";

interface AiUser {
  id: number;
  phone: string;
  name: string | null;
  employeeId: number | null;
  role: string;
  isActive: boolean;
}

interface AiEmployee {
  id: number;
  name: string;
  role: string;
}

interface AiSettings {
  enabled: boolean;
  model: string;
  baseUrl: string | null;
  systemPrompt: string | null;
  language: string;
  allowEmail: boolean;
  allowDatabase: boolean;
  allowPdf: boolean;
  apiKeySet: boolean;
  imapConfigured: boolean;
  defaultBaseUrl: string;
}

async function apiGet<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as T;
}

export default function AiAssistantPage() {
  const { employee } = useAuth();
  const [users, setUsers] = useState<AiUser[]>([]);
  const [employees, setEmployees] = useState<AiEmployee[]>([]);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [newPhone, setNewPhone] = useState("");
  const [newName, setNewName] = useState("");
  const [newEmployeeId, setNewEmployeeId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [u, e, s] = await Promise.all([
        apiGet<AiUser[]>("/api/ai-assistant/users"),
        apiGet<AiEmployee[]>("/api/ai-assistant/employees"),
        apiGet<AiSettings>("/api/ai-assistant/settings"),
      ]);
      setUsers(u);
      setEmployees(e);
      setSettings(s);
    } catch (err) {
      toast.error(getApiErrorMessage(err, "فشل تحميل بيانات المساعد الذكي"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // admin/manager only — the backend enforces it regardless.
  const canManage = employee?.role === "admin" || employee?.role === "manager";

  async function addUser() {
    if (!newPhone.trim()) {
      toast.error("أدخل رقم الهاتف");
      return;
    }
    try {
      const r = await fetch("/api/ai-assistant/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          phone: newPhone.trim(),
          name: newName.trim() || null,
          employeeId: newEmployeeId ? Number(newEmployeeId) : null,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status}`);
      toast.success("تمت إضافة الرقم");
      setNewPhone("");
      setNewName("");
      setNewEmployeeId("");
      load();
    } catch (err) {
      toast.error(getApiErrorMessage(err, "تعذّر إضافة الرقم"));
    }
  }

  async function toggleUser(u: AiUser) {
    try {
      const r = await fetch(`/api/ai-assistant/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ isActive: !u.isActive }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      load();
    } catch (err) {
      toast.error(getApiErrorMessage(err, "تعذّر التحديث"));
    }
  }

  async function removeUser(u: AiUser) {
    if (!confirm(`حذف الرقم ${u.phone} من المساعد الذكي؟`)) return;
    try {
      const r = await fetch(`/api/ai-assistant/users/${u.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(`${r.status}`);
      toast.success("تم الحذف");
      load();
    } catch (err) {
      toast.error(getApiErrorMessage(err, "تعذّر الحذف"));
    }
  }

  async function saveSettings() {
    if (!settings) return;
    setSaving(true);
    try {
      const r = await fetch("/api/ai-assistant/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          enabled: settings.enabled,
          model: settings.model,
          baseUrl: settings.baseUrl,
          systemPrompt: settings.systemPrompt,
          language: settings.language,
          allowEmail: settings.allowEmail,
          allowDatabase: settings.allowDatabase,
          allowPdf: settings.allowPdf,
        }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      toast.success("تم حفظ الإعدادات");
      load();
    } catch (err) {
      toast.error(getApiErrorMessage(err, "تعذّر حفظ الإعدادات"));
    } finally {
      setSaving(false);
    }
  }

  const roleLabel = (role: string) => (role === "admin" ? "مدير نظام" : "مدير");

  return (
    <Layout>
      <div className="p-4 md:p-6 space-y-6" dir="rtl">
        <div className="flex items-center gap-3">
          <Bot className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">المساعد الذكي</h1>
            <p className="text-sm text-muted-foreground">
              وكيل ذكاء اصطناعي على واتساب للأدمن والمديرين — يجيب على أي سؤال من بيانات النظام
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Badge variant={settings?.apiKeySet ? "default" : "destructive"} className="gap-1">
            {settings?.apiKeySet ? "مفتاح الذكاء الاصطناعي مضبوط" : "مفتاح AI_API_KEY غير مضبوط"}
          </Badge>
          <Badge variant={settings?.imapConfigured ? "default" : "secondary"} className="gap-1">
            <Mail className="h-3 w-3" />
            {settings?.imapConfigured ? "البريد الوارد متاح" : "البريد الوارد غير مهيّأ (IMAP)"}
          </Badge>
        </div>

        {(!settings?.apiKeySet || !settings?.imapConfigured) && (
          <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
            <CardContent className="pt-4 text-sm text-amber-800 dark:text-amber-200 flex gap-2">
              <ShieldAlert className="h-5 w-5 shrink-0" />
              <div>
                لتفعيل كل الإمكانات، يجب ضبط متغيّرات البيئة على الخادم:
                <ul className="list-disc pr-5 mt-1 space-y-0.5">
                  <li>
                    <code>AI_API_KEY</code> — مفتاح مزوّد الذكاء الاصطناعي (OpenAI-compatible)
                  </li>
                  <li>
                    <code>AI_MODEL</code> — اسم الموديل (اختياري، الافتراضي gpt-4o)
                  </li>
                  <li>
                    <code>IMAP_HOST / IMAP_USER / IMAP_PASS</code> — لقراءة البريد الوارد
                  </li>
                </ul>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Plus className="h-5 w-5" /> الأرقام المصرّح لها (للأدمن والمديرين فقط)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-4">
              <div className="space-y-1">
                <Label>رقم واتساب</Label>
                <Input
                  placeholder="مثال: 201012345678"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>الاسم</Label>
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>ربط بموظف (اختياري)</Label>
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={newEmployeeId}
                  onChange={(e) => setNewEmployeeId(e.target.value)}
                >
                  <option value="">— بدون ربط —</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} ({roleLabel(e.role)})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <Button onClick={addUser} className="w-full" disabled={!canManage}>
                  إضافة
                </Button>
              </div>
            </div>

            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : users.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-6">
                لا توجد أرقام مصرّح لها بعد.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>الرقم</TableHead>
                    <TableHead>الاسم</TableHead>
                    <TableHead>الصلاحية</TableHead>
                    <TableHead>الحالة</TableHead>
                    <TableHead className="text-left">إجراءات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="font-mono">{u.phone}</TableCell>
                      <TableCell>
                        {u.name || "—"}
                        {u.employeeId && (
                          <span className="text-xs text-muted-foreground block">
                            موظف #{u.employeeId}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={u.role === "admin" ? "default" : "secondary"}>
                          {roleLabel(u.role)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Switch checked={u.isActive} onCheckedChange={() => toggleUser(u)} />
                      </TableCell>
                      <TableCell className="text-left">
                        <Button variant="ghost" size="icon" onClick={() => removeUser(u)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {settings && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Save className="h-5 w-5" /> الإعدادات
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label>تفعيل المساعد الذكي</Label>
                  <p className="text-xs text-muted-foreground">إيقافه يمنع كل الردود عبر واتساب.</p>
                </div>
                <Switch
                  checked={settings.enabled}
                  onCheckedChange={(v) => setSettings({ ...settings, enabled: v })}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <Label>الموديل</Label>
                  <Input
                    value={settings.model}
                    onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>عنوان API (اختياري)</Label>
                  <Input
                    placeholder={settings.defaultBaseUrl}
                    value={settings.baseUrl ?? ""}
                    onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>لغة الردود</Label>
                  <select
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={settings.language}
                    onChange={(e) => setSettings({ ...settings, language: e.target.value })}
                  >
                    <option value="ar">العربية</option>
                    <option value="en">English</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <Label>تعليمات إضافية (System prompt)</Label>
                <textarea
                  className="w-full rounded-md border bg-background p-3 text-sm min-h-24"
                  value={settings.systemPrompt ?? ""}
                  onChange={(e) => setSettings({ ...settings, systemPrompt: e.target.value })}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <Label>الوصول لقاعدة البيانات</Label>
                  <Switch
                    checked={settings.allowDatabase}
                    onCheckedChange={(v) => setSettings({ ...settings, allowDatabase: v })}
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <Label>الوصول للبريد</Label>
                  <Switch
                    checked={settings.allowEmail}
                    onCheckedChange={(v) => setSettings({ ...settings, allowEmail: v })}
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <Label>إنشاء PDF</Label>
                  <Switch
                    checked={settings.allowPdf}
                    onCheckedChange={(v) => setSettings({ ...settings, allowPdf: v })}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={load}>
                  <RefreshCw className="h-4 w-4 ml-1" /> إعادة تحميل
                </Button>
                <Button onClick={saveSettings} disabled={saving || !canManage}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin ml-1" />} حفظ
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}

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
import { Textarea } from "@/components/ui/textarea";
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
  Bot,
  Plus,
  Trash2,
  Save,
  RefreshCw,
  ShieldAlert,
  Mail,
  Loader2,
  Sparkles,
  Brain,
  Pin,
  PinOff,
  Activity,
} from "lucide-react";
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

interface AiMemory {
  id: number;
  phone: string;
  category: string;
  key: string;
  value: string;
  importance: number;
  source: string;
  pinned: boolean;
  useCount: number;
  updatedAt: string;
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
  defaultModel?: string;
  fallbackModels?: string[];
  defaultBaseUrl: string;
  isGemini?: boolean;
}

interface AiMetrics {
  summary: {
    count: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    avgRounds: number;
    timeoutRate: number;
    verificationRate: number;
    avgToolCalls?: number;
    fallbackRate?: number;
    byIntent?: Record<string, number>;
    byPath?: Record<string, number>;
    byModel?: Record<string, number>;
    byConfidence?: Record<string, number>;
  };
  recent: Array<{
    phone: string;
    intent: string;
    path: string;
    rounds: number;
    toolCalls: number;
    verified: boolean;
    latencyMs: number;
    outcome: string;
    model?: string;
    fallbackUsed?: boolean;
    confidence?: "VERIFIED" | "PARTIALLY_VERIFIED" | "INSUFFICIENT_EVIDENCE";
  }>;
}

interface AiJob {
  id: number;
  phone: string;
  kind: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  question: string | null;
  progress: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
}

/**
 * Example questions shown on the admin page, grouped by the capability they
 * exercise. Each corresponds to a real tool the assistant has (database lookup,
 * email census, supplier-quote comparison, delivery follow-up) — so the list
 * stays honest about what the agent can actually do.
 */
const EXAMPLE_QUESTIONS: Array<{ title: string; items: string[] }> = [
  {
    title: "بيانات النظام",
    items: [
      "آخر أوامر توريد واردة من العملاء",
      "كل أوامر الشراء الخاصة بمورد «هاي فولت»",
      "أعطني أرقام طلبات التسعير غير الموجودة في النظام",
      "إجمالي المبيعات الشهر ده",
    ],
  },
  {
    title: "المقارنة والتسعير",
    items: [
      "قارن أسعار الموردين لبند رقم X",
      "أنسب مورد لطلب التسعير CRFQ-2026-000123",
      "إيه هامش الربح المتوقع لأمر شراء العميل كذا؟",
      "أقل سعر مسجل للقطعة X من مين؟",
    ],
  },
  {
    title: "التوريد والمتابعة",
    items: [
      "إيه التوريدات المتأخرة عن موعدها؟",
      "حالة استلام أمر الشراء P26E11407",
      "أوامر الشراء اللي لسه متمش استلامها من الموردين",
      "بنود العميل اللي اترفض تسليمها",
    ],
  },
  {
    title: "البريد والمستندات",
    items: [
      "عمره كام رسالة طلب تسعير وردت سنة 2026؟",
      "اكتر بند اتكرر في أوامر التوريد الواردة",
      "هات ملف الـ PDF الخاص بأمر شراء Jaz Almaza",
      "إيه البنود اللي في آخر أمر توريد ورد من EDC؟",
    ],
  },
];

async function apiGet<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as T;
}

type ConfidenceLevel = "VERIFIED" | "PARTIALLY_VERIFIED" | "INSUFFICIENT_EVIDENCE";

function confidenceLabel(level: ConfidenceLevel | undefined): string {
  switch (level) {
    case "VERIFIED":
      return "موثّق";
    case "PARTIALLY_VERIFIED":
      return "جزئي";
    case "INSUFFICIENT_EVIDENCE":
      return "غير كافٍ";
    default:
      return "—";
  }
}

function confidenceClass(level: ConfidenceLevel | undefined): string {
  switch (level) {
    case "VERIFIED":
      return "border-emerald-400 text-emerald-700";
    case "PARTIALLY_VERIFIED":
      return "border-amber-400 text-amber-700";
    case "INSUFFICIENT_EVIDENCE":
      return "border-red-400 text-red-700";
    default:
      return "text-muted-foreground";
  }
}

export default function AiAssistantPage() {
  const { employee } = useAuth();
  const [users, setUsers] = useState<AiUser[]>([]);
  const [employees, setEmployees] = useState<AiEmployee[]>([]);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<AiMetrics | null>(null);
  const [jobs, setJobs] = useState<AiJob[]>([]);

  const [newPhone, setNewPhone] = useState("");
  const [newName, setNewName] = useState("");
  const [newEmployeeId, setNewEmployeeId] = useState("");

  // ── Long-term memory ─────────────────────────────────────────────────────
  const [memories, setMemories] = useState<AiMemory[]>([]);
  const [memCategory, setMemCategory] = useState("");
  const [memSearch, setMemSearch] = useState("");
  const [newMemKey, setNewMemKey] = useState("");
  const [newMemValue, setNewMemValue] = useState("");
  const [newMemShared, setNewMemShared] = useState(true);
  const [savingMem, setSavingMem] = useState(false);

  const loadMemories = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (memCategory) params.set("category", memCategory);
      const qs = params.toString();
      setMemories(await apiGet<AiMemory[]>(`/api/ai-assistant/memories${qs ? `?${qs}` : ""}`));
    } catch (err) {
      toast.error(getApiErrorMessage(err, "فشل تحميل الذاكرة"));
    }
  }, [memCategory]);

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
      // Model list is best-effort — falls back to a free-text input.
      apiGet<{ models: string[] }>("/api/ai-assistant/models")
        .then((m) => setModels(m.models))
        .catch(() => setModels([]));
      // Request telemetry is best-effort too — it is an operational signal, and
      // its absence must never block the settings page.
      apiGet<AiMetrics>("/api/ai-assistant/metrics")
        .then(setMetrics)
        .catch(() => setMetrics(null));
      // Async jobs are best-effort as well.
      apiGet<{ jobs: AiJob[] }>("/api/ai-assistant/jobs")
        .then((j) => setJobs(j.jobs))
        .catch(() => setJobs([]));
      await loadMemories();
    } catch (err) {
      toast.error(getApiErrorMessage(err, "فشل تحميل بيانات المساعد الذكي"));
    } finally {
      setLoading(false);
    }
  }, [loadMemories]);

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

  const CATEGORY_LABELS: Record<string, string> = {
    fact: "معلومة",
    preference: "تفضيل",
    entity: "جهة/كيان",
    rule: "قاعدة",
    lesson: "درس مستفاد",
  };

  async function addMemory() {
    if (!newMemKey.trim() || !newMemValue.trim()) {
      toast.error("أدخل المفتاح والقيمة");
      return;
    }
    setSavingMem(true);
    try {
      const r = await fetch("/api/ai-assistant/memories", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: newMemKey,
          value: newMemValue,
          shared: newMemShared,
          importance: 80,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setNewMemKey("");
      setNewMemValue("");
      await loadMemories();
      toast.success("تم حفظ المعلومة في ذاكرة المساعد");
    } catch (err) {
      toast.error(getApiErrorMessage(err, "تعذّر حفظ الذاكرة"));
    } finally {
      setSavingMem(false);
    }
  }

  async function patchMemory(id: number, patch: Partial<AiMemory>) {
    try {
      const r = await fetch(`/api/ai-assistant/memories/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    } catch (err) {
      toast.error(getApiErrorMessage(err, "تعذّر تحديث الذاكرة"));
    }
  }

  async function deleteMemory(id: number) {
    try {
      const r = await fetch(`/api/ai-assistant/memories/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setMemories((prev) => prev.filter((m) => m.id !== id));
      toast.success("تم حذف المعلومة");
    } catch (err) {
      toast.error(getApiErrorMessage(err, "تعذّر حذف الذاكرة"));
    }
  }

  // Client-side filter over the loaded rows — the server already caps at 500,
  // and a search is instant against what is in hand.
  const shownMemories = memories.filter((m) => {
    if (!memSearch.trim()) return true;
    const q = memSearch.trim().toLowerCase();
    return m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q);
  });

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
          {settings?.isGemini && (
            <Badge variant="secondary" className="gap-1">
              <Sparkles className="h-3 w-3" />
              Google Gemini
            </Badge>
          )}
        </div>

        {(!settings?.apiKeySet || !settings?.imapConfigured) && (
          <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
            <CardContent className="pt-4 text-sm text-amber-800 dark:text-amber-200 flex gap-2">
              <ShieldAlert className="h-5 w-5 shrink-0" />
              <div>
                لتفعيل كل الإمكانات، يجب ضبط متغيّرات البيئة على الخادم:
                <ul className="list-disc pr-5 mt-1 space-y-0.5">
                  <li>
                    <code>AI_API_KEY</code> — مفتاح مزوّد الذكاء الاصطناعي (Google Gemini أو أي
                    مزوّد متوافق مع OpenAI)
                  </li>
                  <li>
                    <code>AI_MODEL</code> — اسم الموديل (اختياري، الافتراضي gemini-3.8-flash)
                  </li>
                  <li>
                    <code>IMAP_HOST / IMAP_USER / IMAP_PASS</code> — لقراءة البريد الوارد
                  </li>
                </ul>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Operator onboarding: the assistant answers a specific set of questions
            well and poorly on others. Concrete examples turn a vague «اسألني عن
            أي حاجة» into a usable tool — and each maps to a real tool/intent. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">أمثلة أسئلة يفهمها المساعد</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {EXAMPLE_QUESTIONS.map((group) => (
              <div key={group.title} className="rounded-lg border p-3">
                <p className="mb-2 text-sm font-semibold">{group.title}</p>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {group.items.map((q) => (
                    <li key={q}>• {q}</li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>

        {metrics && metrics.summary.count > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Activity className="h-5 w-5" /> أداء الطلبات (آخر {metrics.summary.count} طلب)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">متوسط زمن الرد</p>
                  <p className="text-xl font-bold">
                    {(metrics.summary.avgLatencyMs / 1000).toFixed(1)} ث
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">الزمن عند 95%</p>
                  <p className="text-xl font-bold">
                    {(metrics.summary.p95LatencyMs / 1000).toFixed(1)} ث
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">متوسط جولات النموذج</p>
                  <p className="text-xl font-bold">{metrics.summary.avgRounds}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">نسبة انتهاء المهلة</p>
                  <p className="text-xl font-bold">
                    {(metrics.summary.timeoutRate * 100).toFixed(0)}%
                  </p>
                </div>
              </div>

              {/* P6 routing effectiveness: which path the router chose and how
                  often a fallback model carried the answer. A rising fallback
                  share means the primary model is quota-limited/overloaded. */}
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">متوسط استدعاءات الأدوات</p>
                  <p className="text-xl font-bold">{metrics.summary.avgToolCalls ?? 0}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">نسبة الموديل البديل</p>
                  <p className="text-xl font-bold">
                    {((metrics.summary.fallbackRate ?? 0) * 100).toFixed(0)}%
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">توزيع المسارات</p>
                  <p className="text-sm font-semibold">
                    سريع {metrics.summary.byPath?.fast ?? 0} · تحليلي{" "}
                    {metrics.summary.byPath?.deep ?? 0}
                  </p>
                </div>
              </div>

              {metrics.summary.byConfidence &&
                Object.keys(metrics.summary.byConfidence).length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">مستوى الدليل:</span>
                    {Object.entries(metrics.summary.byConfidence)
                      .sort((a, b) => b[1] - a[1])
                      .map(([level, n]) => (
                        <Badge
                          key={level}
                          variant="secondary"
                          className={`text-xs ${confidenceClass(level as ConfidenceLevel)}`}
                        >
                          {confidenceLabel(level as ConfidenceLevel)}: {n}
                        </Badge>
                      ))}
                  </div>
                )}
              {metrics.summary.byIntent && Object.keys(metrics.summary.byIntent).length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(metrics.summary.byIntent)
                    .sort((a, b) => b[1] - a[1])
                    .map(([intent, n]) => (
                      <Badge key={intent} variant="secondary" className="text-xs">
                        {intent}: {n}
                      </Badge>
                    ))}
                </div>
              )}
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>النوع</TableHead>
                      <TableHead>المسار</TableHead>
                      <TableHead>الموديل</TableHead>
                      <TableHead>الجولات</TableHead>
                      <TableHead>الأدوات</TableHead>
                      <TableHead>التحقق</TableHead>
                      <TableHead>مستوى الدليل</TableHead>
                      <TableHead>الزمن</TableHead>
                      <TableHead>النتيجة</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {metrics.recent.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-xs">{r.intent}</TableCell>
                        <TableCell className="text-xs">
                          {r.path === "fast" ? "سريع" : "تحليلي"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.model ?? "—"}
                          {r.fallbackUsed ? " (بديل)" : ""}
                        </TableCell>
                        <TableCell className="text-xs">{r.rounds}</TableCell>
                        <TableCell className="text-xs">{r.toolCalls}</TableCell>
                        <TableCell className="text-xs">{r.verified ? "نعم" : "لا"}</TableCell>
                        <TableCell className="text-xs">
                          <Badge variant="secondary" className={confidenceClass(r.confidence)}>
                            {confidenceLabel(r.confidence)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {(r.latencyMs / 1000).toFixed(1)} ث
                        </TableCell>
                        <TableCell className="text-xs">
                          <Badge variant={r.outcome === "answered" ? "default" : "destructive"}>
                            {r.outcome}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {jobs.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Activity className="h-5 w-5" /> المهام الخلفية (Async Jobs)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>النوع</TableHead>
                      <TableHead>الحالة</TableHead>
                      <TableHead>التقدم</TableHead>
                      <TableHead>السؤال</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobs.map((j) => {
                      const p = (j.progress ?? {}) as Record<string, unknown>;
                      const prog = ["scanned", "matched", "attachments", "items"]
                        .filter((k) => p[k] != null)
                        .map((k) => `${k}: ${p[k]}`)
                        .join(" · ");
                      return (
                        <TableRow key={j.id}>
                          <TableCell className="text-xs">{j.id}</TableCell>
                          <TableCell className="text-xs">{j.kind}</TableCell>
                          <TableCell className="text-xs">
                            <Badge
                              variant={
                                j.status === "completed"
                                  ? "default"
                                  : j.status === "failed"
                                    ? "destructive"
                                    : "secondary"
                              }
                            >
                              {j.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">{prog || "—"}</TableCell>
                          <TableCell className="max-w-xs truncate text-xs">
                            {j.question ?? "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
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
                  {models.length > 0 ? (
                    <select
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                      value={settings.model}
                      onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                    >
                      {!models.includes(settings.model) && (
                        <option value={settings.model}>{settings.model}</option>
                      )}
                      {models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      value={settings.model}
                      onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                    />
                  )}
                  {settings.fallbackModels && settings.fallbackModels.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      عند نفاد حصة الموديل (429) يتحوّل تلقائيًا إلى:{" "}
                      {settings.fallbackModels.join(" ← ")}
                    </p>
                  )}
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

        {/* ── Long-term memory ─────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Brain className="h-5 w-5 text-primary" />
              ذاكرة المساعد طويلة المدى
              <Badge variant="secondary">{memories.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              المعلومة المحفوظة يعرفها المساعد في كل المحادثات القادمة. يتعلّم تلقائيًا عند قول
              «افتكر إن…» أو تصحيح خطأ، ويمكنك هنا إضافة أو تعديل أو تثبيت أو حذف أي معلومة. تثبيت
              المعلومة يجعلها تُحقن دائمًا في سياق المساعد.
            </p>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label>المفتاح (مفتاح قصير يوصف المعلومة)</Label>
                <Input
                  value={newMemKey}
                  onChange={(e) => setNewMemKey(e.target.value)}
                  placeholder="مثال: اسم المورد المفضل للسلك"
                />
              </div>
              <div className="space-y-1">
                <Label>القيمة</Label>
                <Textarea
                  value={newMemValue}
                  onChange={(e) => setNewMemValue(e.target.value)}
                  placeholder="المعلومة كاملة كما يجب أن يعرفها المساعد"
                  rows={2}
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Switch checked={newMemShared} onCheckedChange={setNewMemShared} />
                <Label>مشتركة لكل المستخدمين (بدونها تكون خاصة برقمك)</Label>
              </div>
              <Button onClick={addMemory} disabled={savingMem || !canManage}>
                {savingMem ? (
                  <Loader2 className="h-4 w-4 animate-spin ml-1" />
                ) : (
                  <Plus className="h-4 w-4 ml-1" />
                )}
                إضافة للذاكرة
              </Button>
            </div>

            <div className="flex flex-wrap gap-2 items-center">
              <Input
                className="max-w-xs"
                value={memSearch}
                onChange={(e) => setMemSearch(e.target.value)}
                placeholder="بحث في الذاكرة..."
              />
              <div className="flex flex-wrap gap-1">
                {["", "fact", "preference", "entity", "rule", "lesson"].map((c) => (
                  <Button
                    key={c || "all"}
                    size="sm"
                    variant={memCategory === c ? "default" : "outline"}
                    onClick={() => setMemCategory(c)}
                  >
                    {c ? CATEGORY_LABELS[c] : "الكل"}
                  </Button>
                ))}
              </div>
            </div>

            {shownMemories.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                لا توجد معلومات محفوظة بعد. علّم المساعد من واتساب أو أضف معلومة من هنا.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>النوع</TableHead>
                    <TableHead>المفتاح</TableHead>
                    <TableHead>القيمة</TableHead>
                    <TableHead>النطاق</TableHead>
                    <TableHead>الأهمية</TableHead>
                    <TableHead>الاستخدام</TableHead>
                    <TableHead className="text-left">إجراءات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shownMemories.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <Badge variant="secondary">
                          {CATEGORY_LABELS[m.category] ?? m.category}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">{m.key}</TableCell>
                      <TableCell className="max-w-md whitespace-pre-wrap text-sm">
                        {m.value}
                      </TableCell>
                      <TableCell>
                        <Badge variant={m.phone ? "outline" : "default"}>
                          {m.phone ? m.phone : "مشتركة"}
                        </Badge>
                      </TableCell>
                      <TableCell>{m.importance}</TableCell>
                      <TableCell>{m.useCount}</TableCell>
                      <TableCell className="text-left">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            title={m.pinned ? "إلغاء التثبيت" : "تثبيت"}
                            onClick={() => patchMemory(m.id, { pinned: !m.pinned })}
                          >
                            {m.pinned ? (
                              <PinOff className="h-4 w-4" />
                            ) : (
                              <Pin className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="text-destructive"
                            title="حذف"
                            onClick={() => deleteMemory(m.id)}
                            disabled={!canManage}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}

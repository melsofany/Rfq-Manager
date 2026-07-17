import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Plug,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Trash2,
  Settings2,
  ArrowDownToLine,
  ArrowUpFromLine,
  Wifi,
  WifiOff,
  ChevronDown,
  ChevronUp,
  AlertCircle,
} from "lucide-react";

// ─── ERP System definitions ───────────────────────────────────────────────────
type ErpType = "odoo" | "sap-b1" | "sap-s4hana" | "oracle" | "google-sheets";

interface ErpSystem {
  type: ErpType;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  logo: string;
  color: string;
  fields: FieldDef[];
}

interface FieldDef {
  key: string;
  label: string;
  labelAr: string;
  placeholder?: string;
  type?: "text" | "password" | "url";
  required?: boolean;
  hint?: string;
  hintAr?: string;
}

const ERP_SYSTEMS: ErpSystem[] = [
  {
    type: "odoo",
    name: "Odoo",
    nameAr: "أودو",
    description: "Connect to Odoo via XML-RPC API",
    descriptionAr: "اتصل بـ Odoo عبر واجهة XML-RPC",
    logo: "🟣",
    color: "from-purple-50 to-purple-100 border-purple-200 hover:border-purple-400",
    fields: [
      { key: "url",      label: "Odoo URL",    labelAr: "رابط الخادم",      placeholder: "https://mycompany.odoo.com", type: "url",      required: true },
      { key: "db",       label: "Database",    labelAr: "اسم قاعدة البيانات", placeholder: "mycompany",                  type: "text",     required: true },
      { key: "username", label: "Email",       labelAr: "البريد الإلكتروني",  placeholder: "admin@company.com",          type: "text",     required: true },
      { key: "apiKey",   label: "API Key",     labelAr: "مفتاح API",          placeholder: "من إعدادات المستخدم",        type: "password", required: true,
        hint: "Settings → Users → your user → API Keys", hintAr: "الإعدادات → المستخدمون → مفاتيح API" },
    ],
  },
  {
    type: "sap-b1",
    name: "SAP Business One",
    nameAr: "SAP بيزنس ون",
    description: "Connect to SAP B1 via Service Layer",
    descriptionAr: "اتصل بـ SAP Business One عبر Service Layer",
    logo: "🔵",
    color: "from-blue-50 to-blue-100 border-blue-200 hover:border-blue-400",
    fields: [
      { key: "url",       label: "Server URL",  labelAr: "رابط الخادم",        placeholder: "https://sap-server:50000", type: "url",      required: true },
      { key: "companyDB", label: "Company DB",  labelAr: "قاعدة بيانات الشركة", placeholder: "MYCOMPANY",               type: "text",     required: true },
      { key: "username",  label: "Username",    labelAr: "اسم المستخدم",        placeholder: "manager",                 type: "text",     required: true },
      { key: "password",  label: "Password",    labelAr: "كلمة المرور",          placeholder: "••••••••",               type: "password", required: true },
    ],
  },
  {
    type: "sap-s4hana",
    name: "SAP S/4HANA",
    nameAr: "SAP S/4HANA",
    description: "Connect to SAP S/4HANA via OData v4",
    descriptionAr: "اتصل بـ SAP S/4HANA عبر OData v4",
    logo: "🔷",
    color: "from-cyan-50 to-cyan-100 border-cyan-200 hover:border-cyan-400",
    fields: [
      { key: "url",      label: "System URL",  labelAr: "رابط النظام",    placeholder: "https://myXXXXXX.s4hana.ondemand.com", type: "url",      required: true },
      { key: "username", label: "Username",    labelAr: "اسم المستخدم",   placeholder: "S4H_USER",                             type: "text",     required: true },
      { key: "password", label: "Password",    labelAr: "كلمة المرور",    placeholder: "••••••••",                            type: "password", required: true },
    ],
  },
  {
    type: "oracle",
    name: "Oracle ERP Cloud",
    nameAr: "أوراكل ERP Cloud",
    description: "Connect to Oracle ERP Cloud REST API",
    descriptionAr: "اتصل بـ Oracle ERP Cloud عبر REST API",
    logo: "🔴",
    color: "from-red-50 to-red-100 border-red-200 hover:border-red-400",
    fields: [
      { key: "url",          label: "Host URL",      labelAr: "رابط الخادم",      placeholder: "https://xxx.fa.em2.oraclecloud.com", type: "url",      required: true },
      { key: "username",     label: "Username",      labelAr: "اسم المستخدم",     placeholder: "oracle_user",                        type: "text",     required: true },
      { key: "password",     label: "Password",      labelAr: "كلمة المرور",      placeholder: "••••••••",                          type: "password", required: true },
      { key: "businessUnit", label: "Business Unit", labelAr: "وحدة الأعمال",     placeholder: "US1 Business Unit",                 type: "text",     required: false },
    ],
  },
  {
    type: "google-sheets",
    name: "Google Sheets",
    nameAr: "جداول بيانات Google",
    description: "Sync with Google Sheets as a data source",
    descriptionAr: "مزامنة مع Google Sheets كمصدر بيانات",
    logo: "🟢",
    color: "from-green-50 to-green-100 border-green-200 hover:border-green-400",
    fields: [
      { key: "spreadsheetId",      label: "Spreadsheet ID",     labelAr: "معرّف الجدول",           placeholder: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms", type: "text", required: true,
        hint: "From the sheet URL: /d/{ID}/", hintAr: "من رابط الـ Sheet: /d/{ID}/" },
      { key: "dataSheetName",      label: "Suppliers Tab Name", labelAr: "اسم تاب الموردين",       placeholder: "Suppliers",                                  type: "text", required: false },
      { key: "serviceAccountBase64", label: "Service Account JSON (Base64)", labelAr: "Service Account JSON (Base64)",
        placeholder: "اتركه فارغاً لاستخدام الإعداد الافتراضي", type: "password", required: false,
        hint: "Leave empty to use the default service account", hintAr: "اتركه فارغاً لاستخدام الحساب الافتراضي" },
    ],
  },
];

// ─── API helpers ─────────────────────────────────────────────────────────────

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Error ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

interface ErpIntegration {
  id: number;
  name: string;
  type: ErpType;
  config: Record<string, unknown>;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: "success" | "error" | "partial" | null;
  lastSyncError: string | null;
  lastSyncStats: Record<string, number> | null;
}

// ─── ConnectDialog ────────────────────────────────────────────────────────────

function ConnectDialog({
  system,
  existing,
  lang,
  onClose,
  onSaved,
}: {
  system: ErpSystem;
  existing?: ErpIntegration;
  lang: "en" | "ar";
  onClose: () => void;
  onSaved: () => void;
}) {
  const isAr = lang === "ar";
  const [name, setName] = useState(existing?.name ?? `${isAr ? system.nameAr : system.name}`);
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    system.fields.forEach((f) => {
      init[f.key] = existing?.config?.[f.key] ? String(existing.config[f.key]) : "";
    });
    return init;
  });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; version?: string; error?: string } | null>(null);

  const config: Record<string, string> = {};
  system.fields.forEach((f) => { if (fields[f.key]) config[f.key] = fields[f.key]; });

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      let integrationId = existing?.id;
      if (!integrationId) {
        // إنشاء مؤقت للاختبار
        const created = await apiFetch("/integrations", {
          method: "POST",
          body: JSON.stringify({ name, type: system.type, config }),
        });
        integrationId = created.id;
        const result = await apiFetch(`/integrations/${integrationId}/test`, { method: "POST" });
        await apiFetch(`/integrations/${integrationId}`, { method: "DELETE" });
        setTestResult(result);
      } else {
        await apiFetch(`/integrations/${integrationId}`, {
          method: "PATCH",
          body: JSON.stringify({ config }),
        });
        const result = await apiFetch(`/integrations/${integrationId}/test`, { method: "POST" });
        setTestResult(result);
      }
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      if (existing) {
        await apiFetch(`/integrations/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, config }),
        });
        toast.success(isAr ? "تم تحديث التكامل" : "Integration updated");
      } else {
        await apiFetch("/integrations", {
          method: "POST",
          body: JSON.stringify({ name, type: system.type, config }),
        });
        toast.success(isAr ? "تم الاتصال بنجاح ✓" : "Connected successfully ✓");
      }
      onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`bg-gradient-to-r ${system.color.split(" ").slice(0, 2).join(" ")} px-6 py-5 border-b`}>
          <div className="flex items-center gap-3">
            <span className="text-3xl">{system.logo}</span>
            <div>
              <h2 className="text-lg font-bold text-gray-900">
                {existing
                  ? (isAr ? "تعديل الاتصال" : "Edit Connection")
                  : (isAr ? `الاتصال بـ ${system.nameAr}` : `Connect to ${system.name}`)}
              </h2>
              <p className="text-sm text-gray-500">{isAr ? system.descriptionAr : system.description}</p>
            </div>
          </div>
        </div>

        {/* Form */}
        <div className="px-6 py-5 space-y-4 max-h-[60vh] overflow-y-auto">
          {/* Connection name */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-gray-700">
              {isAr ? "اسم الاتصال" : "Connection Name"} *
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isAr ? "مثال: Odoo الإنتاج" : "e.g. Odoo Production"}
            />
          </div>

          {/* ERP fields */}
          {system.fields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label className="text-sm font-medium text-gray-700">
                {isAr ? f.labelAr : f.label}
                {f.required && <span className="text-red-500 ml-0.5">*</span>}
              </Label>
              <Input
                type={f.type ?? "text"}
                value={fields[f.key] ?? ""}
                onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
              />
              {(f.hint || f.hintAr) && (
                <p className="text-xs text-gray-400">{isAr ? (f.hintAr ?? f.hint) : (f.hint ?? f.hintAr)}</p>
              )}
            </div>
          ))}

          {/* Test result */}
          {testResult && (
            <div className={`flex items-start gap-2 p-3 rounded-lg text-sm ${
              testResult.ok ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"
            }`}>
              {testResult.ok
                ? <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
                : <XCircle size={16} className="mt-0.5 flex-shrink-0" />}
              <div>
                {testResult.ok
                  ? <span>{isAr ? "✓ الاتصال ناجح" : "✓ Connection successful"}{testResult.version ? ` — ${testResult.version}` : ""}</span>
                  : <span>{isAr ? "✗ فشل الاتصال: " : "✗ Connection failed: "}{testResult.error}</span>}
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-6 py-4 border-t bg-gray-50 flex items-center justify-between gap-3">
          <Button variant="outline" size="sm" onClick={handleTest} disabled={testing || !name.trim()}>
            {testing ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Wifi size={14} className="mr-1.5" />}
            {isAr ? "اختبار الاتصال" : "Test Connection"}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              {isAr ? "إلغاء" : "Cancel"}
            </Button>
            <Button onClick={handleSave} disabled={saving || !name.trim()}>
              {saving && <Loader2 size={14} className="animate-spin mr-1.5" />}
              {existing ? (isAr ? "حفظ التغييرات" : "Save Changes") : (isAr ? "اتصال" : "Connect")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── IntegrationCard (connected) ─────────────────────────────────────────────

function ConnectedCard({
  integration,
  system,
  lang,
  onEdit,
  onRefetch,
}: {
  integration: ErpIntegration;
  system: ErpSystem;
  lang: "en" | "ar";
  onEdit: () => void;
  onRefetch: () => void;
}) {
  const isAr = lang === "ar";
  const [syncing, setSyncing] = useState<"" | "import" | "export" | "full">("");
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toggling, setToggling] = useState(false);

  async function handleSync(type: "import" | "export" | "full") {
    setSyncing(type);
    try {
      const path = type === "import" ? "sync-suppliers" : type === "export" ? "export" : "sync";
      const res = await apiFetch(`/integrations/${integration.id}/${path}`, { method: "POST" });
      if (type === "full") {
        toast.info(isAr ? "بدأت المزامنة في الخلفية" : "Sync started in background");
      } else {
        const stats = Object.entries(res ?? {})
          .filter(([k]) => k !== "success")
          .map(([k, v]) => `${k}: ${v}`)
          .join(" · ");
        toast.success((isAr ? "✓ تمت العملية" : "✓ Done") + (stats ? ` — ${stats}` : ""));
      }
      onRefetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncing("");
    }
  }

  async function handleToggle() {
    setToggling(true);
    try {
      await apiFetch(`/integrations/${integration.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !integration.isActive }),
      });
      onRefetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setToggling(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiFetch(`/integrations/${integration.id}`, { method: "DELETE" });
      toast.success(isAr ? "تم حذف التكامل" : "Integration deleted");
      onRefetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const statusColor = integration.lastSyncStatus === "success"
    ? "text-green-600" : integration.lastSyncStatus === "error"
    ? "text-red-500" : "text-gray-400";

  return (
    <div className={`rounded-xl border-2 bg-white transition-shadow hover:shadow-md ${
      integration.isActive ? "border-gray-200" : "border-dashed border-gray-300 opacity-70"
    }`}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <span className="text-2xl flex-shrink-0">{system.logo}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-gray-900 truncate">{integration.name}</h3>
                <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
                  integration.isActive ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                }`}>
                  {integration.isActive
                    ? <><Wifi size={10} />{isAr ? "مفعّل" : "Active"}</>
                    : <><WifiOff size={10} />{isAr ? "معطّل" : "Inactive"}</>}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                {isAr ? system.nameAr : system.name}
                {integration.lastSyncAt && (
                  <span className={`ml-2 ${statusColor}`}>
                    · {isAr ? "آخر مزامنة:" : "Last sync:"} {new Date(integration.lastSyncAt).toLocaleDateString()}
                    {integration.lastSyncStatus && ` (${integration.lastSyncStatus})`}
                  </span>
                )}
              </p>
            </div>
          </div>

          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-gray-400 hover:text-gray-600 p-1"
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>

        {/* Error message */}
        {integration.lastSyncStatus === "error" && integration.lastSyncError && (
          <div className="mt-3 flex items-start gap-1.5 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 border border-red-100">
            <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
            <span>{integration.lastSyncError}</span>
          </div>
        )}

        {/* Sync buttons */}
        <div className="flex flex-wrap gap-2 mt-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleSync("import")}
            disabled={!!syncing || !integration.isActive}
          >
            {syncing === "import" ? <Loader2 size={13} className="animate-spin mr-1" /> : <ArrowDownToLine size={13} className="mr-1" />}
            {isAr ? "استيراد موردين" : "Import Suppliers"}
          </Button>
          {integration.type === "google-sheets" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleSync("export")}
              disabled={!!syncing || !integration.isActive}
            >
              {syncing === "export" ? <Loader2 size={13} className="animate-spin mr-1" /> : <ArrowUpFromLine size={13} className="mr-1" />}
              {isAr ? "تصدير البيانات" : "Export Data"}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => handleSync("full")}
            disabled={!!syncing || !integration.isActive}
          >
            {syncing === "full" ? <Loader2 size={13} className="animate-spin mr-1" /> : <RefreshCw size={13} className="mr-1" />}
            {isAr ? "مزامنة كاملة" : "Full Sync"}
          </Button>
        </div>
      </div>

      {/* Expanded actions */}
      {expanded && (
        <div className="border-t px-4 py-3 flex flex-wrap items-center gap-2 bg-gray-50 rounded-b-xl">
          <Button size="sm" variant="ghost" onClick={onEdit} className="text-gray-600">
            <Settings2 size={13} className="mr-1" />
            {isAr ? "تعديل الإعدادات" : "Edit Settings"}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleToggle} disabled={toggling} className="text-gray-600">
            {toggling ? <Loader2 size={13} className="animate-spin mr-1" /> : integration.isActive
              ? <WifiOff size={13} className="mr-1" />
              : <Wifi size={13} className="mr-1" />}
            {integration.isActive ? (isAr ? "تعطيل" : "Disable") : (isAr ? "تفعيل" : "Enable")}
          </Button>
          {!confirmDelete ? (
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} className="text-red-500 hover:text-red-700 hover:bg-red-50 ml-auto">
              <Trash2 size={13} className="mr-1" />
              {isAr ? "حذف" : "Delete"}
            </Button>
          ) : (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-red-600 font-medium">{isAr ? "هل أنت متأكد؟" : "Are you sure?"}</span>
              <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
                {deleting ? <Loader2 size={13} className="animate-spin mr-1" /> : null}
                {isAr ? "نعم، احذف" : "Yes, Delete"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                {isAr ? "لا" : "No"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ErpSystemCard (not connected yet) ───────────────────────────────────────

function ErpSystemCard({
  system,
  lang,
  onConnect,
}: {
  system: ErpSystem;
  lang: "en" | "ar";
  onConnect: () => void;
}) {
  const isAr = lang === "ar";
  return (
    <div
      className={`relative rounded-xl border-2 bg-gradient-to-br ${system.color} p-5 flex flex-col gap-3 cursor-pointer transition-all hover:shadow-md group`}
      onClick={onConnect}
    >
      <div className="flex items-start justify-between">
        <span className="text-3xl">{system.logo}</span>
        <span className="text-[11px] font-medium text-gray-400 bg-white/70 px-2 py-0.5 rounded-full border border-gray-200 group-hover:bg-white transition-colors">
          {isAr ? "غير متصل" : "Not connected"}
        </span>
      </div>
      <div>
        <h3 className="font-bold text-gray-900 text-base">{isAr ? system.nameAr : system.name}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{isAr ? system.descriptionAr : system.description}</p>
      </div>
      <Button size="sm" className="w-full mt-1 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); onConnect(); }}>
        <Plug size={14} className="mr-1.5" />
        {isAr ? "اتصال" : "Connect"}
      </Button>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function IntegrationsPage() {
  const { employee } = useAuth();
  const { lang } = useLanguage();
  const isAr = lang === "ar";
  const queryClient = useQueryClient();

  const [integrations, setIntegrations] = useState<ErpIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectingSystem, setConnectingSystem] = useState<ErpSystem | null>(null);
  const [editingIntegration, setEditingIntegration] = useState<{ system: ErpSystem; integration: ErpIntegration } | null>(null);

  // Fetch integrations
  async function fetchIntegrations() {
    setLoading(true);
    try {
      const data = await apiFetch("/integrations");
      setIntegrations(Array.isArray(data) ? data : []);
    } catch {
      setIntegrations([]);
    } finally {
      setLoading(false);
    }
  }

  // Initial load
  useState(() => { fetchIntegrations(); });

  // Access control
  const canManage = employee?.role === "admin" || employee?.role === "manager";
  if (!canManage) {
    return (
      <Layout>
        <div className="min-h-screen flex items-center justify-center text-gray-400 text-sm">
          {isAr ? "هذه الصفحة للمدراء فقط." : "This page is for admins and managers only."}
        </div>
      </Layout>
    );
  }

  // Which ERP types are already connected
  const connectedTypes = new Set(integrations.map((i) => i.type));

  // Match an integration to its ErpSystem definition
  function getSystem(type: ErpType) {
    return ERP_SYSTEMS.find((s) => s.type === type) ?? ERP_SYSTEMS[0];
  }

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto space-y-8">

        {/* Page header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {isAr ? "تكاملات ERP" : "ERP Integrations"}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {isAr
              ? "اربط نظام Cortoba مع أنظمة ERP الخاصة بك لاستيراد الموردين ومزامنة البيانات تلقائياً."
              : "Connect Cortoba with your ERP systems to automatically import suppliers and sync data."}
          </p>
        </div>

        {/* Connected integrations */}
        {integrations.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
              {isAr ? "التكاملات المتصلة" : "Connected Integrations"}
            </h2>
            <div className="space-y-3">
              {integrations.map((integration) => {
                const system = getSystem(integration.type);
                return (
                  <ConnectedCard
                    key={integration.id}
                    integration={integration}
                    system={system}
                    lang={lang}
                    onEdit={() => setEditingIntegration({ system, integration })}
                    onRefetch={fetchIntegrations}
                  />
                );
              })}
            </div>
          </section>
        )}

        {/* Available systems to connect */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
            {integrations.length === 0
              ? (isAr ? "اختر نظام ERP للاتصال" : "Choose an ERP System to Connect")
              : (isAr ? "إضافة تكامل جديد" : "Add Another Integration")}
          </h2>

          {loading ? (
            <div className="flex items-center justify-center py-12 text-gray-400">
              <Loader2 size={24} className="animate-spin mr-2" />
              <span className="text-sm">{isAr ? "جاري التحميل..." : "Loading..."}</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {ERP_SYSTEMS.map((system) => {
                // If already connected, allow adding another instance
                return (
                  <ErpSystemCard
                    key={system.type}
                    system={system}
                    lang={lang}
                    onConnect={() => setConnectingSystem(system)}
                  />
                );
              })}
            </div>
          )}
        </section>

        {/* Info note */}
        <div className="flex items-start gap-2 text-xs text-gray-400 bg-gray-50 rounded-lg p-4 border border-gray-100">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0 text-gray-300" />
          <p>
            {isAr
              ? "بيانات الاتصال مشفّرة ومحفوظة بأمان. كلمات المرور ومفاتيح الـ API لا تظهر بعد الحفظ."
              : "Connection credentials are encrypted and stored securely. Passwords and API keys are masked after saving."}
          </p>
        </div>
      </div>

      {/* Connect dialog */}
      {connectingSystem && (
        <ConnectDialog
          system={connectingSystem}
          lang={lang}
          onClose={() => setConnectingSystem(null)}
          onSaved={fetchIntegrations}
        />
      )}

      {/* Edit dialog */}
      {editingIntegration && (
        <ConnectDialog
          system={editingIntegration.system}
          existing={editingIntegration.integration}
          lang={lang}
          onClose={() => setEditingIntegration(null)}
          onSaved={fetchIntegrations}
        />
      )}
    </Layout>
  );
}

/**
 * ERP Integrations Page — /integrations
 * يعرض بطاقات أنظمة ERP؛ زر "اتصال" يفتح Popup بشاشة تسجيل دخول مخصصة
 */

import { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
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
  ExternalLink,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type ErpType = "odoo" | "sap-b1" | "sap-s4hana" | "oracle" | "google-sheets";

interface ErpSystem {
  type: ErpType;
  nameEn: string;
  nameAr: string;
  descEn: string;
  descAr: string;
  logo: string;
  bgClass: string;
  badgeClass: string;
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

// ─── ERP System catalog ───────────────────────────────────────────────────────

const ERP_SYSTEMS: ErpSystem[] = [
  {
    type: "odoo",
    nameEn: "Odoo", nameAr: "أودو",
    descEn: "Open-source ERP — suppliers, POs, inventory",
    descAr: "نظام ERP مفتوح المصدر — موردون وأوامر شراء ومخزون",
    logo: "🟣",
    bgClass: "from-purple-50 to-purple-100 border-purple-200 hover:border-purple-400",
    badgeClass: "bg-purple-100 text-purple-700",
  },
  {
    type: "sap-b1",
    nameEn: "SAP Business One", nameAr: "SAP Business One",
    descEn: "SAP B1 via Service Layer REST",
    descAr: "SAP Business One عبر Service Layer",
    logo: "🔵",
    bgClass: "from-blue-50 to-blue-100 border-blue-200 hover:border-blue-400",
    badgeClass: "bg-blue-100 text-blue-700",
  },
  {
    type: "sap-s4hana",
    nameEn: "SAP S/4HANA", nameAr: "SAP S/4HANA",
    descEn: "SAP S/4HANA Cloud via OData v4",
    descAr: "SAP S/4HANA Cloud عبر OData v4",
    logo: "🔷",
    bgClass: "from-cyan-50 to-cyan-100 border-cyan-200 hover:border-cyan-400",
    badgeClass: "bg-cyan-100 text-cyan-700",
  },
  {
    type: "oracle",
    nameEn: "Oracle ERP Cloud", nameAr: "Oracle ERP Cloud",
    descEn: "Oracle Procurement REST APIs",
    descAr: "Oracle Procurement REST APIs",
    logo: "🔴",
    bgClass: "from-red-50 to-red-100 border-red-200 hover:border-red-400",
    badgeClass: "bg-red-100 text-red-700",
  },
  {
    type: "google-sheets",
    nameEn: "Google Sheets", nameAr: "جداول بيانات Google",
    descEn: "Sync suppliers, RFQs & POs with a spreadsheet",
    descAr: "مزامنة الموردين والطلبات مع جداول بيانات Google",
    logo: "🟢",
    bgClass: "from-green-50 to-green-100 border-green-200 hover:border-green-400",
    badgeClass: "bg-green-100 text-green-700",
  },
];

// ─── API helper ───────────────────────────────────────────────────────────────

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

// ─── Popup launcher ───────────────────────────────────────────────────────────

function openConnectPopup(type: ErpType, onConnected: () => void) {
  // حساب الموضع بمنتصف الشاشة
  const w = 480, h = 640;
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
  const top  = Math.round(window.screenY + (window.outerHeight - h) / 2);

  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const popup = window.open(
    `${base}/integrations/connect?type=${type}`,
    `erp-connect-${type}`,
    `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes,toolbar=no,menubar=no,status=no`
  );

  if (!popup) {
    toast.error("لم يتمكن المتصفح من فتح نافذة جديدة — يرجى السماح بالـ Pop-ups لهذا الموقع");
    return;
  }

  // استقبال رسالة النجاح من الـ popup
  function handleMessage(e: MessageEvent) {
    if (e.data?.type === "ERP_CONNECTED") {
      window.removeEventListener("message", handleMessage);
      onConnected();
      toast.success("✓ تم الاتصال بنجاح!");
    }
  }
  window.addEventListener("message", handleMessage);

  // تنظيف إذا أُغلق الـ popup يدوياً
  const timer = setInterval(() => {
    if (popup.closed) {
      clearInterval(timer);
      window.removeEventListener("message", handleMessage);
    }
  }, 800);
}

// ─── ConnectedCard ────────────────────────────────────────────────────────────

function ConnectedCard({
  integration, system, isAr, onEdit, onRefetch,
}: {
  integration: ErpIntegration;
  system: ErpSystem;
  isAr: boolean;
  onEdit: () => void;
  onRefetch: () => void;
}) {
  const [syncing, setSyncing] = useState<"" | "import" | "export" | "full">("");
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toggling, setToggling] = useState(false);

  async function handleSync(action: "import" | "export" | "full") {
    setSyncing(action);
    try {
      const path = action === "import" ? "sync-suppliers" : action === "export" ? "export" : "sync";
      const res = await apiFetch(`/integrations/${integration.id}/${path}`, { method: "POST" });
      if (action === "full") {
        toast.info(isAr ? "بدأت المزامنة في الخلفية" : "Sync started in background");
      } else {
        const stats = Object.entries(res ?? {})
          .filter(([k]) => k !== "success" && k !== "message")
          .map(([k, v]) => `${k}: ${v}`).join(" · ");
        toast.success((isAr ? "✓ تمت العملية" : "✓ Done") + (stats ? ` — ${stats}` : ""));
      }
      onRefetch();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSyncing(""); }
  }

  async function handleToggle() {
    setToggling(true);
    try {
      await apiFetch(`/integrations/${integration.id}`, {
        method: "PATCH", body: JSON.stringify({ isActive: !integration.isActive }),
      });
      onRefetch();
    } catch (e) { toast.error((e as Error).message); }
    finally { setToggling(false); }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiFetch(`/integrations/${integration.id}`, { method: "DELETE" });
      toast.success(isAr ? "تم حذف التكامل" : "Integration deleted");
      onRefetch();
    } catch (e) { toast.error((e as Error).message); }
    finally { setDeleting(false); setConfirmDelete(false); }
  }

  const statusColor = integration.lastSyncStatus === "success" ? "text-green-600"
    : integration.lastSyncStatus === "error" ? "text-red-500" : "text-gray-400";

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
                {isAr ? system.nameAr : system.nameEn}
                {integration.lastSyncAt && (
                  <span className={`ml-2 ${statusColor}`}>
                    · {isAr ? "آخر مزامنة:" : "Last sync:"} {new Date(integration.lastSyncAt).toLocaleDateString("ar-SA")}
                    {integration.lastSyncStatus && ` (${integration.lastSyncStatus})`}
                  </span>
                )}
              </p>
            </div>
          </div>
          <button onClick={() => setExpanded((e) => !e)} className="text-gray-400 hover:text-gray-600 p-1">
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>

        {integration.lastSyncStatus === "error" && integration.lastSyncError && (
          <div className="mt-3 flex items-start gap-1.5 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 border border-red-100">
            <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
            <span>{integration.lastSyncError}</span>
          </div>
        )}

        {/* Stats */}
        {integration.lastSyncStats && Object.keys(integration.lastSyncStats).length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {Object.entries(integration.lastSyncStats).map(([k, v]) => (
              <span key={k} className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-full">{k}: {v}</span>
            ))}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2 mt-3">
          <Button size="sm" variant="outline" onClick={() => handleSync("import")} disabled={!!syncing || !integration.isActive}>
            {syncing === "import" ? <Loader2 size={13} className="animate-spin mr-1" /> : <ArrowDownToLine size={13} className="mr-1" />}
            {isAr ? "استيراد موردين" : "Import Suppliers"}
          </Button>
          {integration.type === "google-sheets" && (
            <Button size="sm" variant="outline" onClick={() => handleSync("export")} disabled={!!syncing || !integration.isActive}>
              {syncing === "export" ? <Loader2 size={13} className="animate-spin mr-1" /> : <ArrowUpFromLine size={13} className="mr-1" />}
              {isAr ? "تصدير البيانات" : "Export Data"}
            </Button>
          )}
          <Button size="sm" onClick={() => handleSync("full")} disabled={!!syncing || !integration.isActive}>
            {syncing === "full" ? <Loader2 size={13} className="animate-spin mr-1" /> : <RefreshCw size={13} className="mr-1" />}
            {isAr ? "مزامنة كاملة" : "Full Sync"}
          </Button>
        </div>
      </div>

      {/* Expanded settings */}
      {expanded && (
        <div className="border-t px-4 py-3 flex flex-wrap items-center gap-2 bg-gray-50 rounded-b-xl">
          <Button size="sm" variant="ghost" onClick={onEdit} className="text-gray-600">
            <Settings2 size={13} className="mr-1" />
            {isAr ? "تعديل الاتصال" : "Edit Connection"}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleToggle} disabled={toggling} className="text-gray-600">
            {toggling ? <Loader2 size={13} className="animate-spin mr-1" /> : integration.isActive
              ? <WifiOff size={13} className="mr-1" /> : <Wifi size={13} className="mr-1" />}
            {integration.isActive ? (isAr ? "تعطيل" : "Disable") : (isAr ? "تفعيل" : "Enable")}
          </Button>
          {!confirmDelete ? (
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}
              className="text-red-500 hover:text-red-700 hover:bg-red-50 ml-auto">
              <Trash2 size={13} className="mr-1" />
              {isAr ? "حذف" : "Delete"}
            </Button>
          ) : (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-red-600 font-medium">{isAr ? "هل أنت متأكد؟" : "Sure?"}</span>
              <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
                {deleting && <Loader2 size={13} className="animate-spin mr-1" />}
                {isAr ? "نعم، احذف" : "Delete"}
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

// ─── ErpSystemCard ────────────────────────────────────────────────────────────

function ErpSystemCard({
  system, isAr, onConnect, alreadyConnected,
}: {
  system: ErpSystem;
  isAr: boolean;
  onConnect: () => void;
  alreadyConnected: boolean;
}) {
  return (
    <div
      className={`relative rounded-xl border-2 bg-gradient-to-br ${system.bgClass} p-5 flex flex-col gap-3 transition-all hover:shadow-md cursor-pointer group`}
      onClick={onConnect}
    >
      {alreadyConnected && (
        <div className="absolute top-3 left-3">
          <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-green-100 text-green-700 px-2 py-0.5 rounded-full border border-green-200">
            <CheckCircle2 size={9} />
            {isAr ? "متصل" : "Connected"}
          </span>
        </div>
      )}
      <div className="flex items-start justify-between">
        <span className="text-3xl">{system.logo}</span>
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border border-current/20 ${system.badgeClass}`}>
          {isAr ? system.nameAr : system.nameEn}
        </span>
      </div>
      <div>
        <h3 className="font-bold text-gray-900 text-base">{isAr ? system.nameAr : system.nameEn}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{isAr ? system.descAr : system.descEn}</p>
      </div>
      <Button
        size="sm"
        className="w-full mt-1"
        onClick={(e) => { e.stopPropagation(); onConnect(); }}
      >
        <ExternalLink size={13} className="mr-1.5" />
        {alreadyConnected
          ? (isAr ? "إضافة اتصال آخر" : "Add Another")
          : (isAr ? "اتصال" : "Connect")}
      </Button>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function IntegrationsPage() {
  const { employee } = useAuth();
  const { lang } = useLanguage();
  const isAr = lang === "ar";

  const [integrations, setIntegrations] = useState<ErpIntegration[]>([]);
  const [loading, setLoading]   = useState(true);

  const fetchIntegrations = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/integrations");
      setIntegrations(Array.isArray(data) ? data : []);
    } catch { setIntegrations([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchIntegrations(); }, [fetchIntegrations]);

  const canManage = employee?.role === "admin" || employee?.role === "manager";
  if (!canManage) {
    return (
      <Layout>
        <div className="min-h-[60vh] flex items-center justify-center text-gray-400 text-sm">
          {isAr ? "هذه الصفحة للمدراء والمدير العام فقط." : "Admins and managers only."}
        </div>
      </Layout>
    );
  }

  const connectedTypes = new Set(integrations.map((i) => i.type));

  function getSystem(type: ErpType) {
    return ERP_SYSTEMS.find((s) => s.type === type) ?? ERP_SYSTEMS[0];
  }

  function handleConnect(type: ErpType) {
    openConnectPopup(type, fetchIntegrations);
  }

  function handleEdit(integration: ErpIntegration) {
    openConnectPopup(integration.type, fetchIntegrations);
  }

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto space-y-8" dir="rtl">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {isAr ? "تكاملات ERP" : "ERP Integrations"}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {isAr
              ? "اربط Cortoba بأنظمة ERP الخاصة بك لاستيراد الموردين ومزامنة البيانات تلقائياً."
              : "Connect Cortoba with your ERP systems to auto-import suppliers and sync data."}
          </p>
        </div>

        {/* Connected integrations */}
        {integrations.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              {isAr ? "الأنظمة المتصلة" : "Connected Systems"} ({integrations.length})
            </h2>
            <div className="space-y-3">
              {integrations.map((int) => (
                <ConnectedCard
                  key={int.id}
                  integration={int}
                  system={getSystem(int.type)}
                  isAr={isAr}
                  onEdit={() => handleEdit(int)}
                  onRefetch={fetchIntegrations}
                />
              ))}
            </div>
          </section>
        )}

        {/* Available systems */}
        <section>
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            {integrations.length === 0
              ? (isAr ? "اختر نظام ERP للاتصال" : "Choose a System to Connect")
              : (isAr ? "أضف تكاملاً جديداً" : "Add Another Integration")}
          </h2>

          {loading ? (
            <div className="flex items-center justify-center py-16 text-gray-300">
              <Loader2 size={28} className="animate-spin" />
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {ERP_SYSTEMS.map((system) => (
                <ErpSystemCard
                  key={system.type}
                  system={system}
                  isAr={isAr}
                  alreadyConnected={connectedTypes.has(system.type)}
                  onConnect={() => handleConnect(system.type)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Security note */}
        <div className="flex items-start gap-2 text-xs text-gray-400 bg-gray-50 rounded-lg p-4 border border-gray-100">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0 text-gray-300" />
          <p>
            {isAr
              ? "بيانات الاتصال مشفّرة ومحفوظة بأمان. لن تُعرض كلمات المرور أو مفاتيح الـ API مجدداً بعد الحفظ."
              : "Credentials are encrypted at rest. Passwords and API keys are masked after saving."}
          </p>
        </div>
      </div>
    </Layout>
  );
}

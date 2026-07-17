/**
 * ERP Connect Popup Page — /integrations/connect?type=odoo&name=...
 *
 * صفحة مستقلة (بدون Sidebar) تُفتح كـ Popup.
 * تُظهر شاشة تسجيل دخول مُصمَّمة على هوية كل نظام ERP.
 * عند النجاح: ترسل postMessage للنافذة الأم ثم تُغلق نفسها.
 */

import { useState, useEffect, FormEvent, type ReactElement } from "react";
import { Loader2, CheckCircle2, ShieldCheck, Lock, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ─── Types ───────────────────────────────────────────────────────────────────

type ErpType = "odoo" | "sap-b1" | "sap-s4hana" | "oracle" | "google-sheets";
type Step = "login" | "authorizing" | "permission" | "success" | "error";

interface ErpBrand {
  name: string;
  logo: ReactElement;
  headerBg: string;
  headerText: string;
  accentColor: string;
  buttonClass: string;
  description: string;
}

// ─── ERP Branding ────────────────────────────────────────────────────────────

function OdooLogo() {
  return (
    <svg viewBox="0 0 60 60" className="w-10 h-10" fill="none">
      <circle cx="30" cy="30" r="30" fill="#714B67" />
      <circle cx="30" cy="30" r="14" fill="white" />
      <circle cx="30" cy="30" r="6" fill="#714B67" />
    </svg>
  );
}
function SapLogo() {
  return (
    <svg viewBox="0 0 80 30" className="h-8 w-auto" fill="none">
      <rect width="80" height="30" rx="4" fill="#0070F2" />
      <text x="8" y="22" fontSize="18" fontWeight="bold" fill="white" fontFamily="Arial">
        SAP
      </text>
    </svg>
  );
}
function OracleLogo() {
  return (
    <svg viewBox="0 0 90 30" className="h-8 w-auto" fill="none">
      <rect width="90" height="30" rx="4" fill="#C74634" />
      <text x="6" y="22" fontSize="14" fontWeight="bold" fill="white" fontFamily="Arial">
        ORACLE
      </text>
    </svg>
  );
}
function GoogleSheetsLogo() {
  return (
    <svg viewBox="0 0 40 48" className="w-10 h-12" fill="none">
      <path
        d="M24 0H6C2.7 0 0 2.7 0 6v36c0 3.3 2.7 6 6 6h28c3.3 0 6-2.7 6-6V16L24 0z"
        fill="#0F9D58"
      />
      <path d="M24 0v16h16L24 0z" fill="#057642" />
      <rect x="8" y="22" width="24" height="3" rx="1" fill="white" />
      <rect x="8" y="28" width="24" height="3" rx="1" fill="white" />
      <rect x="8" y="34" width="16" height="3" rx="1" fill="white" />
    </svg>
  );
}

const ERP_BRANDS: Record<ErpType, ErpBrand> = {
  odoo: {
    name: "Odoo",
    logo: <OdooLogo />,
    headerBg: "bg-[#714B67]",
    headerText: "text-white",
    accentColor: "#714B67",
    buttonClass: "bg-[#714B67] hover:bg-[#5c3a55] text-white",
    description: "تسجيل الدخول إلى حسابك على Odoo",
  },
  "sap-b1": {
    name: "SAP Business One",
    logo: <SapLogo />,
    headerBg: "bg-[#0070F2]",
    headerText: "text-white",
    accentColor: "#0070F2",
    buttonClass: "bg-[#0070F2] hover:bg-[#005ccc] text-white",
    description: "تسجيل الدخول إلى SAP Business One",
  },
  "sap-s4hana": {
    name: "SAP S/4HANA",
    logo: <SapLogo />,
    headerBg: "bg-[#0070F2]",
    headerText: "text-white",
    accentColor: "#0070F2",
    buttonClass: "bg-[#0070F2] hover:bg-[#005ccc] text-white",
    description: "تسجيل الدخول إلى SAP S/4HANA",
  },
  oracle: {
    name: "Oracle ERP Cloud",
    logo: <OracleLogo />,
    headerBg: "bg-[#C74634]",
    headerText: "text-white",
    accentColor: "#C74634",
    buttonClass: "bg-[#C74634] hover:bg-[#a83829] text-white",
    description: "تسجيل الدخول إلى Oracle ERP Cloud",
  },
  "google-sheets": {
    name: "Google Sheets",
    logo: <GoogleSheetsLogo />,
    headerBg: "bg-white",
    headerText: "text-gray-800",
    accentColor: "#1a73e8",
    buttonClass: "bg-[#1a73e8] hover:bg-[#1557b0] text-white",
    description: "تسجيل الدخول إلى Google لربط جداول البيانات",
  },
};

// ─── Field configs per ERP ────────────────────────────────────────────────────

interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  type: "text" | "password" | "url" | "email";
  hint?: string;
  required: boolean;
}

const ERP_FIELDS: Record<ErpType, FieldDef[]> = {
  odoo: [
    {
      key: "url",
      label: "رابط خادم Odoo",
      placeholder: "https://mycompany.odoo.com",
      type: "url",
      required: true,
    },
    { key: "db", label: "قاعدة البيانات", placeholder: "mycompany", type: "text", required: true },
    {
      key: "username",
      label: "البريد الإلكتروني",
      placeholder: "admin@company.com",
      type: "email",
      required: true,
    },
    {
      key: "apiKey",
      label: "مفتاح API",
      placeholder: "من الإعدادات ← مفاتيح API",
      type: "password",
      required: true,
      hint: "الإعدادات → المستخدمون → اسمك → مفاتيح API",
    },
  ],
  "sap-b1": [
    {
      key: "url",
      label: "رابط الخادم",
      placeholder: "https://sap-server:50000",
      type: "url",
      required: true,
    },
    {
      key: "companyDB",
      label: "قاعدة بيانات الشركة",
      placeholder: "MYCOMPANY",
      type: "text",
      required: true,
    },
    {
      key: "username",
      label: "اسم المستخدم",
      placeholder: "manager",
      type: "text",
      required: true,
    },
    {
      key: "password",
      label: "كلمة المرور",
      placeholder: "••••••••",
      type: "password",
      required: true,
    },
  ],
  "sap-s4hana": [
    {
      key: "url",
      label: "رابط النظام",
      placeholder: "https://myXXXXXX.s4hana.ondemand.com",
      type: "url",
      required: true,
    },
    {
      key: "username",
      label: "اسم المستخدم",
      placeholder: "S4H_USER",
      type: "text",
      required: true,
    },
    {
      key: "password",
      label: "كلمة المرور",
      placeholder: "••••••••",
      type: "password",
      required: true,
    },
  ],
  oracle: [
    {
      key: "url",
      label: "رابط خادم Oracle",
      placeholder: "https://xxx.fa.em2.oraclecloud.com",
      type: "url",
      required: true,
    },
    {
      key: "username",
      label: "اسم المستخدم",
      placeholder: "oracle_user",
      type: "text",
      required: true,
    },
    {
      key: "password",
      label: "كلمة المرور",
      placeholder: "••••••••",
      type: "password",
      required: true,
    },
    {
      key: "businessUnit",
      label: "وحدة الأعمال",
      placeholder: "US1 Business Unit (اختياري)",
      type: "text",
      required: false,
    },
  ],
  "google-sheets": [
    {
      key: "spreadsheetId",
      label: "معرّف جدول البيانات",
      placeholder: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
      type: "text",
      required: true,
      hint: "من رابط الـ Sheet: /spreadsheets/d/{ID}/",
    },
    {
      key: "dataSheetName",
      label: "اسم تاب الموردين",
      placeholder: "Suppliers (اختياري)",
      type: "text",
      required: false,
    },
  ],
};

// ─── API helper ───────────────────────────────────────────────────────────────

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `خطأ ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ConnectPopupPage() {
  const params = new URLSearchParams(window.location.search);
  const type = (params.get("type") ?? "odoo") as ErpType;
  const initialName = params.get("name") ?? "";

  const brand = ERP_BRANDS[type] ?? ERP_BRANDS["odoo"];
  const fields = ERP_FIELDS[type] ?? [];

  const [step, setStep] = useState<Step>("login");
  const [connectionName, setConnectionName] = useState(initialName || brand.name);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; version?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [createdId, setCreatedId] = useState<number | null>(null);

  // ── Step 1: Test credentials ─────────────────────────────────────────────

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setStep("authorizing");

    const config: Record<string, string> = {};
    fields.forEach((f) => {
      if (values[f.key]?.trim()) config[f.key] = values[f.key].trim();
    });

    try {
      // إنشاء التكامل أولاً
      const created = await apiFetch("/integrations", {
        method: "POST",
        body: JSON.stringify({ name: connectionName || brand.name, type, config }),
      });
      setCreatedId(created.id);

      // اختبار الاتصال
      const result = await apiFetch(`/integrations/${created.id}/test`, { method: "POST" });
      setTestResult(result);

      if (result.ok) {
        // الانتقال لشاشة الإذن
        setTimeout(() => setStep("permission"), 800);
      } else {
        // حذف التكامل المؤقت عند الفشل
        await apiFetch(`/integrations/${created.id}`, { method: "DELETE" }).catch(() => {});
        setCreatedId(null);
        setError(result.error ?? "فشل الاتصال");
        setStep("login");
      }
    } catch (err) {
      if (createdId) {
        await apiFetch(`/integrations/${createdId}`, { method: "DELETE" }).catch(() => {});
        setCreatedId(null);
      }
      setError((err as Error).message);
      setStep("login");
    }
  }

  // ── Step 2: User clicks Allow ─────────────────────────────────────────────

  async function handleAllow() {
    if (!createdId) return;
    setSaving(true);
    try {
      // التكامل محفوظ بالفعل — فقط تأكيد التفعيل
      await apiFetch(`/integrations/${createdId}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: true }),
      });
      setStep("success");
      // إبلاغ النافذة الأم بالنجاح
      if (window.opener) {
        window.opener.postMessage(
          { type: "ERP_CONNECTED", integrationId: createdId, erpType: type },
          "*",
        );
      }
      // إغلاق الـ popup بعد لحظة
      setTimeout(() => window.close(), 2200);
    } catch (err) {
      setError((err as Error).message);
      setStep("login");
    } finally {
      setSaving(false);
    }
  }

  // ── Step 2: User clicks Deny ──────────────────────────────────────────────

  async function handleDeny() {
    if (createdId) {
      await apiFetch(`/integrations/${createdId}`, { method: "DELETE" }).catch(() => {});
    }
    window.close();
  }

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col" dir="rtl">
      {/* ── Header بهوية الـ ERP ──────────────────────────────────────────── */}
      <div className={`${brand.headerBg} px-6 py-4 flex items-center gap-3 shadow-sm`}>
        {brand.logo}
        <div>
          <p className={`font-semibold text-sm ${brand.headerText}`}>{brand.name}</p>
          <p className={`text-xs opacity-70 ${brand.headerText}`}>
            {type === "google-sheets" ? "Google Sheets" : "ERP System"}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Lock size={12} className={`opacity-60 ${brand.headerText}`} />
          <span className={`text-xs opacity-60 ${brand.headerText}`}>اتصال آمن</span>
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col items-center justify-center px-5 py-8">
        {/* STEP: login ───────────────────────────────────────────────────── */}
        {step === "login" && (
          <form onSubmit={handleLogin} className="w-full max-w-sm space-y-5">
            <div className="text-center space-y-1">
              <h1 className="text-xl font-bold text-gray-900">{brand.description}</h1>
              <p className="text-sm text-gray-400">
                {brand.name} سيطلب منك الإذن للاتصال بـ Cortoba
              </p>
            </div>

            {/* Connection name */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium text-gray-700">اسم الاتصال</Label>
              <Input
                value={connectionName}
                onChange={(e) => setConnectionName(e.target.value)}
                placeholder={`مثال: ${brand.name} — الإنتاج`}
              />
            </div>

            {/* ERP login fields */}
            {fields.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label className="text-sm font-medium text-gray-700">
                  {f.label}
                  {f.required && <span className="text-red-500 mr-0.5">*</span>}
                </Label>
                <Input
                  type={f.type}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  autoComplete={f.type === "password" ? "current-password" : "off"}
                />
                {f.hint && <p className="text-xs text-gray-400">{f.hint}</p>}
              </div>
            ))}

            {/* Error */}
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
                {error}
              </div>
            )}

            <Button
              type="submit"
              className={`w-full h-11 font-semibold text-sm ${brand.buttonClass}`}
            >
              تسجيل الدخول
              <ArrowRight size={15} className="mr-2" />
            </Button>

            <p className="text-center text-xs text-gray-400 pt-1">
              بيانات الاتصال مشفّرة ومحفوظة بأمان على خادمك
            </p>
          </form>
        )}

        {/* STEP: authorizing ──────────────────────────────────────────────── */}
        {step === "authorizing" && (
          <div className="text-center space-y-4">
            <div className="relative">
              <div className="w-16 h-16 rounded-full border-4 border-gray-100 flex items-center justify-center mx-auto">
                {brand.logo}
              </div>
              <Loader2
                size={64}
                className="absolute inset-0 animate-spin text-gray-200 -m-0"
                style={{ color: brand.accentColor, opacity: 0.3 }}
              />
            </div>
            <p className="font-semibold text-gray-700">جاري التحقق من بيانات الدخول...</p>
            <p className="text-sm text-gray-400">يتم الاتصال بـ {brand.name}</p>
          </div>
        )}

        {/* STEP: permission ───────────────────────────────────────────────── */}
        {step === "permission" && (
          <div className="w-full max-w-sm space-y-5">
            {/* App info */}
            <div className="text-center space-y-2">
              <div className="flex items-center justify-center gap-3 mb-4">
                {/* Cortoba logo */}
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                  <span className="text-2xl font-black text-primary">C</span>
                </div>
                <div className="flex gap-1">
                  <span className="w-2 h-2 bg-gray-300 rounded-full" />
                  <span className="w-2 h-2 bg-gray-300 rounded-full" />
                  <span className="w-2 h-2 bg-gray-300 rounded-full" />
                </div>
                <div className="w-12 h-12 flex items-center justify-center">{brand.logo}</div>
              </div>
              <h2 className="text-lg font-bold text-gray-900">Cortoba يطلب الإذن</h2>
              <p className="text-sm text-gray-500">
                هل تسمح لـ <strong>Cortoba Supplies</strong> بالاتصال بحسابك على{" "}
                <strong>{brand.name}</strong>؟
              </p>
              {testResult?.version && (
                <div className="inline-flex items-center gap-1.5 text-xs text-green-700 bg-green-50 border border-green-200 px-3 py-1.5 rounded-full">
                  <CheckCircle2 size={12} />
                  {testResult.version}
                </div>
              )}
            </div>

            {/* Permissions list */}
            <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
              {[
                { icon: "📋", text: "قراءة بيانات الموردين" },
                { icon: "📦", text: "استيراد أوامر الشراء" },
                { icon: "🔄", text: "مزامنة البيانات تلقائياً" },
              ].map((p) => (
                <div
                  key={p.text}
                  className="flex items-center gap-3 px-4 py-3 text-sm text-gray-700"
                >
                  <span>{p.icon}</span>
                  <span>{p.text}</span>
                  <CheckCircle2 size={14} className="mr-auto text-green-500 flex-shrink-0" />
                </div>
              ))}
            </div>

            {/* Buttons */}
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1 h-11"
                onClick={handleDeny}
                disabled={saving}
              >
                رفض
              </Button>
              <Button
                className={`flex-1 h-11 font-semibold ${brand.buttonClass}`}
                onClick={handleAllow}
                disabled={saving}
              >
                {saving ? (
                  <>
                    <Loader2 size={14} className="animate-spin ml-2" />
                    جاري التفعيل...
                  </>
                ) : (
                  <>
                    <ShieldCheck size={15} className="ml-2" />
                    السماح بالاتصال
                  </>
                )}
              </Button>
            </div>

            <p className="text-center text-xs text-gray-400">
              يمكنك إلغاء هذا الإذن في أي وقت من صفحة التكاملات
            </p>
          </div>
        )}

        {/* STEP: success ──────────────────────────────────────────────────── */}
        {step === "success" && (
          <div className="text-center space-y-4">
            <div className="w-20 h-20 rounded-full bg-green-50 border-4 border-green-100 flex items-center justify-center mx-auto">
              <CheckCircle2 size={36} className="text-green-500" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">تم الاتصال بنجاح! 🎉</h2>
              <p className="text-sm text-gray-500 mt-1">
                تم ربط <strong>{brand.name}</strong> بـ Cortoba بنجاح.
              </p>
              {testResult?.version && (
                <p className="text-xs text-gray-400 mt-0.5">{testResult.version}</p>
              )}
            </div>
            <p className="text-xs text-gray-400 animate-pulse">
              سيتم إغلاق هذه النافذة تلقائياً...
            </p>
          </div>
        )}

        {/* STEP: error (fallback) ─────────────────────────────────────────── */}
        {step === "error" && (
          <div className="text-center space-y-4">
            <p className="text-red-600 font-medium">{error}</p>
            <Button onClick={() => setStep("login")} variant="outline">
              حاول مجدداً
            </Button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="text-center py-3 text-xs text-gray-300 border-t border-gray-100">
        Cortoba Supplies · الاتصال مشفّر بالكامل
      </div>
    </div>
  );
}

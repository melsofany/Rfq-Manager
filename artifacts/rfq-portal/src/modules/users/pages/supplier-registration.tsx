import { useEffect, useMemo, useState } from "react";
import { useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Lock,
  ShieldAlert,
  Loader2,
  PhoneCall,
} from "lucide-react";

/**
 * استكمال بيانات المورد — the public page the one-time link opens.
 *
 * Three rules the operator fixed, and how the page enforces each:
 *
 *  1. The supplier sees what WE hold, read-only, and is asked only for what is
 *     missing. He confirms our record rather than guessing at it.
 *  2. He enters the data TWICE. A mismatch is refused, nothing is saved, and he
 *     is told (the server also sends the notice by WhatsApp and email). The
 *     second step is deliberately a full re-entry, not a "yes, correct" checkbox
 *     — the operator asked for a real confirmation.
 *  3. The link is single-use. After a successful confirmation the page shows a
 *     closed state and says any later change must go through the company. The
 *     token is dead server-side, so this is a fact, not a screen we chose to
 *     hide.
 *
 * A red notice states plainly that the accuracy of the data is the supplier's
 * own responsibility — he is the only one who can verify what his bank holds.
 */

const FIELD_LABELS: Record<string, string> = {
  commercialRegister: "رقم السجل التجاري",
  taxRegistration: "رقم التسجيل الضريبي",
  bankName: "اسم البنك",
  bankAccountHolder: "اسم صاحب الحساب كما هو مسجَّل لدى البنك",
  bankAccountNumber: "رقم الحساب البنكي",
  iban: "رقم IBAN",
  swiftCode: "السويف كود (SWIFT/BIC)",
  bankBranch: "اسم الفرع",
};

const FIELD_HINTS: Record<string, string> = {
  commercialRegister: "أرقام فقط",
  taxRegistration: "أرقام فقط",
  bankName: "كما هو مكتوب على الحساب",
  bankAccountHolder: "يجب أن يطابق الاسم المسجَّل لدى البنك تمامًا",
  bankAccountNumber: "6 إلى 30 رقمًا، بدون مسافات",
  iban: "يبدأ بـ EG ويتكون من 29 خانة",
  swiftCode: "8 أو 11 خانة، حروف وأرقام لاتينية",
  bankBranch: "اسم الفرع",
};

interface RegistrationInfo {
  status: "open" | "completed" | "expired" | "cancelled";
  supplierName: string;
  requestedFields: string[];
  expiresAt: string;
  attempts: number;
  canSubmit: boolean;
  labels?: Record<string, string>;
}

function labelOf(key: string, serverLabels?: Record<string, string>): string {
  return serverLabels?.[key] ?? FIELD_LABELS[key] ?? key;
}

export default function SupplierRegistrationPage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<RegistrationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Two-step form state. `step` is server-driven (a confirmed first entry moves
  // the supplier to the confirmation form).
  const [step, setStep] = useState<"enter" | "confirm" | "done">("enter");
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mismatchFields, setMismatchFields] = useState<string[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/supplier-registration/${encodeURIComponent(token ?? "")}`);
      const body = await res.json();
      if (!res.ok) {
        setLoadError(body?.error ?? "الرابط غير صحيح");
        setInfo(null);
      } else {
        setInfo(body as RegistrationInfo);
        setLoadError(null);
      }
    } catch {
      setLoadError("تعذّر الاتصال بالخادم. يرجى المحاولة مرة أخرى.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const required = info?.requestedFields ?? [];
  const expiresLabel = useMemo(() => {
    if (!info) return "";
    try {
      return new Date(info.expiresAt).toLocaleDateString("ar-EG");
    } catch {
      return info.expiresAt.slice(0, 10);
    }
  }, [info]);

  const setField = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const submitStep = async (endpoint: "submit" | "confirm") => {
    setSubmitting(true);
    setServerError(null);
    setFieldErrors({});
    try {
      const res = await fetch(
        `/api/supplier-registration/${encodeURIComponent(token ?? "")}/${endpoint}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: values }),
        },
      );
      const body = await res.json();
      if (res.ok) {
        if (endpoint === "submit") {
          setStep("confirm");
          // The confirmation must be typed afresh: clearing the form is what
          // makes the second entry an independent confirmation rather than a
          // copy of the first (a prefilled form would be confirmed unread).
          setValues({});
          setMismatchFields([]);
        } else {
          setStep("done");
        }
        return;
      }
      if (res.status === 409 && Array.isArray(body?.mismatchFields)) {
        setMismatchFields(body.mismatchFields as string[]);
        setServerError(body?.error ?? "البيانات غير مطابقة");
        // Back to step one: both entries are re-typed so a typo in EITHER is
        // corrected rather than carried forward.
        setValues({});
        setStep("enter");
        return;
      }
      if (body?.fieldErrors) setFieldErrors(body.fieldErrors as Record<string, string>);
      setServerError(body?.error ?? "تعذّر حفظ البيانات");
      if (body?.step === "submit") setStep("enter");
    } catch {
      setServerError("تعذّر الاتصال بالخادم. يرجى المحاولة مرة أخرى.");
    } finally {
      setSubmitting(false);
    }
  };

  const renderShell = (children: React.ReactNode) => (
    <div dir="rtl" className="min-h-screen bg-slate-100 py-8 px-3 sm:px-6">
      <div className="max-w-2xl mx-auto">
        <div className="bg-[#1e3a5f] rounded-t-xl px-6 py-5">
          <h1 className="text-white text-xl font-bold">Cortoba Supplies</h1>
          <p className="text-blue-200 text-sm mt-1">قرطبة للتوريدات — استكمال بيانات المورد</p>
        </div>
        <div className="bg-white rounded-b-xl shadow-sm p-6 space-y-5">{children}</div>
      </div>
    </div>
  );

  if (loading) {
    return renderShell(
      <div className="flex items-center justify-center gap-2 py-12 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">جارٍ التحميل...</span>
      </div>,
    );
  }

  if (loadError || !info) {
    return renderShell(
      <div className="text-center py-10 space-y-3">
        <AlertTriangle className="h-12 w-12 mx-auto text-red-500" />
        <p className="font-semibold text-slate-800">{loadError ?? "الرابط غير صحيح"}</p>
        <p className="text-sm text-slate-500">يرجى التواصل مع الشركة للحصول على رابط جديد.</p>
      </div>,
    );
  }

  // ── Terminal states: the link is dead. ──────────────────────────────────
  if (step === "done" || info.status === "completed") {
    return renderShell(
      <div className="text-center py-8 space-y-4">
        <CheckCircle2 className="h-14 w-14 mx-auto text-emerald-500" />
        <h2 className="text-lg font-bold text-slate-800">تم تسجيل بياناتك وتأكيدها بنجاح</h2>
        <p className="text-sm text-slate-600 leading-relaxed">
          تم حفظ البيانات وإبلاغ الشركة فورًا. هذا الرابط انتهى دوره ولا يمكن استخدامه مرة أخرى.
        </p>
        <div className="flex items-start gap-2 text-right bg-amber-50 border border-amber-200 rounded-lg p-3">
          <PhoneCall className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-800">
            لأي تعديل أو تصحيح لاحق يرجى التواصل مع الشركة مباشرة، حيث لا يمكن التعديل من هنا.
          </p>
        </div>
      </div>,
    );
  }

  if (info.status === "expired") {
    return renderShell(
      <div className="text-center py-10 space-y-3">
        <Clock className="h-12 w-12 mx-auto text-slate-400" />
        <p className="font-semibold text-slate-800">انتهت صلاحية هذا الرابط</p>
        <p className="text-sm text-slate-500">يرجى التواصل مع الشركة لإرسال رابط جديد.</p>
      </div>,
    );
  }

  if (info.status === "cancelled") {
    return renderShell(
      <div className="text-center py-10 space-y-3">
        <Lock className="h-12 w-12 mx-auto text-slate-400" />
        <p className="font-semibold text-slate-800">تم إلغاء هذا الرابط</p>
        <p className="text-sm text-slate-500">يرجى التواصل مع الشركة.</p>
      </div>,
    );
  }

  return renderShell(
    <>
      {/* The red responsibility notice the operator asked for. */}
      <div className="flex items-start gap-2 bg-red-50 border-2 border-red-300 rounded-lg p-4">
        <ShieldAlert className="h-6 w-6 text-red-600 shrink-0 mt-0.5" />
        <p className="text-sm text-red-700 font-semibold leading-relaxed">
          تنبيه: مسؤولية صحة ودقة البيانات المُدخلة تقع بالكامل على عاتق المورد. يرجى التأكد من
          مطابقة البيانات لسجلاتكم الرسمية لدى البنك قبل التأكيد.
        </p>
      </div>

      {/* ONLY the company name is shown — never the data we already hold. The
          supplier must not see (or confirm) our stored record; he supplies the
          values himself, and that is the whole point of the double entry. */}
      <div>
        <p className="text-sm text-slate-600">
          الشركة: <strong className="text-slate-900">{info.supplierName}</strong>
        </p>
        <p className="text-xs text-slate-500 mt-1">الرابط صالح حتى: {expiresLabel}</p>
      </div>

      {/* ── The form ────────────────────────────────────────────────────── */}
      <div className="border rounded-lg p-4 space-y-4">
        <div className="flex items-center gap-2">
          <span
            className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold ${
              step === "enter" ? "bg-[#1e3a5f] text-white" : "bg-emerald-500 text-white"
            }`}
          >
            1
          </span>
          <span className="text-sm font-semibold text-slate-700">إدخال البيانات</span>
          <span className="flex-1 border-t" />
          <span
            className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold ${
              step === "confirm" ? "bg-[#1e3a5f] text-white" : "bg-slate-200 text-slate-500"
            }`}
          >
            2
          </span>
          <span className="text-sm font-semibold text-slate-700">تأكيد البيانات</span>
        </div>

        {step === "confirm" && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
            تم استلام إدخالك الأول. يرجى إدخال <strong>نفس البيانات مرة أخرى</strong> للتأكيد. في
            حال عدم التطابق لن يتم تسجيل البيانات.
          </div>
        )}

        {mismatchFields.length > 0 && (
          <div className="bg-red-50 border-2 border-red-300 rounded-lg p-3 text-sm text-red-700">
            <p className="font-semibold">
              البيانات المدخلة في المرة الثانية غير مطابقة للمرة الأولى — لم يتم تسجيل أي بيانات.
            </p>
            <p className="mt-1">
              الحقول غير المطابقة: {mismatchFields.map((f) => labelOf(f, info.labels)).join("، ")}
            </p>
            <p className="mt-1 text-xs">
              تم إبلاغكم بذلك على الواتساب والبريد. يرجى إعادة الإدخال بعناية.
            </p>
          </div>
        )}

        {serverError && mismatchFields.length === 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {serverError}
          </div>
        )}

        <div className="grid sm:grid-cols-2 gap-3">
          {required.map((key) => (
            <div key={key} className="space-y-1">
              <Label className="text-sm">
                {labelOf(key, info.labels)} <span className="text-red-500">*</span>
              </Label>
              <Input
                value={values[key] ?? ""}
                onChange={(e) => setField(key, e.target.value)}
                dir={["iban", "bankAccountNumber", "swiftCode"].includes(key) ? "ltr" : "rtl"}
                placeholder={FIELD_HINTS[key] ?? ""}
                autoComplete="off"
              />
              {fieldErrors[key] ? (
                <p className="text-xs text-red-600">{fieldErrors[key]}</p>
              ) : (
                <p className="text-xs text-slate-400">{FIELD_HINTS[key] ?? ""}</p>
              )}
            </div>
          ))}
        </div>

        <Button
          className="w-full bg-[#1e3a5f] hover:bg-[#16304f]"
          disabled={submitting}
          onClick={() => void submitStep(step === "enter" ? "submit" : "confirm")}
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin ml-2" />
              جارٍ الحفظ...
            </>
          ) : step === "enter" ? (
            "التالي — تأكيد البيانات"
          ) : (
            "تأكيد البيانات النهائي"
          )}
        </Button>

        <p className="text-xs text-slate-400 text-center">
          بعد التأكيد النهائي لا يمكن التعديل من هذا الرابط.
        </p>
      </div>
    </>,
  );
}

import { useState, useEffect } from "react";
import { Layout } from "@/components/Layout";
import { useLanguage } from "@/contexts/LanguageContext";
import { Loader2, AlertCircle, ExternalLink } from "lucide-react";
import WhatsAppPage from "./index";

/**
 * Chatwoot Inbox — يدمج واجهة Chatwoot داخل التطبيق عند مسار /whatsapp.
 *
 * يقوم بطلب رابط SSO لمرة واحدة من الخادم، ثم يعرض واجهة Chatwoot بالكامل
 * داخل iframe يملأ المساحة المتاحة داخل قشرة التطبيق (Layout). المستخدم
 * يُسجَّل دخوله تلقائياً عبر SSO فلا حاجة لتسجيل دخول ثانٍ.
 *
 * Chatwoot صندوق وارد للوكلاء فقط: رسائل الواتساب تظل تمر عبر الـ webhook
 * الخاص بنا (وهو ما يشغّل إرسال طلبات التسعير وأوامر الشراء وبوت المندوبين
 * والمساعد الذكي)، ويتم نسخ المحادثات إلى Chatwoot للعرض والرد.
 *
 * لو Chatwoot غير مُعدّ (أو تعذّر الاتصال) نُعيد المستخدم تلقائياً إلى صفحة
 * الدردشة الأصلية — فلا يفقد أحد إمكانية مراسلة الموردين أبداً.
 */
export default function ChatwootInboxPage() {
  const { t } = useLanguage();
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [useLegacy, setUseLegacy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Check configuration first: an unconfigured deployment must render the
        // built-in chat immediately, not a flash of an error screen.
        const statusRes = await fetch("/api/chatwoot/status", { credentials: "include" });
        const status = statusRes.ok
          ? ((await statusRes.json()) as { configured?: boolean })
          : { configured: false };
        if (!status.configured) {
          if (!cancelled) setUseLegacy(true);
          return;
        }

        const res = await fetch("/api/chatwoot/sso", { credentials: "include" });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { url: string };
        if (!cancelled) {
          setIframeUrl(data.url);
          setError(null);
        }
      } catch (err) {
        // A console we cannot REACH must not take the page down with it.
        //
        // Configured-but-unreachable used to render an error screen, so an
        // outage at Chatwoot left the agent with a dead page — while the
        // built-in chat, which needs none of that, sat unused behind it. The
        // supplier messages live in OUR database either way, so the built-in
        // chat still works during a console outage; falling back is strictly
        // better than showing an error the agent cannot act on.
        //
        // The error is kept so the built-in view can explain what happened.
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "فشل الاتصال بـ Chatwoot");
          setUseLegacy(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Chatwoot unavailable (unconfigured OR unreachable) → the proven built-in
  // chat, so the agent always has somewhere to answer suppliers from.
  if (useLegacy) return <WhatsAppPage />;

  return (
    <Layout>
      <div className="flex flex-col h-[calc(100vh-57px)] bg-gray-50">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-gray-200">
          <h1 className="text-base font-semibold text-gray-800 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            {t("nav.whatsapp")}
          </h1>
          {iframeUrl && (
            <a
              href={iframeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
            >
              <ExternalLink size={13} />
              {t("whatsapp.openExternal") || "فتح في نافذة منفصلة"}
            </a>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 relative overflow-hidden">
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-500">
              <Loader2 className="animate-spin" size={28} />
              <p className="text-sm">جارٍ تحميل صندوق الدردشة…</p>
            </div>
          )}

          {error && !loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center">
                <AlertCircle className="text-amber-600" size={26} />
              </div>
              <p className="text-sm font-medium text-gray-700 max-w-md">{error}</p>
              <p className="text-xs text-gray-400 max-w-md leading-relaxed">
                تأكّد من أن خدمة Chatwoot تعمل ومن ضبط المتغيرات البيئية:
                <code className="mx-1 px-1.5 py-0.5 bg-gray-100 rounded text-[11px]">
                  CHATWOOT_URL
                </code>
                <code className="mx-1 px-1.5 py-0.5 bg-gray-100 rounded text-[11px]">
                  CHATWOOT_ACCOUNT_ID
                </code>
                <code className="mx-1 px-1.5 py-0.5 bg-gray-100 rounded text-[11px]">
                  CHATWOOT_PLATFORM_TOKEN
                </code>
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.location.reload()}
                  className="mt-2 px-4 py-1.5 text-xs bg-gray-800 text-white rounded-md hover:bg-gray-700"
                >
                  إعادة المحاولة
                </button>
                <button
                  onClick={() => setUseLegacy(true)}
                  className="mt-2 px-4 py-1.5 text-xs border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
                >
                  فتح صندوق الدردشة المدمج
                </button>
              </div>
            </div>
          )}

          {iframeUrl && !error && (
            <iframe
              src={iframeUrl}
              title="Chatwoot Inbox"
              className="absolute inset-0 w-full h-full border-0"
              allow="clipboard-read; clipboard-write"
            />
          )}
        </div>
      </div>
    </Layout>
  );
}

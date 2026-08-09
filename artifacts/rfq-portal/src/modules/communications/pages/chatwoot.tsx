import { useState, useEffect } from "react";
import { Layout } from "@/components/Layout";
import { useLanguage } from "@/contexts/LanguageContext";
import { Loader2, AlertCircle, ExternalLink } from "lucide-react";

/**
 * Chatwoot Inbox — يدمج واجهة Chatwoot داخل التطبيق عند مسار /whatsapp.
 *
 * يقوم بطلب رابط SSO لمرة واحدة من الخادم، ثم يعرض واجهة Chatwoot بالكامل
 * داخل iframe يملأ المساحة المتاحة داخل قشرة التطبيق (Layout). المستخدم
 * يُسجَّل دخوله تلقائياً عبر SSO فلا حاجة لتسجيل دخول ثانٍ.
 *
 * تظل بيانات الـ WhatsApp القديمة محفوظة في قاعدة البيانات (للقراءة فقط)
 * ولا تُحذف — هذا المكوّن فقط يغيّر الواجهة المعروضة للمستخدم.
 */
export default function ChatwootInboxPage() {
  const { t } = useLanguage();
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
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
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "فشل الاتصال بـ Chatwoot");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
              <button
                onClick={() => window.location.reload()}
                className="mt-2 px-4 py-1.5 text-xs bg-gray-800 text-white rounded-md hover:bg-gray-700"
              >
                إعادة المحاولة
              </button>
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

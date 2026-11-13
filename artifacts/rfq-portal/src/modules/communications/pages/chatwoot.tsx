import { useState, useEffect, useCallback } from "react";
import { Layout } from "@/components/Layout";
import { useLanguage } from "@/contexts/LanguageContext";
import { Loader2, AlertCircle, RefreshCw, ExternalLink } from "lucide-react";
import WhatsAppPage from "./index";

/**
 * Conversation console inside Cortoba, at /whatsapp.
 *
 * The console is rendered from `/whatsapp/console` on the GATEWAY'S OWN ORIGIN,
 * where a reverse proxy serves the private Chatwoot service. That is not a
 * preference: `onrender.com` is on the Public Suffix List, so the gateway and
 * the Chatwoot service are different SITES — a frame from the upstream address
 * would be third-party, its session cookie would be refused, and the agent
 * would be logged out inside the frame forever. Same-origin makes the frame
 * first-party, and lets the Chatwoot service stay private with no public
 * entry point at all.
 *
 * No direct link to the Chatwoot service is exposed and no login is ever shown:
 * the server mints a one-time SSO link that the frame consumes on load.
 *
 * Supplier messages still travel through our own Meta webhook (which drives RFQ
 * sending, PO dispatch, the representative bot and the AI assistant); Chatwoot
 * only mirrors the conversation for the agents who handle it.
 *
 * An unconfigured or unreachable console falls back to the built-in chat, so an
 * outage never leaves the agent with nowhere to answer suppliers.
 */

/** Where the server mounts the proxied console, e.g. `/whatsapp/console`. */
const CONSOLE_PREFIX = "/whatsapp/console";

export default function ChatwootInboxPage() {
  const { t } = useLanguage();
  const [consoleSrc, setConsoleSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [useLegacy, setUseLegacy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Configuration first: an unconfigured deployment renders the built-in
        // chat immediately, instead of a flash of an empty frame.
        const statusRes = await fetch("/api/chatwoot/status", { credentials: "include" });
        const status = statusRes.ok
          ? ((await statusRes.json()) as { configured?: boolean })
          : { configured: false };
        if (!status.configured) {
          if (!cancelled) setUseLegacy(true);
          return;
        }

        // Reuse an existing console session before minting a new one.
        //
        // Every SSO mint creates a Chatwoot session and Chatwoot caps them, so
        // minting on every page load reached the cap and the console answered
        // "Active session limit reached" instead of loading — 25 sessions deep,
        // all of them this same employee's own browser.
        //
        // The check must be a SERVER check, not a cookie-presence check. A
        // cookie outlives its session: after "End all sessions", or once DTA
        // evicts the oldest token at `max_number_of_devices`, the cookie is
        // still in the browser but its token is dead. Trusting presence alone
        // would frame a console that can never sign in — a dead end with no
        // way out, because no SSO link would be minted to fix it.
        if (await hasLiveConsoleSession()) {
          setConsoleSrc(`${CONSOLE_PREFIX}/`);
          setError(null);
          return;
        }

        const res = await fetch("/api/chatwoot/sso", { credentials: "include" });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { url: string };
        if (cancelled) return;
        setConsoleSrc(sameOriginConsolePath(data.url));
        setError(null);
      } catch (err) {
        // A console we cannot REACH must not take the page down with it. The
        // supplier messages live in OUR database either way, so the built-in
        // chat still works during a console outage.
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "فشل الاتصال بصندوق المحادثات");
          setUseLegacy(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const retry = useCallback(() => {
    setError(null);
    setLoading(true);
    setUseLegacy(false);
    setConsoleSrc(null);
    setReloadKey((k) => k + 1);
  }, []);

  /**
   * Open the console in its own window, for an agent who wants the full screen.
   *
   * A FRESH SSO link is minted rather than reusing the frame's `src`: the token
   * is consumed the moment the frame loads it (measured against the live
   * console — a second sign-in with the same token answers 401), so handing the
   * frame's href to `window.open` opens a console that never signs in. The link
   * is re-pointed at our own origin for the same reason the frame is.
   */
  const openExternal = useCallback(async () => {
    try {
      const res = await fetch("/api/chatwoot/sso", { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { url: string };
      window.open(sameOriginConsolePath(data.url), "_blank");
    } catch {
      // Nothing to recover: the frame is still there, and this is a convenience
      // control. Failing silently beats an error dialog over a working console.
    }
  }, []);

  // Console unavailable (unconfigured OR unreachable) → the proven built-in
  // chat, so the agent always has somewhere to answer suppliers from.
  if (useLegacy) return <WhatsAppPage />;

  return (
    <Layout>
      <div className="flex flex-col h-[calc(100vh-57px)] bg-gray-50">
        <div className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-gray-200">
          <h1 className="text-base font-semibold text-gray-800 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            {t("nav.whatsapp")}
          </h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openExternal}
              disabled={loading}
              className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50 flex items-center gap-1"
              title="فتح صندوق المحادثات في نافذة مستقلة"
            >
              <ExternalLink size={13} />
              نافذة مستقلة
            </button>
            <button
              type="button"
              onClick={retry}
              disabled={loading}
              className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50 flex items-center gap-1"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              تحديث
            </button>
          </div>
        </div>

        <div className="flex-1 relative overflow-hidden">
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-500">
              <Loader2 className="animate-spin" size={28} />
              <p className="text-sm">جارٍ تحميل صندوق المحادثات…</p>
            </div>
          )}

          {error && !loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center">
                <AlertCircle className="text-amber-600" size={26} />
              </div>
              <p className="text-sm font-medium text-gray-700 max-w-md">{error}</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={retry}
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

          {consoleSrc && !error && (
            <iframe
              key={consoleSrc}
              src={consoleSrc}
              title="Conversations"
              className="absolute inset-0 w-full h-full border-0"
              allow="clipboard-read; clipboard-write"
            />
          )}
        </div>
      </div>
    </Layout>
  );
}

/**
 * Read the console's own credentials from the `cw_d_session_info` cookie.
 *
 * Chatwoot's dashboard stores its devise-token-auth credentials there (written
 * by JS in `setAuthCredentials`, so it is deliberately NOT HttpOnly) and
 * replays them as `access-token`/`client`/`uid` headers. js-cookie's bundled
 * default is `path: "/"` (measured in the shipped bundle), so the cookie is
 * visible to this page without any proxy intervention.
 *
 * Returns null unless the cookie parses AND carries all three headers — a
 * partial value cannot authenticate anything.
 */
function readConsoleCredentials(): Record<string, string> | null {
  try {
    const raw = document.cookie
      .split("; ")
      .find((c) => c.startsWith("cw_d_session_info="))
      ?.slice("cw_d_session_info=".length);
    if (!raw) return null;
    const creds = JSON.parse(decodeURIComponent(raw)) as Record<string, string>;
    if (!creds["access-token"] || !creds.client || !creds.uid) return null;
    return creds;
  } catch {
    return null;
  }
}

/**
 * Is the console session still LIVE on the server, not merely present in the
 * browser?
 *
 * Presence is not validity. A cookie outlives its session: after the operator
 * presses "End all sessions", or once devise-token-auth evicts the oldest token
 * at `max_number_of_devices` (25), the cookie remains but its token is dead.
 * Treating that as a live session would frame a console that can never sign in,
 * with no SSO link minted to recover — a dead end.
 *
 * So the credentials are replayed to the console's own profile endpoint, which
 * is what the dashboard itself calls to validate a session on boot. Only a 2xx
 * counts. Any failure (network, 401, proxy down) reads as "no session", which
 * degrades to minting a link — the behaviour that always works.
 */
export async function hasLiveConsoleSession(): Promise<boolean> {
  const creds = readConsoleCredentials();
  if (!creds) return false;
  try {
    const res = await fetch(`${CONSOLE_PREFIX}/api/v1/profile`, {
      credentials: "include",
      headers: {
        "access-token": creds["access-token"],
        client: creds.client,
        uid: creds.uid,
        "token-type": creds["token-type"] ?? "Bearer",
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Re-point a Chatwoot SSO URL at our own origin's console path.
 *
 * Chatwoot mints the link from its OWN host, so following it verbatim would
 * navigate the frame off the gateway — a different site whose session cookie is
 * refused. Only the path is kept, because the proxy serves the console here.
 * An unparseable link is returned unchanged: a malformed value must degrade to
 * "the upstream link" rather than to an empty frame.
 */
export function sameOriginConsolePath(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    return `${CONSOLE_PREFIX}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

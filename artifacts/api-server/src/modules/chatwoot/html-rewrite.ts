/**
 * Rewrites a Chatwoot HTML document so it can be served under a path prefix on
 * OUR origin.
 *
 * Why a document rewrite is enough (measured, not assumed):
 *
 *   - Chatwoot's bundle imports its chunks with RELATIVE specifiers
 *     (`import("./EmojiIconPicker.js")`), so the browser resolves them against
 *     the document's `<base>` — a root-absolute list is not involved.
 *   - The ~20 remaining root-absolute references are `/vite/assets/...`, which
 *     the same proxy serves under the prefix.
 *   - `createWebHistory()` is called with NO argument, which makes vue-router
 *     read `<base href>` from the document. Injecting that tag is therefore the
 *     whole routing fix.
 *
 * So the bundles are NOT rewritten: re-hashing references the browser already
 * resolves correctly would be the fragile path, not the safe one.
 */

export interface HtmlRewriteOptions {
  /** Path prefix the console is served under, e.g. "/whatsapp". */
  prefix: string;
  /** Public origin of the gateway, e.g. "https://cortoba-rfq.onrender.com". */
  host: string;
}

/** Normalise a prefix to `/seg` with no trailing slash; "" means the root. */
export function normalisePrefix(prefix: string): string {
  const trimmed = String(prefix ?? "").replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Drop any `<base>` the upstream may have emitted, so ours is the only one —
 * a browser honours the FIRST `<base href>`, so a stale one would silently win.
 */
function stripBaseTags(html: string): string {
  return html.replace(/<base\b[^>]*>/gi, "");
}

/**
 * The `<base>` tag must come before the assets that depend on it, so it goes
 * immediately after `<head>`. A document with no `<head>` (never seen from
 * Chatwoot, but a rewrite must not depend on that) gets the tag prepended.
 */
function injectBase(html: string, base: string): string {
  const tag = `<base href="${base}">`;
  const headMatch = /<head\b[^>]*>/i.exec(html);
  if (!headMatch) return `${tag}${html}`;
  const at = headMatch.index + headMatch[0].length;
  return `${html.slice(0, at)}${tag}${html.slice(at)}`;
}

/**
 * Point the console at OUR origin's prefix for both transports.
 *
 * `apiHost` and `websocketURL` are NOT emitted by Chatwoot's own layout
 * (verified against the running release: `window.chatwootConfig` carries
 * hostURL/helpCenterURL and no apiHost). Their defaults — `""` and `undefined`
 * — are also correct behind the proxy, since the console genuinely is
 * same-origin. They are injected anyway because they make the deployment
 * self-describing: a reader can see where the console believes its API and
 * socket live instead of inferring it from a default.
 */
function injectChatwootConfig(html: string, origin: string): string {
  const marker = /window\.chatwootConfig\s*=\s*\{/;
  if (!marker.test(html)) return html;
  return html.replace(marker, (m) => `${m}\n        apiHost: '${origin}',\n        websocketURL: '${origin}',`);
}

/**
 * Rewrite a Chatwoot document for prefix hosting.
 *
 * `hostURL` is rewritten to the SAME-ORIGIN prefixed URL: Chatwoot builds
 * absolute links from it (`/app/login`, `/survey/responses/...`), and leaving it
 * at the private upstream address would hand the browser links it cannot reach.
 */
export function rewriteChatwootHtml(html: string, opts: HtmlRewriteOptions): string {
  const prefix = normalisePrefix(opts.prefix);
  const base = `${prefix}/`;
  const host = String(opts.host ?? "").replace(/\/+$/, "");
  const publicOrigin = `${host}${prefix}`;

  let out = stripBaseTags(html);
  out = injectBase(out, base);
  out = injectChatwootConfig(out, publicOrigin);
  // Only when hostURL is actually present. The value is always safe to make
  // absolute: it is used to BUILD links, never to authorise a request.
  out = out.replace(/(hostURL:\s*')[^']*(')/, `$1${publicOrigin}$2`);
  out = out.replace(/(helpCenterURL:\s*')[^']*(')/, `$1${publicOrigin}$2`);
  return out;
}

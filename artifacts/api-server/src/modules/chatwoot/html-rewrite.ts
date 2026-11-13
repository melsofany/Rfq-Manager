/**
 * Rewrites a Chatwoot HTML document so it can be served under a path prefix on
 * OUR origin.
 *
 * Why the document rewrite is required (measured on production, after a blank
 * page was reported):
 *
 *   - `<base href>` fixes RELATIVE urls only. Chatwoot's bundle imports its
 *     chunks relatively (`import("./EmojiIconPicker.js")`), so those resolve
 *     correctly against the base — but the entry tags the layout emits are
 *     ROOT-ABSOLUTE (`/vite/assets/index-<hash>.js`, the favicons,
 *     `/manifest.json`). A root-absolute url ignores `<base>` and is fetched
 *     from the domain root, where our SPA fallback answers with `index.html`.
 *     The browser then parses HTML as JavaScript and renders NOTHING — the
 *     blank page. So the absolute references must be rewritten here; `<base>`
 *     alone is not enough.
 *
 * The rewrite is applied to `src`/`href` attributes only, and only when the
 * value is a site-absolute path — external urls, protocol-relative urls and
 * fragments are left alone.
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
 * Prefix every site-absolute `src`/`href`.
 *
 * Guarded against the values that must NOT be touched: a protocol-relative
 * `//host/x`, an absolute url with a scheme, a fragment, and a path already
 * carrying the prefix (a re-rewrite must be idempotent — a doubled prefix is a
 * 404, which is the same blank page by a different route).
 */
function prefixAbsoluteRefs(html: string, prefix: string): string {
  if (!prefix) return html;
  return html.replace(
    /(\s(?:src|href)\s*=\s*")(\/[^"]*)"/gi,
    (whole, attr: string, url: string) => {
      if (url.startsWith("//")) return whole;
      if (url === prefix || url.startsWith(`${prefix}/`)) return whole;
      return `${attr}${prefix}${url}"`;
    },
  );
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
 * (measured against the running release: `window.chatwootConfig` carries
 * hostURL/helpCenterURL and no apiHost, while the bundle reads
 * `{apiHost: Pa = ""} = window.chatwootConfig` and builds `baseURL` from it).
 * Both defaults — `""` and `undefined` — are already correct behind the proxy,
 * since the console genuinely is same-origin. They are injected anyway so the
 * deployment is self-describing: a reader sees where the console believes its
 * API and socket live instead of inferring it from a default.
 *
 * `websocketURL` is a `ws://`/`wss://` url when Chatwoot sets one, so it takes
 * the socket scheme rather than the page's `https://`.
 */
function injectChatwootConfig(html: string, origin: string, host: string): string {
  const marker = /window\.chatwootConfig\s*=\s*\{/;
  if (!marker.test(html)) return html;
  const wsOrigin = host.replace(/^http/, "ws");
  return html.replace(
    marker,
    (m) => `${m}\n        apiHost: '${origin}',\n        websocketURL: '${wsOrigin}',`,
  );
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
  // MUST run before the config injection: the injected `apiHost` is an
  // absolute url with a scheme, which the ref rewrite correctly ignores — but
  // ordering it first keeps that a property of the value, not of the sequence.
  out = prefixAbsoluteRefs(out, prefix);
  out = injectChatwootConfig(out, publicOrigin, host);
  // Only when a value is actually present, and only when it points at the
  // upstream. `helpCenterURL` is emitted EMPTY on this release; rewriting an
  // empty value into our origin would silently enable a help-centre link that
  // the operator never configured.
  out = out.replace(/(hostURL:\s*')[^']*(')/, `$1${publicOrigin}$2`);
  out = out.replace(
    /(helpCenterURL:\s*')([^']+)(')/,
    (whole, open: string, url: string, close: string) =>
      /^https?:\/\//.test(url) ? `${open}${publicOrigin}${close}` : whole,
  );
  return out;
}

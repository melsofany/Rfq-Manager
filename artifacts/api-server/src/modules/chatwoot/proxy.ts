/**
 * Reverse proxy that serves the Chatwoot console on OUR origin under a path
 * prefix, so the agent console lives at
 * `https://<gateway>/whatsapp` and nowhere else.
 *
 * Why a proxy at all — measured, not preferred:
 *
 *   `onrender.com` is on the Public Suffix List, so `cortoba-rfq.onrender.com`
 *   and `cortoba-chatwoot.onrender.com` are DIFFERENT SITES. A console embedded
 *   from the second into the first is a third-party frame, and its session
 *   cookie is refused. Serving it from the gateway's own origin — first-party —
 *   is the only way an embedded login can work without a custom domain.
 *
 * The upstream is treated as an OPAQUE origin behind a path prefix:
 *
 *   - the prefix is stripped before forwarding, so Chatwoot still sees `/api/v1`,
 *     `/cable`, `/vite/assets` and behaves exactly as it does standalone;
 *   - responses are streamed through untouched EXCEPT HTML, which is rewritten
 *     to inject `<base href>` (see html-rewrite.ts). Assets are NOT rewritten:
 *     Chatwoot's chunks are imported relatively and resolve against that base.
 *   - `Set-Cookie` is the one header the path changes, and only to scope the
 *     cookie to the console path so it is never sent with a Cortoba API call.
 *
 * Built on `node:http` + `node:net` only: the gateway ships neither `ws` nor
 * `http-proxy`, and a vendor tree must not be added to reach the console.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { URL } from "node:url";
import type { Request, Response } from "express";
import { logger } from "../../shared/logger";
import { loadAccess, allowsAny } from "../../shared/permissions";
import { normalisePrefix, rewriteChatwootHtml } from "./html-rewrite";

/**
 * The console is reached through a BROWSER, so a rejection has to be something a
 * browser can act on.
 *
 * `guardFor("/whatsapp")` — the guard on the API routes — answers a rejected
 * request with JSON (`401 {"error":"Unauthorized"}`). That is right for a fetch
 * and wrong for a document: the operator gets a page of JSON inside the console
 * frame with no way back. This redirects to the app's login instead, which is
 * what the SPA's own `ProtectedRoute` does for `/whatsapp`.
 *
 * Permission set is deliberately the SAME as `/whatsapp` in `ROUTE_GUARDS`: the
 * console REPLACES that page, so anyone allowed to see the chat list is allowed
 * to see the console, and nobody else is. A second, divergent rule here is how
 * an unauthenticated visitor ends up looking at a login form for a product they
 * have no account on.
 */
export function chatwootConsoleGuard() {
  return async (req: Request, res: Response, next: () => void): Promise<void> => {
    const toLogin = (): void => {
      // Only a document navigation should be redirected; an XHR (the console's
      // own `/api/v1`, its websocket handshake) gets a status it can handle.
      const wantsHtml = String(req.headers.accept || "").includes("text/html");
      if (wantsHtml && req.method === "GET") {
        res.redirect(302, "/login");
        return;
      }
      res.status(401).json({ error: "Unauthorized" });
    };
    try {
      const session = (req as Request & { session?: { employeeId?: number } }).session;
      if (!session?.employeeId) return toLogin();
      const access = await loadAccess(session.employeeId);
      if (!access) return toLogin();
      if (!allowsAny(access, ["whatsapp", "whatsapp:chats"])) {
        const wantsHtml = String(req.headers.accept || "").includes("text/html");
        if (wantsHtml && req.method === "GET") res.redirect(302, "/");
        else res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    } catch (err) {
      // Fail CLOSED. A guard that lets the request through when its own lookup
      // throws is not a guard: the console is the one surface where a failed
      // permission read would expose every supplier conversation at once.
      logger.error({ err }, "chatwoot console guard failed; refusing the request");
      toLogin();
    }
  };
}

/** Hop-by-hop headers (RFC 7230 §6.1) must not be forwarded either way. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface ProxyConfig {
  /** Upstream origin, e.g. "https://cortoba-chatwoot.onrender.com". */
  target: string;
  /**
   * Path prefix to strip before forwarding. EMPTY for the normal deployment,
   * where the console is mounted at the root and the path must pass through
   * untouched. Only non-empty when the caller deliberately serves the console
   * under a sub-path.
   */
  prefix: string;
}

/** The upstream origin, or null when the console is not configured. */
export function chatwootProxyTarget(): string | null {
  const raw = process.env.CHATWOOT_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Where the console is mounted on the gateway.
 *
 * **The root, and it cannot be a sub-path.** Chatwoot derives its account id
 * from the POSITION of the segment in the URL:
 *
 *     // app/javascript/dashboard/api/ApiClient.js
 *     if (pathname.includes('/app/accounts')) return pathname.split('/')[3];
 *
 * On its own host the path is `/app/accounts/3/...`, so index 3 is the account.
 * Serving it under `/whatsapp/console` shifts every index by two, index 3
 * becomes the literal `app`, and every console request goes to
 * `/api/v1/accounts/app/...` — a 404. Measured live: **167 consecutive 404s**,
 * which the console renders as an empty conversation list with no error.
 *
 * Chatwoot has no sub-path support to configure instead: the dashboard router
 * is `createWebHistory()` with no base, and nothing reads a base-path setting.
 * Four call sites read the same positional index (`ApiClient.js`,
 * `uploadHelper.js` twice, `useWhatsappCallSession.js`, `Contact.vue`), so
 * patching the client is not an option either — and editing the vendored tree
 * would be lost on the next Chatwoot upgrade.
 *
 * Mounting at the root is therefore the only correct arrangement. It is safe
 * because nothing in this app uses Chatwoot's path space: the API lives under
 * `/api`, `/iclock` is the ZKTeco firmware path, and the SPA routes (`/login`,
 * `/whatsapp`, `/dashboard`, …) do not collide with `/app`, `/api/v1`,
 * `/platform`, `/cable`, `/rails`, `/vite` or `/packs`.
 *
 * The mount is ordered BEFORE `express.static` and the SPA catch-all, so the
 * console owns its paths and the SPA keeps everything else.
 */
export function chatwootProxyMount(): string {
  return chatwootProxyTarget() ? "/" : "";
}

/**
 * Does this request path belong to the Chatwoot console?
 *
 * The console is mounted at the root, so the proxy would otherwise answer for
 * the whole deployment. This is the ONE description of the path space Chatwoot
 * actually serves; anything not listed falls through to the app's own API and
 * SPA.
 *
 * Derived from Chatwoot's routes and its `public/` directory rather than
 * guessed: `/app` is the dashboard SPA, `/api/v1` and `/platform` are its APIs,
 * `/cable` and `/rails` are its websockets, `/vite` and `/packs` are its assets,
 * `/enterprise` is its paid surface, and the named files are the icons and
 * manifests the dashboard and its login page load from the root.
 *
 * A NEW top-level path in Chatwoot must be added here, or that one feature will
 * 404 while the rest of the console keeps working — which is exactly the failure
 * this function exists to prevent, so keep it complete rather than minimal.
 */
const CHATWOOT_ROOT_PREFIXES = [
  "/app",
  "/api/v1",
  "/platform",
  "/enterprise",
  "/cable",
  "/rails",
  "/vite",
  "/packs",
  "/audio",
  "/sw.js",
  "/manifest.json",
  "/robots.txt",
  "/favicon",
  "/apple-icon",
  "/android-icon",
  "/ms-icon",
  "/browserconfig.xml",
];

export function chatwootOwnsPath(path: string): boolean {
  return CHATWOOT_ROOT_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
}

/**
 * Strip the GATEWAY's own session cookie from a Cookie header, keeping the
 * console's.
 *
 * The console authenticates with a cookie of its own (`cw_d_session_info`
 * carries the devise-token-auth credentials), and under same-origin hosting the
 * browser sends it here — so dropping the whole `Cookie` header would log the
 * agent out on every API call. What must NOT travel upstream is Cortoba's
 * session (`connect.sid`): the console service has no business holding a
 * gateway credential, and it would leak the operator's session to a second
 * service. Everything else is forwarded.
 */
export function stripGatewayCookies(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const kept = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const name = part.split("=")[0]?.trim().toLowerCase();
      return name !== "connect.sid" && !name?.startsWith("connect.sid.");
    });
  return kept.length ? kept.join("; ") : undefined;
}

/**
 * The agent the upstream requests are made through.
 *
 * `origin` is passed so the request is issued with NO Host override: fetch/
 * undici already sets Host from the URL. For the raw-socket WebSocket path the
 * Host header is the one Node adds, and the upstream TLS SNI comes from the
 * URL — so nothing here has to synthesise a Host, which is what keeps this
 * from becoming a request-smuggling surface.
 */
function upstreamRequest(
  target: string,
  pathWithQuery: string,
  req: Request,
): http.ClientRequest {
  const url = new URL(target);
  const isTls = url.protocol === "https:";
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    // The console's own auth cookie must reach it — only the gateway's session
    // is stripped (see stripGatewayCookies).
    if (k.toLowerCase() === "cookie") {
      const kept = stripGatewayCookies(v as string | undefined);
      if (kept) headers.cookie = kept;
      continue;
    }
    // `host` is rebuilt by the client from the URL; forwarding ours would make
    // the upstream answer for a hostname it does not serve.
    if (k.toLowerCase() === "host") continue;
    headers[k] = v;
  }
  // Ask the upstream for an UNCOMPRESSED response.
  //
  // This is a correctness requirement, not a preference. The client's
  // `accept-encoding` used to be forwarded, so the upstream could compress; the
  // body then travelled with its `content-encoding` header and a client that
  // negotiates transparently (undici's `fetch`) decompressed it a SECOND time —
  // measured live against the real service as
  // `TypeError: terminated / incorrect header check / Z_DATA_ERROR`. The HTML
  // rewrite made it worse: it re-encoded the body as plain text while the header
  // still claimed gzip.
  //
  // `identity` removes the whole failure mode. Edge compression on the FINAL hop
  // (Render, Cloudflare) is applied downstream, so the client still gets gzip.
  headers["accept-encoding"] = "identity";
  // Present the gateway as the origin so a Host-checking upstream behaves.
  headers.host = url.hostname + (url.port ? `:${url.port}` : "");
  headers["x-forwarded-host"] = req.get("host") ?? url.host;
  headers["x-forwarded-proto"] = "https";
  // Prove to the console that this request came through the gateway, so the
  // console can refuse every OTHER caller (there is no way to make the Render
  // service private on a non-Enterprise plan). Omitted when unset: an empty
  // header would merely be forwarded, and the console treats "no secret
  // configured" as "gate off" anyway.
  const gatewaySecret = process.env.CHATWOOT_GATEWAY_SECRET?.trim();
  if (gatewaySecret) headers["x-cortoba-gateway"] = gatewaySecret;

  return (isTls ? https : http).request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (isTls ? 443 : 80),
    method: req.method,
    path: pathWithQuery,
    headers,
  });
}

/**
 * Force a Set-Cookie path, but only when the console lives under a sub-path.
 *
 * Chatwoot sets its cookies at `Path=/`, which is exactly right now that the
 * console is mounted at the ROOT — and re-scoping them to a sub-path would hide
 * them from the dashboard's own pages and break the login it just performed.
 *
 * The narrowing is kept for the one case that still wants it: when a caller
 * passes a non-empty prefix, the console is served under that sub-path, and
 * without an explicit `Path` a browser would scope a cookie set at
 * `/whatsapp/app/login` to the DIRECTORY `/whatsapp/app` — which the console's
 * own root then never sees.
 */
export function scopeSetCookie(value: string, prefix: string): string {
  if (!prefix || prefix === "/") return value;
  const withoutOldPath = value.replace(/;\s*Path=[^;]*/gi, "");
  return `${withoutOldPath}; Path=${prefix}`;
}

function copyResponseHeaders(
  upstream: http.IncomingMessage,
  res: Response,
  prefix: string,
): void {
  for (const [k, v] of Object.entries(upstream.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (v === undefined) continue;
    if (k.toLowerCase() === "set-cookie") {
      const list = Array.isArray(v) ? v : [v];
      res.setHeader(
        "set-cookie",
        list.map((c) => scopeSetCookie(c, prefix)),
      );
      continue;
    }
    // Content-Length is preserved for bodies we pass through; for a rewritten
    // body it is wrong, and `res.end(string)` recomputes it.
    if (k.toLowerCase() === "content-length") continue;
    res.setHeader(k, v as string | string[]);
  }
}

/** True when this response should get the HTML treatment. */
export function isHtmlResponse(contentType: string | undefined): boolean {
  return typeof contentType === "string" && contentType.toLowerCase().includes("text/html");
}

/** Absolute http(s) requests only — expressed as a function for the guard test. */
export function relativePathFor(url: string | undefined, prefix: string): string {
  const raw = url ?? "/";
  if (!prefix) return raw;
  if (raw === prefix) return "/";
  if (raw.startsWith(`${prefix}/`)) return raw.slice(prefix.length);
  if (raw.startsWith(`${prefix}?`)) {
    // The query belongs to the root, not to a pathless request line:
    // forwarding `?x=1` alone would produce a malformed request target.
    return `/${raw.slice(prefix.length)}`;
  }
  return raw;
}

/**
 * Serve one console request from the upstream.
 *
 * Returns the promise the socket handler awaits so tests can drive the real
 * path (a fire-and-forget forward would make a failure invisible).
 */
export async function proxyChatwootRequest(
  req: Request,
  res: Response,
  cfg: ProxyConfig,
): Promise<void> {
  const prefix = normalisePrefix(cfg.prefix);
  const pathWithQuery = relativePathFor(req.originalUrl || req.url, prefix);

  await new Promise<void>((resolve) => {
    const upstream = upstreamRequest(cfg.target, pathWithQuery, req);
    upstream.on("error", (err) => {
      logger.error({ err, path: pathWithQuery }, "Chatwoot proxy: upstream error");
      if (!res.headersSent) {
        res.status(502).json({
          error: "تعذّر الوصول إلى خادم المحادثات",
          detail: err instanceof Error ? err.message : String(err),
        });
      } else {
        res.end();
      }
      resolve();
    });
    upstream.on("response", (up) => {
      const contentType = up.headers["content-type"];
      if (isHtmlResponse(contentType as string | undefined)) {
        // Buffer only HTML: it is small, and it must be rewritten before the
        // browser sees a single byte. Everything else streams.
        const chunks: Buffer[] = [];
        up.on("data", (c: Buffer) => chunks.push(c));
        up.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const rewritten = rewriteChatwootHtml(body, {
            prefix,
            host: process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`,
          });
          copyResponseHeaders(up, res, prefix);
          res.status(up.statusCode ?? 502);
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.end(rewritten);
          resolve();
        });
        up.on("error", () => {
          if (!res.headersSent) res.status(502).end();
          resolve();
        });
        return;
      }
      copyResponseHeaders(up, res, prefix);
      res.status(up.statusCode ?? 502);
      up.pipe(res);
      up.on("end", resolve);
      up.on("error", () => resolve());
    });

    // Forward the request body unchanged (uploads, form posts). A GET simply
    // ends immediately.
    req.pipe(upstream);
  });
}

/**
 * Relay a WebSocket upgrade to `target`'s path.
 *
 * ActionCable is how the console delivers a new message without a page reload;
 * dropping the socket still renders the console, but the agent would have to
 * refresh to see a reply — the console would be "working" while silently
 * failing to be live. Hence the relay, done at the RAW SOCKET level: an
 * upgrade has no HTTP body to proxy, and the handshake must be forwarded
 * byte-for-byte with its own headers.
 *
 * `tls.connect` for an https upstream — `net.connect` would send a TLS
 * handshake to a TLS listener and the relay would fail at the worst moment
 * (when a message arrives).
 */
export function relayWebSocket(
  req: Request,
  socket: Duplex,
  head: Buffer,
  cfg: ProxyConfig,
): void {
  const url = new URL(cfg.target);
  const isTls = url.protocol === "https:";
  const port = url.port ? Number(url.port) : isTls ? 443 : 80;

  const onConnect = () => {
    const lines: string[] = [`${req.method} ${req.originalUrl || req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      // The upstream virtual-hosts on ITS hostname, not ours.
      if (k.toLowerCase() === "host") continue;
      lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    }
    lines.push(`host: ${url.hostname}${url.port ? `:${url.port}` : ""}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    // Node hands over bytes it read past the request line; discarding them
    // would corrupt the first frame of a socket that already started sending.
    if (head && head.length) socket.write(head);
  };

  const up = isTls
    ? tls.connect({ port, host: url.hostname, servername: url.hostname }, onConnect)
    : net.connect(port, url.hostname, onConnect);

  up.on("error", (err) => {
    logger.error({ err, url: req.url }, "Chatwoot proxy: websocket relay failed");
    socket.destroy();
  });
  socket.on("error", () => up.destroy());
  socket.pipe(up).pipe(socket);
}



import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  proxyChatwootRequest,
  scopeSetCookie,
  relativePathFor,
  isHtmlResponse,
  stripGatewayCookies,
  chatwootProxyMount,
  chatwootProxyTarget,
  chatwootOwnsPath,
  chatwootRequiresAuth,
} from "../../modules/chatwoot/proxy";

/**
 * The console is served first-party through a reverse proxy.
 *
 * These tests drive a REAL express app against a REAL upstream HTTP server, so
 * the assertions cover the wire behaviour — path stripping, header handling,
 * cookie scoping and the HTML rewrite — rather than a mock of each. A mocked
 * proxy would pass while the real one forwarded the wrong path, which is the
 * failure that silently renders an empty console.
 */

/** Upstream stub that echoes what it received, and can answer any route. */
function upstreamHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.url === "/app/html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<html><head><title>Chatwoot</title></head><body>` +
        `<script>window.chatwootConfig = { hostURL: 'https://upstream.example' }</script>` +
        `<script src="/vite/assets/dashboard.js"></script></body></html>`,
    );
  } else if (req.url === "/api/v1/set-cookie") {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "_chatwoot_session=abc; path=/app; HttpOnly; Secure",
    });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.url === "/cable") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
  } else if (req.url === "/auth/sign_in") {
    // The SSO exchange. Echoes method + body so the test can prove the token
    // actually reached Chatwoot rather than being swallowed by a fallback.
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, body }));
    });
  } else if (req.url === "/app/echo") {
    // Reflect method + body so a POST body can be proven forwarded intact.
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method,
          body,
          host: req.headers.host,
          acceptEncoding: req.headers["accept-encoding"] ?? null,
          cookie: req.headers.cookie ?? null,
        }),
      );
    });
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie ?? null }));
  }
}

let upstream: http.Server;
let appServer: http.Server;
let upstreamUrl: string;
let gatewayUrl: string;

beforeAll(async () => {
  upstream = http.createServer(upstreamHandler);
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const app = express();
  const mount = chatwootProxyMount();
  // Mirrors `app.ts`: the console is at the ROOT, so the proxy is filtered to
  // Chatwoot's own path space and everything else falls through to the SPA.
  app.use(mount, (req, res, next) => {
    if (!chatwootOwnsPath(req.path)) return next();
    proxyChatwootRequest(req, res, { target: upstreamUrl, prefix: mount }).catch(next);
  });
  // A same-path SPA fallback must lose to the proxy: this is the guard that
  // catches a proxy mounted AFTER the fallback (which would serve index.html).
  app.use(express.static("."));
  // Anything the console does NOT own answers as the SPA would, so a request
  // the proxy wrongly claimed is visible as the wrong body rather than a 404.
  //
  // GET-only, exactly like `app.ts`. A fallback that also answered POST hid a
  // real defect: `POST /auth/sign_in` — the call that CONSUMES the SSO token —
  // was 404 in production while this test passed, because production's
  // catch-all is `app.get("*")` and Express answers an unmatched POST with 404.
  // A regex, not `"*"`: Express 5 rejects the bare star as a route path.
  app.get(/.*/, (_req, res) => res.status(200).type("html").send("<html>SPA</html>"));
  appServer = http.createServer(app);
  await new Promise<void>((r) => appServer.listen(0, "127.0.0.1", r));
  gatewayUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => appServer.close(() => r()));
});

describe("path handling", () => {
  it("passes a root-mounted path through untouched", () => {
    // At the root the upstream must receive the SAME path. A strip here would
    // be the bug, not the fix: Chatwoot reads its account id from the URL's
    // POSITION (`pathname.split('/')[3]`), so `/app/accounts/3` must arrive
    // unchanged or every console request 404s.
    expect(relativePathFor("/api/v1/accounts/3/conversations", "")).toBe(
      "/api/v1/accounts/3/conversations",
    );
    expect(relativePathFor("/app/accounts/3/dashboard", "")).toBe("/app/accounts/3/dashboard");
    expect(relativePathFor("/", "")).toBe("/");
  });

  it("still strips when a prefix IS configured", () => {
    // A caller CAN still pass a prefix (`ProxyConfig.prefix`), so the strip
    // logic must not be removed along with the root default.
    expect(relativePathFor("/whatsapp/console/api/v1/accounts", "/whatsapp/console")).toBe(
      "/api/v1/accounts",
    );
    expect(relativePathFor("/whatsapp/console", "/whatsapp/console")).toBe("/");
    expect(relativePathFor("/whatsapp/console?x=1", "/whatsapp/console")).toBe("/?x=1");
    expect(relativePathFor("/api/other", "/whatsapp/console")).toBe("/api/other");
  });

  it("forwards the account-scoped path end to end, with the account intact", async () => {
    // The regression this whole change exists for. Serving the console under a
    // sub-path shifted the URL indices so the console asked for
    // `/api/v1/accounts/app/...` — 167 consecutive 404s live, rendered as an
    // empty conversation list with no error. The account segment must survive.
    const res = await fetch(`${gatewayUrl}/api/v1/accounts/3/conversations`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { path: string };
    expect(data.path).toBe("/api/v1/accounts/3/conversations");
  });

  it("claims only Chatwoot's own path space, never the app's", () => {
    // The console is at the ROOT, so the ownership test is what keeps the SPA
    // and the API working. A too-greedy rule would swallow `/api/...` and every
    // page of the portal.
    for (const p of [
      "/app",
      "/app/accounts/3/dashboard",
      "/api/v1/accounts/3",
      "/platform/api/v1/users",
      "/cable",
      "/vite/assets/dashboard.js",
      "/packs/js/app.js",
      // The dashboard's own profile menu links here, so a gap 404s a real
      // destination rather than an unused route.
      "/super_admin",
      "/super_admin/users",
      "/favicon.ico",
      "/manifest.json",
    ]) {
      expect(chatwootOwnsPath(p), p).toBe(true);
    }
    for (const p of [
      "/",
      "/api/healthz",
      "/api/chatwoot/status",
      "/login",
      "/whatsapp",
      "/dashboard",
      "/customer-rfq/12",
      "/iclock/cdata",
    ]) {
      expect(chatwootOwnsPath(p), p).toBe(false);
    }
  });

  it("forwards the console's OWN login endpoint, and guards it", () => {
    // `mount_devise_token_auth_for 'User', at: 'auth'`. The dashboard calls it
    // directly, so a gap here means the console can never sign anyone in — the
    // live symptom was `auth/sign_in 404` on the login form.
    expect(chatwootOwnsPath("/auth/sign_in")).toBe(true);
    expect(chatwootRequiresAuth("/auth/sign_in")).toBe(true);
    // `/dashboard` is a path under Chatwoot's public/ AND a real route of our
    // SPA. Ours must win, or the portal's dashboard page disappears.
    expect(chatwootOwnsPath("/dashboard")).toBe(false);
  });

  it("does NOT charge the permission check for static assets", () => {
    // Measured live: the login page reported `manifest.json 401`, and the
    // console's own JS under /vite was refused the same way — failures that
    // surface as unrelated bugs. The check is also a DATABASE lookup, so
    // charging it per asset would make every screen slow.
    for (const p of [
      "/vite/assets/dashboard.js",
      "/packs/js/app.js",
      "/manifest.json",
      "/favicon.ico",
      "/sw.js",
      "/audio/dashboard/ping.mp3",
      "/brand-assets/logo.svg",
    ]) {
      expect(chatwootOwnsPath(p), p).toBe(true);
      expect(chatwootRequiresAuth(p), p).toBe(false);
    }
  });

  it("keeps supplier DATA behind the guard", () => {
    // The other half of the rule: everything that exposes a supplier's
    // conversation or attachment must still pass authentication AND the
    // `whatsapp` permission.
    for (const p of [
      "/app/accounts/3/dashboard",
      "/api/v1/accounts/3/conversations",
      "/platform/api/v1/users",
      "/auth/sign_in",
      "/super_admin",
      "/cable",
      // ActiveStorage: the attachments suppliers send.
      "/rails/active_storage/blobs/abc/quote.pdf",
    ]) {
      expect(chatwootOwnsPath(p), p).toBe(true);
      expect(chatwootRequiresAuth(p), p).toBe(true);
    }
  });

  it("leaves the app's own routes to the app", async () => {
    const res = await fetch(`${gatewayUrl}/dashboard`);
    expect(await res.text()).toContain("SPA");
  });
});

describe("SSO", () => {
  it("forwards POST /auth/sign_in end to end, body intact", async () => {
    // The console's SSO link carries email + sso_auth_token to /app/login, and
    // the dashboard POSTs them to /auth/sign_in — where Chatwoot consumes the
    // token. When that POST did not reach Chatwoot the console fell back to its
    // login FORM, so an operator saw a password prompt instead of being signed
    // in. Asserting the function table alone would not have caught it: the
    // request has to be shown arriving.
    const res = await fetch(`${gatewayUrl}/auth/sign_in`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "*/*" },
      body: JSON.stringify({ email: "a@b.c", sso_auth_token: "tok-123" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { method: string; body: string };
    expect(body.method).toBe("POST");
    expect(body.body).toContain("sso_auth_token");
    expect(body.body).toContain("tok-123");
  });

  it("does not answer an unclaimed POST with the SPA", async () => {
    // The negative control for the fallback above: a POST the console does not
    // own must NOT be swallowed by a catch-all, which is how the SSO 404 was
    // masked in the first place.
    const res = await fetch(`${gatewayUrl}/definitely-not-ours`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("cookies", () => {
  it("leaves the console cookie alone at the ROOT", () => {
    // Re-scoping it to a sub-path would HIDE the cookie from the dashboard's
    // own pages and break the login it just performed. Chatwoot already sets
    // `Path=/`, which is correct when it is mounted at the root.
    const value = "_chatwoot_session=abc; path=/app; HttpOnly";
    expect(scopeSetCookie(value, "")).toBe(value);
    expect(scopeSetCookie(value, "/")).toBe(value);
  });

  it("still rescopes when a prefix IS configured", () => {
    const scoped = scopeSetCookie(
      "_chatwoot_session=abc; path=/app; HttpOnly",
      "/whatsapp/console",
    );
    expect(scoped).toContain("Path=/whatsapp/console");
    expect(scoped.toLowerCase()).not.toContain("path=/app");
    expect(scoped).toContain("HttpOnly");
  });

  it("passes the upstream's cookie through untouched, end to end", async () => {
    const res = await fetch(`${gatewayUrl}/api/v1/set-cookie`);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.toLowerCase()).toContain("path=/app");
  });

  it("strips the GATEWAY session upstream but keeps the console's own cookie", () => {
    // The console authenticates with a cookie of its own, so dropping the whole
    // Cookie header would log the agent out on every API call. Only Cortoba's
    // session must not reach a second service.
    expect(stripGatewayCookies("connect.sid=gateway-secret")).toBeUndefined();
    expect(stripGatewayCookies("cw_d_session_info=console-auth")).toBe(
      "cw_d_session_info=console-auth",
    );
    expect(stripGatewayCookies("connect.sid=gw; cw_d_session_info=cw")).toBe(
      "cw_d_session_info=cw",
    );
    // A rotated name must be caught too — connect-pg-simple signs cookies as
    // `connect.sid.sig`.
    expect(stripGatewayCookies("connect.sid.sig=sig; cw_d_session_info=cw")).toBe(
      "cw_d_session_info=cw",
    );
  });

  it("forwards the console cookie and never the gateway session, end to end", async () => {
    const res = await fetch(`${gatewayUrl}/app/echo`, {
      headers: { cookie: "connect.sid=gateway-secret; cw_d_session_info=console-auth" },
    });
    const data = (await res.json()) as { cookie?: string | null };
    expect(data.cookie).toContain("cw_d_session_info=console-auth");
    expect(data.cookie).not.toContain("gateway-secret");
  });
});

describe("HTML rewriting", () => {
  it("leaves root-absolute assets untouched at the ROOT", async () => {
    const res = await fetch(`${gatewayUrl}/app/html`);
    const body = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    // The console IS the root, so `/vite/assets/...` already resolves to it.
    // Prefixing it would send the browser to `/app/vite/...` — a path nothing
    // serves — which is how a blank console happens.
    expect(body).toContain('src="/vite/assets/dashboard.js"');
    expect(body).not.toContain('src="/app/vite/assets');
    expect(body).not.toContain("upstream.example");
  });

  it("rewrites hostURL to OUR origin so links stay first-party", async () => {
    const res = await fetch(`${gatewayUrl}/app/html`);
    const body = await res.text();
    // The link-copy helpers build `${hostURL}${path}`. Leaving the upstream's
    // host would copy a link into a different site — whose session cookie is
    // refused, so the pasted link lands on a login page.
    expect(body).not.toContain("upstream.example");
    expect(body).toMatch(/hostURL: 'https:\/\/127\.0\.0\.1:\d+'/);
  });

  it("does not buffer or rewrite a non-HTML body", async () => {
    const res = await fetch(`${gatewayUrl}/app/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const data = (await res.json()) as { method: string; body: string };
    expect(data.method).toBe("POST");
    // A rewritten/rebuilt body would lose this — the reason only HTML buffers.
    expect(JSON.parse(data.body)).toEqual({ hello: "world" });
  });

  it("classifies only text/html as HTML", () => {
    expect(isHtmlResponse("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlResponse("application/json")).toBe(false);
    expect(isHtmlResponse(undefined)).toBe(false);
  });
});

describe("upstream addressing", () => {
  it("asks the upstream for an uncompressed body", async () => {
    // Measured live against the real service: forwarding the client's
    // `accept-encoding` let the upstream gzip the body, which then arrived with
    // its `content-encoding` header — and a transparently-decompressing client
    // (undici's fetch) failed with `Z_DATA_ERROR: incorrect header check`. A
    // rewritten HTML body made it worse by re-encoding plain text under a gzip
    // header. The stub echoes the header it actually received, so this is a
    // wire-level assertion rather than a source scan.
    const res = await fetch(`${gatewayUrl}/app/echo`, {
      headers: { "accept-encoding": "gzip, deflate, br" },
    });
    const data = (await res.json()) as { acceptEncoding?: string };
    expect(data.acceptEncoding).toBe("identity");
  });

  it("presents the upstream's own host, not the gateway's", async () => {
    const res = await fetch(`${gatewayUrl}/cable`);
    const data = (await res.json()) as { host: string };
    // A forwarded gateway Host would make a virtual-hosted upstream answer for
    // a site it does not serve.
    expect(data.host).not.toContain(gatewayUrl.replace("http://", ""));
    expect(data.host).toContain("127.0.0.1");
  });
});

describe("configuration", () => {
  it("returns null target when CHATWOOT_URL is unset", () => {
    const saved = process.env.CHATWOOT_URL;
    delete process.env.CHATWOOT_URL;
    expect(chatwootProxyTarget()).toBeNull();
    if (saved !== undefined) process.env.CHATWOOT_URL = saved;
  });

  it("mounts at the ROOT when a target is configured", () => {
    // Chatwoot reads its account id from the URL position, so it cannot live
    // under a sub-path. The mount is the root whenever there is a target.
    const saved = process.env.CHATWOOT_URL;
    process.env.CHATWOOT_URL = "https://console.example";
    expect(chatwootProxyMount()).toBe("/");
    if (saved === undefined) delete process.env.CHATWOOT_URL;
    else process.env.CHATWOOT_URL = saved;
  });
});

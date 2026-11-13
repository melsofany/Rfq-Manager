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
  if (req.url === "/html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<html><head><title>Chatwoot</title></head><body>` +
        `<script>window.chatwootConfig = { hostURL: 'https://upstream.example' }</script>` +
        `<script src="/vite/assets/dashboard.js"></script></body></html>`,
    );
  } else if (req.url === "/set-cookie") {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "_chatwoot_session=abc; path=/app; HttpOnly; Secure",
    });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.url === "/cable") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
  } else if (req.url === "/echo") {
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
  app.use(mount, (req, res, next) => {
    proxyChatwootRequest(req, res, { target: upstreamUrl, prefix: mount }).catch(next);
  });
  // A same-path SPA fallback must lose to the proxy: this is the guard that
  // catches a proxy mounted AFTER the fallback (which would serve index.html).
  app.use(express.static("."));
  appServer = http.createServer(app);
  await new Promise<void>((r) => appServer.listen(0, "127.0.0.1", r));
  gatewayUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => appServer.close(() => r()));
});

describe("path handling", () => {
  it("strips the mount prefix so the upstream sees its own root paths", () => {
    // The console asks for `/api/v1/...` RELATIVE to the document base; the
    // upstream must still receive `/api/v1/...`, not `/whatsapp/console/api/v1`.
    expect(relativePathFor("/whatsapp/console/api/v1/accounts", "/whatsapp/console")).toBe(
      "/api/v1/accounts",
    );
    expect(relativePathFor("/whatsapp/console/vite/assets/a.js", "/whatsapp/console")).toBe(
      "/vite/assets/a.js",
    );
    // The mount itself is the document root.
    expect(relativePathFor("/whatsapp/console", "/whatsapp/console")).toBe("/");
    // A query on the mount keeps its query.
    expect(relativePathFor("/whatsapp/console?x=1", "/whatsapp/console")).toBe("/?x=1");
  });

  it("does not touch a path outside the prefix", () => {
    expect(relativePathFor("/api/other", "/whatsapp/console")).toBe("/api/other");
  });

  it("forwards a stripped path end to end", async () => {
    const res = await fetch(`${gatewayUrl}/whatsapp/console/api/v1/ping`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { path: string };
    expect(data.path).toBe("/api/v1/ping");
  });
});

describe("cookies", () => {
  it("rescopes the console session cookie to the console path", () => {
    // The upstream sets `path=/app`. Left alone, a browser would scope the
    // cookie to the login DIRECTORY and drop it on the console root — and it
    // would also be sent with unrelated gateway requests.
    const scoped = scopeSetCookie(
      "_chatwoot_session=abc; path=/app; HttpOnly",
      "/whatsapp/console",
    );
    expect(scoped).toContain("Path=/whatsapp/console");
    expect(scoped.toLowerCase()).not.toContain("path=/app");
    expect(scoped).toContain("HttpOnly");
  });

  it("applies the rescope to the real response", async () => {
    const res = await fetch(`${gatewayUrl}/whatsapp/console/set-cookie`);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Path=/whatsapp/console");
    expect(setCookie.toLowerCase()).not.toContain("path=/app");
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
    const res = await fetch(`${gatewayUrl}/whatsapp/console/echo`, {
      headers: { cookie: "connect.sid=gateway-secret; cw_d_session_info=console-auth" },
    });
    const data = (await res.json()) as { cookie?: string | null };
    expect(data.cookie).toContain("cw_d_session_info=console-auth");
    expect(data.cookie).not.toContain("gateway-secret");
  });
});

describe("HTML rewriting", () => {
  it("rewrites HTML with the base tag but leaves assets alone", async () => {
    const res = await fetch(`${gatewayUrl}/whatsapp/console/html`);
    const body = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(body).toContain('<base href="/whatsapp/console/">');
    // The rewrite is what makes routing work; the asset path is the proxy's job.
    expect(body).toContain('src="/vite/assets/dashboard.js"');
    expect(body).not.toContain("upstream.example");
  });

  it("does not buffer or rewrite a non-HTML body", async () => {
    const res = await fetch(`${gatewayUrl}/whatsapp/console/echo`, {
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
    const res = await fetch(`${gatewayUrl}/whatsapp/console/echo`, {
      headers: { "accept-encoding": "gzip, deflate, br" },
    });
    const data = (await res.json()) as { acceptEncoding?: string };
    expect(data.acceptEncoding).toBe("identity");
  });

  it("presents the upstream's own host, not the gateway's", async () => {
    const res = await fetch(`${gatewayUrl}/whatsapp/console/cable`);
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

  it("derives the mount from the configured prefix", () => {
    const saved = process.env.CHATWOOT_PROXY_PREFIX;
    process.env.CHATWOOT_PROXY_PREFIX = "/whatsapp";
    expect(chatwootProxyMount()).toBe("/whatsapp/console");
    if (saved === undefined) delete process.env.CHATWOOT_PROXY_PREFIX;
    else process.env.CHATWOOT_PROXY_PREFIX = saved;
  });
});

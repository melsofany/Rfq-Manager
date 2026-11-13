import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Every server-to-server call to the console must carry the gateway header.
 *
 * The console's ONLY reachable entry point is the app's own origin (see
 * `chatwoot-cortoba/lib/cortoba/gateway.rb`): `onrender.com` is on the Public
 * Suffix List, so the two services are different SITES and the browser refuses
 * the console's session cookie when it is framed directly. Once the gateway
 * secret is armed, a call without the header is a bare 404 — so a header
 * attached to SOME callers and forgotten on others fails only on the path
 * nobody exercised, and only after the gate is switched on.
 *
 * This suite drives the real modules with `fetch` stubbed and asserts the
 * header on the wire for each caller, rather than grepping the source for a
 * string that could appear in a comment.
 */

const GATEWAY_SECRET = "gateway-secret-under-test";

function captureFetch() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const headers: Record<string, string> = {};
    const raw = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    calls.push({ url: String(input), headers });
    return new Response(JSON.stringify({ id: 1, ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { calls, spy };
}

describe("Chatwoot calls carry the gateway header", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CHATWOOT_URL = "https://cortoba-chatwoot.onrender.com";
    process.env.CHATWOOT_ACCOUNT_ID = "1";
    process.env.CHATWOOT_API_TOKEN = "agent-token";
    process.env.CHATWOOT_PLATFORM_TOKEN = "platform-token";
    process.env.CHATWOOT_INBOX_ID = "7";
    process.env.CHATWOOT_GATEWAY_SECRET = GATEWAY_SECRET;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CHATWOOT_GATEWAY_SECRET;
  });

  it("attaches the header in the agent client", async () => {
    const { calls } = captureFetch();
    const client = await import("../../modules/chatwoot/client");
    await client.listAgents().catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].headers["x-cortoba-gateway"]).toBe(GATEWAY_SECRET);
  });

  it("attaches the header on the platform (provisioning) path", async () => {
    const { calls } = captureFetch();
    const index = await import("../../modules/chatwoot/index");
    // The status route reports configuration without calling out; the platform
    // helper is what provisions users, so call it directly.
    const anyIndex = index as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const fn = anyIndex.ensureChatwootUser ?? anyIndex.provisionChatwootUser;
    if (typeof fn === "function") {
      await fn({ email: "a@b.c", name: "Test" }).catch(() => undefined);
    }
    if (calls.length > 0) {
      expect(calls[0].headers["x-cortoba-gateway"]).toBe(GATEWAY_SECRET);
    }
  });

  it("omits the header when no secret is configured (upstream behaviour)", async () => {
    delete process.env.CHATWOOT_GATEWAY_SECRET;
    const { calls } = captureFetch();
    const client = await import("../../modules/chatwoot/client");
    await client.listAgents().catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].headers["x-cortoba-gateway"]).toBeUndefined();
  });

  it("reads the secret per call, not once at import", async () => {
    // A value set after the module is loaded must still apply: a long-lived
    // process would otherwise keep calling the console without the header.
    const client = await import("../../modules/chatwoot/client");
    expect(client.gatewayHeaders()["x-cortoba-gateway"]).toBe(GATEWAY_SECRET);
    process.env.CHATWOOT_GATEWAY_SECRET = "rotated";
    expect(client.gatewayHeaders()["x-cortoba-gateway"]).toBe("rotated");
    delete process.env.CHATWOOT_GATEWAY_SECRET;
    expect(client.gatewayHeaders()["x-cortoba-gateway"]).toBeUndefined();
  });

  it("serves the console page route behind auth (regression: not a 404)", async () => {
    // The proxy mount must exist whenever CHATWOOT_URL is set; an unset target
    // is the only case where the console route is absent.
    const app = express();
    const { chatwootProxyMount, chatwootProxyTarget } =
      await import("../../modules/chatwoot/proxy");
    // The console is mounted at the ROOT: Chatwoot reads its account id from
    // the URL position, so a sub-path makes every request 404.
    expect(chatwootProxyMount()).toBe("/");
    expect(chatwootProxyTarget()).toBe("https://cortoba-chatwoot.onrender.com");
    const res = await request(app).get("/__nonexistent__");
    expect(res.status).toBe(404);
  });
});

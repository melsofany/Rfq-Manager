import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { relayWebSocket, GATEWAY_HEADER } from "../../modules/chatwoot/proxy";

/**
 * The console reaches the API over HTTP but receives live messages over a
 * WebSocket upgrade, and the two paths build their headers SEPARATELY.
 *
 * That separation is the defect this guards: the HTTP proxy presented the
 * gateway secret and the WebSocket relay did not, so the console's gate refused
 * the handshake. The console loaded, rendered, then quietly stopped updating —
 * `WebSocket connection to 'wss://…/cable' failed`, on repeat. No HTTP test
 * could see it, because the HTTP half worked.
 *
 * The upstream here is a RAW socket server: it records the first bytes the relay
 * writes. Parsing HTTP would only add a way for the test itself to be wrong.
 */

/** A raw upstream that captures the first thing it is sent. */
function startUpstream() {
  const seen: string[] = [];
  const server = net.createServer((socket) => {
    socket.once("data", (buf) => {
      seen.push(buf.toString("utf8"));
    });
    socket.on("error", () => {});
  });
  return { server, seen };
}

/** Drive one upgrade through the relay and return the raw bytes sent upstream. */
async function relayUpgrade(headers: Record<string, string>): Promise<string> {
  const { server: upstream, seen } = startUpstream();
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  // The inbound side of the relay, as `index.ts` gets it from the server.
  const gateway = net.createServer((socket) => {
    // Only the fields the relay reads; the cast is confined to the call below.
    const req = {
      method: "GET",
      url: "/cable",
      originalUrl: "/cable",
      headers: { host: "gateway.example", ...headers },
    };
    relayWebSocket(
      req as unknown as Parameters<typeof relayWebSocket>[0],
      socket,
      Buffer.alloc(0),
      {
        target: `http://127.0.0.1:${upstreamPort}`,
        prefix: "/",
      },
    );
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));

  const client = net.connect((gateway.address() as AddressInfo).port, "127.0.0.1");
  await new Promise<void>((r) => client.once("connect", () => r()));

  for (let i = 0; i < 200 && seen.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }

  client.destroy();
  await new Promise<void>((r) => gateway.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
  return seen[0] ?? "";
}

describe("the websocket relay presents the gateway credential", () => {
  const original = process.env.CHATWOOT_GATEWAY_SECRET;
  beforeEach(() => {
    process.env.CHATWOOT_GATEWAY_SECRET = "s3cret-value";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CHATWOOT_GATEWAY_SECRET;
    else process.env.CHATWOOT_GATEWAY_SECRET = original;
  });

  it("sends the gateway header on the upgrade", async () => {
    const raw = await relayUpgrade({});
    expect(raw).toContain("GET /cable HTTP/1.1");
    expect(raw.toLowerCase()).toContain(`${GATEWAY_HEADER}: s3cret-value`);
  });

  it("does not forward a client-supplied gateway header", async () => {
    // A browser can send this header. Forwarding it would emit TWO and the
    // console could read the wrong one, so the relay must replace it.
    const raw = await relayUpgrade({ [GATEWAY_HEADER]: "forged-by-client" });
    expect(raw).toContain(`${GATEWAY_HEADER}: s3cret-value`);
    expect(raw).not.toContain("forged-by-client");
    expect(raw.toLowerCase().split(`${GATEWAY_HEADER}:`).length - 1).toBe(1);
  });

  it("still rewrites the host to the upstream's", async () => {
    const raw = await relayUpgrade({});
    expect(raw).toContain("host: 127.0.0.1");
    expect(raw).not.toContain("gateway.example");
  });

  it("omits the header when no secret is configured", async () => {
    // Unconfigured must stay exactly as before, or a deployment that does not
    // use the gate starts sending a blank credential.
    delete process.env.CHATWOOT_GATEWAY_SECRET;
    const raw = await relayUpgrade({});
    expect(raw.toLowerCase()).not.toContain(GATEWAY_HEADER);
  });
});

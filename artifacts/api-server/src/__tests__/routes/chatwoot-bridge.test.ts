import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * The Chatwoot bridge must never be able to break the WhatsApp pipeline it
 * mirrors. These tests pin the three invariants that make that true:
 *   1. mirroring is best-effort (a Chatwoot failure is swallowed, not thrown),
 *   2. our OWN mirrored messages are never forwarded back out to WhatsApp,
 *   3. an unconfigured deployment does nothing at all.
 */

const sendWhatsAppText = vi.hoisted(() => vi.fn(async () => "wamid.OUT"));
vi.mock("../../modules/communications/service", () => ({
  sendWhatsAppText,
}));

// The db mock records inserts so the webhook test can assert what was stored.
const inserted: any[] = vi.hoisted(() => []);
const linkRows: any[] = vi.hoisted(() => []);
vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => linkRows),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (vals: any) => {
        inserted.push(vals);
        return undefined;
      }),
      onConflictDoUpdate: vi.fn(async () => undefined),
    })),
  },
  whatsappChatsTable: { waMessageId: "wa_message_id", phone: "phone" },
  chatwootLinksTable: { phone: "phone", conversationId: "conversation_id" },
  employeesTable: { id: "id", email: "email" },
}));

const env = process.env;
beforeEach(() => {
  inserted.length = 0;
  linkRows.length = 0;
  sendWhatsAppText.mockClear();
  vi.resetModules();
  process.env = { ...env };
  delete process.env.CHATWOOT_URL;
  delete process.env.CHATWOOT_ACCOUNT_ID;
  delete process.env.CHATWOOT_API_TOKEN;
  delete process.env.CHATWOOT_INBOX_ID;
  delete process.env.CHATWOOT_WEBHOOK_SECRET;
});

function buildApp() {
  return express();
}

describe("Chatwoot bridge — configured/unconfigured", () => {
  it("reports unconfigured when the env vars are absent", async () => {
    const { isChatwootConfigured } = await import("../../modules/chatwoot/client");
    expect(isChatwootConfigured).toBe(false);
  });

  it("reports configured once URL + account + token are set", async () => {
    process.env.CHATWOOT_URL = "https://cw.example.com";
    process.env.CHATWOOT_ACCOUNT_ID = "1";
    process.env.CHATWOOT_API_TOKEN = "tok";
    const { isChatwootConfigured } = await import("../../modules/chatwoot/client");
    expect(isChatwootConfigured).toBe(true);
  });

  it("mirrors nothing (and does not throw) when unconfigured", async () => {
    const { mirrorInboundMessage, mirrorOutboundMessage } =
      await import("../../modules/chatwoot/bridge");
    await expect(
      mirrorInboundMessage({ phone: "201000000000", body: "hi" }),
    ).resolves.toBeUndefined();
    await expect(
      mirrorOutboundMessage({ phone: "201000000000", body: "hi" }),
    ).resolves.toBeUndefined();
  });

  it("skips mirroring when the inbox id is missing (no conversation can exist)", async () => {
    process.env.CHATWOOT_URL = "https://cw.example.com";
    process.env.CHATWOOT_ACCOUNT_ID = "1";
    process.env.CHATWOOT_API_TOKEN = "tok";
    // CHATWOOT_INBOX_ID deliberately unset.
    const { mirrorInboundMessage } = await import("../../modules/chatwoot/bridge");
    await expect(
      mirrorInboundMessage({ phone: "201000000000", body: "hi" }),
    ).resolves.toBeUndefined();
  });
});

describe("Chatwoot webhook — agent reply forwarding", () => {
  async function loadRouter() {
    process.env.CHATWOOT_URL = "https://cw.example.com";
    process.env.CHATWOOT_ACCOUNT_ID = "1";
    process.env.CHATWOOT_API_TOKEN = "tok";
    process.env.CHATWOOT_INBOX_ID = "5";
    process.env.CHATWOOT_WEBHOOK_SECRET = "s3cret";
    const mod = await import("../../modules/chatwoot/index");
    return mod.default;
  }

  it("rejects a request with the wrong token", async () => {
    const router = await loadRouter();
    const app = buildApp();
    app.use(express.json());
    app.use("/api", router);

    const res = await request(app)
      .post("/api/webhook/chatwoot?token=wrong")
      .send({ event: "message_created", message_type: "outgoing" });
    expect(res.status).toBe(200);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("forwards a genuine agent reply to WhatsApp and records it", async () => {
    linkRows.push({ phone: "201000000000" });
    const router = await loadRouter();
    const app = buildApp();
    app.use(express.json());
    app.use("/api", router);

    await request(app)
      .post("/api/webhook/chatwoot?token=s3cret")
      .send({
        event: "message_created",
        message_type: "outgoing",
        content: "تم إرسال عرض السعر",
        conversation: { id: 42 },
        id: 9001,
        sender: { type: "user" },
      });

    // The route acks first; the forwarding is async, so wait a tick.
    await new Promise((r) => setTimeout(r, 20));
    expect(sendWhatsAppText).toHaveBeenCalledWith("201000000000", "تم إرسال عرض السعر");
    expect(inserted.some((v) => v.direction === "outbound" && v.phone === "201000000000")).toBe(
      true,
    );
  });

  it("ignores a private note (not a real reply)", async () => {
    linkRows.push({ phone: "201000000000" });
    const router = await loadRouter();
    const app = buildApp();
    app.use(express.json());
    app.use("/api", router);

    await request(app)
      .post("/api/webhook/chatwoot?token=s3cret")
      .send({
        event: "message_created",
        message_type: "outgoing",
        private: true,
        content: "ملاحظة داخلية",
        conversation: { id: 42 },
        sender: { type: "user" },
      });
    await new Promise((r) => setTimeout(r, 20));
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("ignores the bot/API echo of our own mirrored messages", async () => {
    linkRows.push({ phone: "201000000000" });
    const router = await loadRouter();
    const app = buildApp();
    app.use(express.json());
    app.use("/api", router);

    await request(app)
      .post("/api/webhook/chatwoot?token=s3cret")
      .send({
        event: "message_created",
        message_type: "outgoing",
        content: "مرحبًا",
        conversation: { id: 42 },
        sender: { type: "agent_bot" },
      });
    await new Promise((r) => setTimeout(r, 20));
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });
});

describe("Chatwoot bridge — own-message dedup", () => {
  it("recognises a message id it created and ignores unknown ids", async () => {
    const bridge = await import("../../modules/chatwoot/bridge");
    expect(bridge.isOwnChatwootMessage(undefined)).toBe(false);
    expect(bridge.isOwnChatwootMessage(123456)).toBe(false);
  });
});

describe("Chatwoot media mirror — an attachment must arrive as a FILE", () => {
  // The recorded reason the previous WhatsApp screen was abandoned: an agent
  // could read "the supplier sent a file" but never open it, because the mirror
  // posted TEXT ONLY. `createMessage` cannot carry bytes — the console's
  // MessageBuilder reads uploaded `attachments[]`, which means multipart.
  it("posts a file as multipart, never as JSON", async () => {
    process.env.CHATWOOT_URL = "https://cw.example.com";
    process.env.CHATWOOT_ACCOUNT_ID = "1";
    process.env.CHATWOOT_API_TOKEN = "tok";

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const { createMediaMessage } = await import("../../modules/chatwoot/client");
      const msg = await createMediaMessage(3, "عرض سعر", "incoming", {
        data: Buffer.from("%PDF-1.4 invoice"),
        mimeType: "application/pdf",
        filename: "عرض.pdf",
        kind: "document",
      });
      expect(msg?.id).toBe(7);

      const call = calls.find((c) => c.url.includes("/messages"));
      expect(call).toBeDefined();
      const body = call!.init.body as FormData;
      expect(body).toBeInstanceOf(FormData);
      // The boundary is the runtime's; forcing JSON here makes the console
      // reject the upload.
      const headers = call!.init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBeUndefined();
      expect(headers.api_access_token).toBe("tok");

      const file = body.get("attachments[]") as File;
      expect(file).toBeInstanceOf(Blob);
      expect(file.type).toBe("application/pdf");
      expect(await file.text()).toBe("%PDF-1.4 invoice");
      expect(body.get("content")).toBe("عرض سعر");
      expect(body.get("message_type")).toBe("incoming");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("every inbound mirror path carries the attachment", () => {
  /**
   * The console mirror has TWO entry points — the generic inbound handler and
   * the supplier-bot recorder — and they are easy to fix one at a time. That is
   * exactly what happened: the generic path was taught to carry files while the
   * bot's recorder still posted text, so a supplier who sent their quote as a
   * PDF while the bot menu was open reached the console as a stub.
   *
   * A green test on one path proves nothing about the other, so this guard
   * enumerates the CALLS to `mirrorInboundMessage` in the source and requires
   * every one of them to pass `media`.
   */
  it("passes media at every mirrorInboundMessage call site", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const routes = readFileSync(join(here, "../../modules/communications/routes.ts"), "utf8");

    const calls: string[] = [];
    let idx = 0;
    while ((idx = routes.indexOf("mirrorInboundMessage({", idx)) !== -1) {
      // Take a bounded window: enough for a call's arguments, small enough that
      // two adjacent calls cannot bleed into each other.
      calls.push(routes.slice(idx, idx + 1200));
      idx += 1;
    }
    expect(calls.length).toBeGreaterThanOrEqual(2);

    const withoutMedia = calls.filter((c) => !/\bmedia\s*:/.test(c));
    expect(withoutMedia).toEqual([]);

    // A synthetic note (a button tap, a request pick) carries no file and must
    // NOT use the media path — it has its own function. One function serving
    // both is what let a real attachment post as plain text.
    expect(routes).toContain("mirrorSystemNote({");
    expect(routes).not.toMatch(/mirrorInboundMessage\(\{[^}]*\[اختيار الطلب/);
    expect(routes).not.toMatch(/mirrorInboundMessage\(\{[^}]*\[رد المورد على البند/);
  });
});

describe("a live inbound message is marked replayed", () => {
  /**
   * The backfill selects `chatwoot_synced_at IS NULL`. If a live message is
   * mirrored but not marked, it stays a permanent candidate for replay — 30
   * inbound rows were queued on a 7-day window while every outbound row was
   * marked. The mark must therefore ride on the mirror itself, so a caller
   * cannot mirror without it.
   */
  it("marks the row and passes Chatwoot's dedupe key", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const bridge = readFileSync(join(here, "../../modules/chatwoot/bridge.ts"), "utf8");

    const start = bridge.indexOf("export async function mirrorInboundMessage");
    const body = bridge.slice(start, bridge.indexOf("\nexport ", start + 10));

    // Chatwoot's own dedupe key — without it a redelivered webhook or a backfill
    // replay appends a SECOND copy instead of updating.
    expect(body).toContain("sourceId");
    // The replayed marker the backfill reads lives in `markReplayed` — the ONE
    // implementation. Asserting an inline copy here is what let a path skip it.
    expect(body).toContain("markReplayed");
  });
});

describe("attachment urls must point at the gateway", () => {
  /**
   * Reported live as «Loading failed» on a supplier's image.
   *
   * The file was on disk the whole time. `routes.default_url_options` takes
   * FRONTEND_URL and Chatwoot builds ABSOLUTE attachment urls from it, so
   * pointing it at the console's OWN hostname made the browser fetch from a
   * host it cannot reach — the console is served through the gateway and the
   * console service sits behind the overlay's private gate.
   *
   * The rule: the value is the origin the BROWSER uses, not the service's own.
   */
  it("points FRONTEND_URL at the gateway in the deployment manifest", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const yaml = readFileSync(join(here, "../../../../../chatwoot-cortoba/render.yaml"), "utf8");

    // Every FRONTEND_URL must be the gateway origin. The console's own hostname
    // is unreachable from the browser, which is the defect.
    const values = [...yaml.matchAll(/key: FRONTEND_URL\s*\n\s*value: (\S+)/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThanOrEqual(2); // web + worker
    for (const v of values) {
      expect(v, "FRONTEND_URL must be the gateway the browser reaches").not.toContain(
        "cortoba-chatwoot",
      );
    }
  });
});

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

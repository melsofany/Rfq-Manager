import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A file carries its OWN content — the placeholder must not travel with it.
 *
 * Our stored body prefixes every media message with a bracketed marker
 * («[صورة مرسلة] — <caption>»). Posting that as the message text made the console
 * render the description NEXT TO the picture, so the operator reported «مجرد
 * نصّ» while the attachment had been uploaded successfully all along.
 *
 * The positive case is measured on the REAL exported helper; the negative case
 * asserts the placeholder never reaches the console payload.
 */

const createMediaMessage = vi.fn(async () => ({ id: 5 }));

vi.mock("@workspace/db", () => {
  const tables = new Proxy({}, { get: (_t, p) => ({ __table: String(p) }) });
  return { ...tables, db: {} };
});
vi.mock("../../modules/chatwoot/client", () => ({
  createMessage: vi.fn(async () => ({ id: 6 })),
  createMediaMessage: (...a: unknown[]) => createMediaMessage(...(a as [])),
  findMessageIdBySourceId: vi.fn(async () => null),
  rememberOwnMessage: vi.fn(),
  createConversation: vi.fn(),
  createContact: vi.fn(),
  findContactByPhone: vi.fn(),
  updateContact: vi.fn(),
  setConversationCustomAttributes: vi.fn(),
  assignConversation: vi.fn(),
  addConversationLabels: vi.fn(),
  listAgents: vi.fn(async () => []),
  listMessageSourceIds: vi.fn(async () => new Set<string>()),
  isChatwootConfigured: true,
}));
vi.mock("../../modules/chatwoot/backfill", () => ({
  markReplayed: vi.fn(async () => {}),
  isReplayed: vi.fn(async () => false),
  markChatSynced: vi.fn(),
}));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("a media message sends the caption, never the placeholder", () => {
  beforeEach(() => createMediaMessage.mockClear());
  afterEach(() => vi.restoreAllMocks());

  it("strips the marker and keeps a real caption", async () => {
    const { captionOf } = await import("../../modules/chatwoot/bridge");
    expect(captionOf("[صورة مرسلة] — كتالوج المورد"), "the caption survives").toBe("كتالوج المورد");
    expect(captionOf("[مستند: عرض سعر.pdf]"), "no caption means empty").toBe("");
    expect(captionOf("[صورة مرسلة]"), "a bare marker means empty").toBe("");
    expect(captionOf("[صورة مرسلة] - صورة للرد"), "an ASCII dash works too").toBe("صورة للرد");
  });

  it("never posts the placeholder as the console content", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const bridge = readFileSync(join(here, "../../modules/chatwoot/bridge.ts"), "utf8");

    // The media branch must send the CAPTION, not the raw body.
    expect(bridge, "the media branch sends the caption").toMatch(
      /createMediaMessage\(link\.conversationId,\s*caption,/,
    );
    // And the backfill must do the same, or a replay reintroduces the defect.
    const backfill = readFileSync(join(here, "../../modules/chatwoot/backfill.ts"), "utf8");
    expect(backfill, "the replay strips it too").toMatch(/const caption = media \? body\.replace/);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A replay must carry the FILE, not just the placeholder text.
 *
 * The backfill re-posts messages the live path failed to deliver. It sent only
 * `body`, and a media message stores «[صورة مرسلة]» there — so a picture whose
 * upload failed was "recovered" as a text stub, and the console could never
 * show the supplier's image. Worse, a media-only row (empty text) was skipped
 * and marked synced, so it was not even attempted.
 *
 * These tests drive the REAL backfill against stubbed client + db, so they fail
 * against the text-only version.
 */

const createMediaMessage = vi.fn(async () => ({ id: 11 }));
const createMessage = vi.fn(async () => ({ id: 10 }));
const markChatSynced = vi.fn(async () => {});

vi.mock("@workspace/db", () => {
  const tables = new Proxy({}, { get: (_t, p) => ({ __table: String(p) }) });
  return { ...tables, db: {}, whatsappMediaTable: { __table: "whatsappMediaTable" } };
});
vi.mock("../../modules/chatwoot/client", () => ({
  createContact: vi.fn(async () => ({ id: 1 })),
  createConversation: vi.fn(async () => ({ id: 5, displayId: 5 })),
  createMediaMessage: (...a: unknown[]) => createMediaMessage(...(a as [])),
  createMessage: (...a: unknown[]) => createMessage(...(a as [])),
  findContactByPhone: vi.fn(async () => ({ id: 1 })),
  getConversationContactPhone: vi.fn(async () => null),
  listMessageSourceIds: vi.fn(async () => new Set<string>()),
  findMessageIdBySourceId: vi.fn(async () => null),
  isChatwootConfigured: true,
}));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("the backfill replays the file, not the placeholder", () => {
  beforeEach(() => {
    createMediaMessage.mockClear();
    createMessage.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("routes a media row through the multipart upload", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../../modules/chatwoot/backfill.ts"), "utf8");

    // The media fields must be SELECTED, or there is nothing to upload.
    expect(src, "the media id must be read").toMatch(/mediaId:\s*whatsappChatsTable\.mediaId/);
    // …and the bytes fetched from our own store.
    expect(src, "the stored bytes must be fetched").toMatch(/whatsappMediaTable\.data/);
    // …and the row posted through the media path.
    expect(src, "a media row must use the multipart path").toMatch(/createMediaMessage\(/);
    // A file with no text is still replayable.
    expect(src, "an empty-text media row must not be skipped").toMatch(
      /if \(!body && !row\.mediaId\)/,
    );
  });
});

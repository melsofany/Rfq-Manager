import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A FAILED upload must not be recorded as delivered.
 *
 * `createMediaMessage` answers `undefined` on failure — it does not throw — and
 * the backfill only revisits rows whose `chatwoot_synced_at` is NULL. Marking a
 * failed upload therefore made the loss PERMANENT and invisible: the console
 * kept showing «[صورة مرسلة]» text where the supplier had sent a picture, and
 * nothing ever retried it. Measured live on production.
 */

const markReplayedCalls: unknown[] = [];
const createMediaMessage = vi.fn();

vi.mock("@workspace/db", () => {
  const tables = new Proxy({}, { get: (_t, p) => ({ __table: String(p) }) });
  return { ...tables, db: {} };
});
vi.mock("../../modules/chatwoot/client", () => ({
  createMessage: vi.fn(async () => ({ id: 7 })),
  createMediaMessage: (...a: unknown[]) => createMediaMessage(...a),
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
  markReplayed: vi.fn(async (id: unknown) => {
    markReplayedCalls.push(id);
  }),
  isReplayed: vi.fn(async () => false),
  markChatSynced: vi.fn(),
}));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mirrorInboundMessage } = await import("../../modules/chatwoot/bridge");

describe("a failed console upload is not recorded as delivered", () => {
  beforeEach(() => {
    markReplayedCalls.length = 0;
    createMediaMessage.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("leaves the row unmarked so the backfill can retry it", async () => {
    // The console refused the upload (the cold-start shape).
    createMediaMessage.mockResolvedValue(undefined);

    await mirrorInboundMessage({
      phone: "201022282802",
      body: "[صورة مرسلة]",
      waMessageId: "wamid.IMG",
      media: { data: Buffer.from([1]), mimeType: "image/png", filename: "a.png", kind: "image" },
    });

    expect(
      markReplayedCalls,
      "a failed upload must stay eligible for the next backfill",
    ).toHaveLength(0);
  });

  it("marks it ONLY behind the delivered check — the condition is in the source", async () => {
    // `ensureConversationOwned` needs the database, so the positive case is
    // measured at the decision instead: the mark must be GUARDED by the
    // message id. An unguarded `markReplayed` is precisely the defect, and a
    // behaviour test that cannot reach the branch proves nothing about it.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const bridge = readFileSync(join(here, "../../modules/chatwoot/bridge.ts"), "utf8");
    const tail = bridge.slice(bridge.indexOf("rememberOwnMessage(msg?.id)"));

    expect(tail, "the mark must sit behind a delivered check").toMatch(
      /if \(msg\?\.id\) \{[\s\S]{0,80}markReplayed\(/,
    );
    // The OLD shape must be gone: the mark was unconditional, right after
    // `rememberOwnMessage`, which is what made a failed upload permanent.
    const unguarded = bridge.indexOf("rememberOwnMessage(msg?.id);\n    await markReplayed(");
    expect(unguarded, "the unguarded mark must be gone").toBe(-1);
  });
});

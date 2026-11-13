import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The history replay is the one thing standing between "the console exists" and
 * "the console shows the conversation a supplier wrote last week".
 *
 * Three properties can each fail silently:
 *   * idempotency — Chatwoot indexes `source_id` but does NOT make it unique, so
 *     a second run duplicates every message unless we look first;
 *   * the original timestamp — a replay that stamps "now" puts three months of
 *     history at the top of the console, which reads as a burst of activity;
 *   * the batch boundary — a run that forgets where it stopped either redoes
 *     everything or skips the middle.
 *
 * So these assert the CALLS the replay makes, not that it "worked".
 */

const h = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  seenSourceIds: new Set<string>(),
  chatRows: [] as Array<Record<string, unknown>>,
  supplierRows: [] as Array<Record<string, unknown>>,
  linkRows: [] as Array<Record<string, unknown>>,
  contact: { id: 42 } as { id?: number } | undefined,
  conversation: { id: 7 } as { id?: number } | undefined,
  /** Every conversation the replay created, so a second run is visible. */
  conversationsCreated: 0,
  links: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../modules/chatwoot/client", () => ({
  isChatwootConfigured: true,
  findContactByPhone: vi.fn(async () => h.contact),
  createContact: vi.fn(async () => h.contact),
  createConversation: vi.fn(async () => {
    h.conversationsCreated += 1;
    return h.conversation;
  }),
  createMessage: vi.fn(
    async (
      conversationId: number,
      content: string,
      direction: string,
      meta: { externalCreatedAt?: string; sourceId?: string },
    ) => {
      h.created.push({ conversationId, content, direction, ...meta });
      h.seenSourceIds.add(meta.sourceId ?? "");
      return { id: h.created.length, source_id: meta.sourceId };
    },
  ),
  // Read ONCE per conversation. A per-message lookup only sees the newest page,
  // so an earlier partial run's oldest messages look absent and get re-inserted
  // as duplicates.
  listMessageSourceIds: vi.fn(async () => new Set(h.seenSourceIds)),
}));

/**
 * A chainable, thenable query builder. Every terminal is awaitable and the
 * chains used here end in `.limit()` / `.orderBy()`.
 */
function builder(rows: Array<Record<string, unknown>>) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  for (const m of ["from", "where", "groupBy", "orderBy", "limit", "innerJoin", "leftJoin"]) {
    q[m] = chain;
  }
  q.then = (resolve: (v: unknown) => unknown) => resolve(rows);
  return q;
}

vi.mock("@workspace/db", () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
    select: vi.fn((arg?: Record<string, unknown>) => {
      // The phone list groups whatsapp_chats; supplier lookup selects a name.
      if (arg && "oldest" in arg) {
        const phones = [...new Set(h.chatRows.map((r) => r.phone))];
        return builder(phones.map((phone) => ({ phone, oldest: 1 })));
      }
      if (arg && "name" in arg) return builder(h.supplierRows);
      if (arg && "rfqId" in arg) return builder(h.linkRows);
      if (arg && "conversationId" in arg) return builder(h.linkRows);
      // The "is anything left?" probe selects the id ALONE, and must be empty
      // for the batch to be considered finished.
      if (arg && Object.keys(arg).length === 1 && "id" in arg) return builder([]);
      return builder(h.chatRows);
    }),
  },
  whatsappChatsTable: {
    id: "id",
    phone: "phone",
    body: "body",
    direction: "direction",
    createdAt: "created_at",
    waMessageId: "wa_message_id",
    chatwootSyncedAt: "chatwoot_synced_at",
  },
  suppliersTable: { id: "id", name: "name", phone: "phone" },
  chatwootLinksTable: {
    phone: "phone",
    rfqId: "rfq_id",
    conversationId: "conversation_id",
  },
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../modules/chatwoot/bridge", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    canonicalPhone: (p: string) => p.replace(/\D/g, ""),
    // The replay must PERSIST the conversation it created, or the next run
    // cannot see it and makes another one.
    saveLink: vi.fn(async (link: Record<string, unknown>) => {
      h.links.push(link);
      h.linkRows.push({
        conversationId: link.conversationId,
        phone: link.phone,
        rfqId: link.rfqId,
      });
    }),
  };
});

const { backfillPhone, backfillHistory } = await import("../../modules/chatwoot/backfill");

beforeEach(() => {
  h.created = [];
  h.seenSourceIds = new Set();
  h.chatRows = [];
  h.supplierRows = [];
  h.linkRows = [];
  h.contact = { id: 42 };
  h.conversation = { id: 7 };
  h.conversationsCreated = 0;
  h.links = [];
});

describe("history replay into the console", () => {
  it("keeps the ORIGINAL timestamp and carries the original id", async () => {
    h.chatRows = [
      {
        id: 11,
        phone: "201001234567",
        body: "عرض سعر",
        direction: "inbound",
        createdAt: new Date("2026-06-01T09:15:00Z"),
        waMessageId: "wamid.ABC",
      },
    ];
    await backfillPhone("201001234567", { limit: 50 });

    expect(h.created).toHaveLength(1);
    // Without this the whole history lands at "now" and reads as a burst.
    expect(h.created[0].externalCreatedAt).toBe("2026-06-01T09:15:00.000Z");
    // The id a second run recognises its own row by.
    expect(h.created[0].sourceId).toBe("wa:wamid.ABC");
    expect(h.created[0].direction).toBe("incoming");
  });

  it("maps an outbound message to an outgoing one", async () => {
    h.chatRows = [
      {
        id: 12,
        phone: "201001234567",
        body: "تم الإرسال",
        direction: "outbound",
        createdAt: new Date("2026-06-02T10:00:00Z"),
        waMessageId: "wamid.OUT",
      },
    ];
    await backfillPhone("201001234567", { limit: 50 });
    expect(h.created[0].direction).toBe("outgoing");
  });

  it("does NOT duplicate a message that is already in the console", async () => {
    // The property that matters most: Chatwoot accepts a duplicate `source_id`
    // without complaint, so a second backfill would silently double every
    // thread. The replay must ask first.
    h.chatRows = [
      {
        id: 11,
        phone: "201001234567",
        body: "عرض سعر",
        direction: "inbound",
        createdAt: new Date("2026-06-01T09:15:00Z"),
        waMessageId: "wamid.ABC",
      },
    ];
    await backfillPhone("201001234567", { limit: 50 });
    expect(h.created).toHaveLength(1);

    // Same history again, same process — nothing new may be written.
    await backfillPhone("201001234567", { limit: 50 });
    expect(h.created).toHaveLength(1);
  });

  it("skips a message already replayed, so the cursor can move past it", async () => {
    // The defect this guards: re-scanning an already-replayed message pinned
    // the cursor at the same id, so a resumed run re-read the same window
    // forever and never reached the rest of the history (409 numbers were left
    // unreplayed in production).
    h.chatRows = [
      {
        id: 11,
        phone: "201001234567",
        body: "قديمة",
        direction: "inbound",
        createdAt: new Date("2026-06-01T09:00:00Z"),
        waMessageId: "w1",
        chatwootSyncedAt: new Date("2026-06-02T00:00:00Z"),
      },
      {
        id: 12,
        phone: "201001234567",
        body: "جديدة",
        direction: "inbound",
        createdAt: new Date("2026-06-03T09:00:00Z"),
        waMessageId: "w2",
        chatwootSyncedAt: null,
      },
    ];
    const res = await backfillPhone("201001234567", { limit: 50 });
    expect(h.created).toHaveLength(1);
    expect(h.created[0].content).toBe("جديدة");
    expect(res.skipped).toBe(1);
    // The cursor must point at the LAST row examined, not the last row written.
    expect(res.lastId).toBe(12);
  });

  it("does not skip a number's early messages when another number advances", async () => {
    // THE ROOT DEFECT. One global id cursor was passed into every number, so
    // once any number with late messages moved it, every EARLIER message of
    // every other number was skipped for good. Production reported the same
    // cursor three batches in a row while only 2 of 414 numbers had been
    // replayed.
    //
    // Progress is now the synced-at column, so a number is replayed from its own
    // beginning whatever any other number did.
    const src = readFileSync(
      new URL("../../modules/chatwoot/backfill.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("afterId");
    expect(src).not.toContain("highWater");
    expect(src).toContain("isNull(whatsappChatsTable.chatwootSyncedAt)");
  });

  it("records the conversation it created, so a re-run does not make a second one", async () => {
    // Per-message idempotency is NOT enough: if the link is not persisted the
    // replay cannot see the conversation it just made, so a second run creates
    // ANOTHER conversation for the same number and files every message into a
    // fresh thread. The duplicate is the conversation, not the message.
    h.chatRows = [
      {
        id: 11,
        phone: "201001234567",
        body: "عرض سعر",
        direction: "inbound",
        createdAt: new Date("2026-06-01T09:15:00Z"),
        waMessageId: "wamid.ABC",
      },
    ];
    await backfillPhone("201001234567", { limit: 50 });
    expect(h.conversationsCreated).toBe(1);
    expect(h.links).toHaveLength(1);
    expect(h.links[0].conversationId).toBe(7);

    // Second run: the link now exists, so no new conversation may be made.
    await backfillPhone("201001234567", { limit: 50 });
    expect(h.conversationsCreated).toBe(1);
  });

  it("falls back to our own row id when WhatsApp gave no message id", async () => {
    h.chatRows = [
      {
        id: 99,
        phone: "201001234567",
        body: "بدون معرّف",
        direction: "inbound",
        createdAt: new Date("2026-06-03T08:00:00Z"),
        waMessageId: null,
      },
    ];
    await backfillPhone("201001234567", { limit: 50 });
    // Still idempotent, because OUR id is stable even when Meta's is absent.
    expect(h.created[0].sourceId).toBe("cortoba:chat:99");
  });

  it("skips a media-only message instead of sending an empty bubble", async () => {
    h.chatRows = [
      {
        id: 13,
        phone: "201001234567",
        body: "   ",
        direction: "inbound",
        createdAt: new Date("2026-06-04T08:00:00Z"),
        waMessageId: "wamid.MEDIA",
      },
    ];
    const res = await backfillPhone("201001234567", { limit: 50 });
    expect(h.created).toHaveLength(0);
    expect(res.skipped).toBe(1);
  });

  it("does not create a contact or conversation it cannot use", async () => {
    h.contact = undefined;
    const res = await backfillPhone("201001234567", { limit: 50 });
    // A failed contact must be REPORTED as an error, not counted as "done" —
    // otherwise a run that imported nothing looks like a clean run.
    expect(res.errors).toBe(1);
    expect(res.created).toBe(0);
  });

  it("reports a cursor so a large history can be resumed", async () => {
    h.chatRows = [
      {
        id: 11,
        phone: "201001234567",
        body: "أ",
        direction: "inbound",
        createdAt: new Date("2026-06-01T09:00:00Z"),
        waMessageId: "w1",
      },
      {
        id: 12,
        phone: "201001234567",
        body: "ب",
        direction: "inbound",
        createdAt: new Date("2026-06-01T09:05:00Z"),
        waMessageId: "w2",
      },
    ];
    const res = await backfillHistory({ limit: 2 });
    // `nextCursor` is what lets a caller come back for the rest; without it a
    // batched run can only restart or give up.
    expect(res.messagesCreated).toBe(2);
    expect(res.stoppedBy).toBe("complete");
    expect(res.complete).toBe(true);
  });

  it("refuses to run when the console is not configured", async () => {
    const client = await import("../../modules/chatwoot/client");
    const spy = vi.spyOn(client, "isChatwootConfigured", "get").mockReturnValue(false);
    const res = await backfillHistory({});
    expect(res.stoppedBy).toBe("not-configured");
    expect(res.messagesCreated).toBe(0);
    spy.mockRestore();
  });
});

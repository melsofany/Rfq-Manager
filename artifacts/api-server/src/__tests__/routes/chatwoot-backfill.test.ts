import { describe, it, expect, vi, beforeEach } from "vitest";

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
}));

vi.mock("../../modules/chatwoot/client", () => ({
  isChatwootConfigured: true,
  findContactByPhone: vi.fn(async () => h.contact),
  createContact: vi.fn(async () => h.contact),
  createConversation: vi.fn(async () => h.conversation),
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
  findMessageBySourceId: vi.fn(async (_c: number, sourceId: string) =>
    h.seenSourceIds.has(sourceId) ? { id: 1, source_id: sourceId } : undefined,
  ),
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
  return { ...actual, canonicalPhone: (p: string) => p.replace(/\D/g, "") };
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

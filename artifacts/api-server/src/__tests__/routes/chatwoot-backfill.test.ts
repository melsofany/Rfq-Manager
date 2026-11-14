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
  contactArgs: { name: "", phone: "" },
  lastWhere: undefined as unknown,
  lastFrom: undefined as unknown,
  conversationExists: "201000000000" as string | null,
  seenSourceIds: new Set<string>(),
  chatRows: [] as Array<Record<string, unknown>>,
  supplierRows: [] as Array<Record<string, unknown>>,
  sentLogRows: [] as Array<Record<string, unknown>>,
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
  getConversationContactPhone: vi.fn(async () => h.conversationExists),
  createContact: vi.fn(async (name: string, phone: string) => {
    h.contactArgs = { name, phone };
    return h.contact;
  }),
  createConversation: vi.fn(async () => {
    h.conversationsCreated += 1;
    // A conversation that has just been created EXISTS from now on, so the
    // messages that follow are accepted. Leaving it "dead" would make the mock
    // reject the very replacement the code just made.
    if (h.conversationExists === null && h.conversation?.id) {
      h.conversationExists = String(h.conversation.id);
    }
    return h.conversation;
  }),
  createMessage: vi.fn(
    async (
      conversationId: number,
      content: string,
      direction: string,
      meta: { externalCreatedAt?: string; sourceId?: string },
    ) => {
      // A message into a conversation the console does NOT have answers 404
      // there, and the real client returns undefined for it. Without this the
      // mock accepted every send and the "dead conversation" guard could never
      // fail — the mock has to reproduce the failure it claims to guard.
      if (h.conversationExists === null) return undefined;
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
  // Record the predicate instead of second-guessing it. The mock cannot see
  // what the source query asked for, so filtering here would make the query
  // invisible and let a guard pass against unfiltered code. The CALL is what
  // these tests assert (see the file header), so the caller's WHERE is captured
  // and inspected directly.
  q.where = (arg: unknown) => {
    h.lastWhere = arg;
    return q;
  };
  // Two different queries select the same `{ rfqId }` shape — the link lookup
  // and the supplier's `sent_log` — so the FROM table is what tells them apart.
  q.from = (t: unknown) => {
    h.lastFrom = t;
    q.__from = t;
    return q;
  };
  q.then = (resolve: (v: unknown) => unknown) => resolve(rowsFor(q.__from, rows));
  return q;
}

/** Resolve a builder's rows, honouring the table the caller selected FROM. */
function rowsFor(from: unknown, rows: Array<Record<string, unknown>>) {
  if (from && typeof from === "object" && (from as { __table?: string }).__table === "sent_log") {
    return h.sentLogRows;
  }
  return rows;
}

/** Does a drizzle predicate ask for NULLs in `chatwoot_synced_at`? */
function asksForUnreplayed(pred: unknown): boolean {
  const text = JSON.stringify(pred, (_k, v) =>
    v && typeof v === "object" && v.constructor?.name === "StringChunk" ? String(v.value) : v,
  );
  return /is null/i.test(text) && /chatwoot_synced_at/.test(text);
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
      // The replay's own query asks for the rows STILL OWING a replay
      // (`isNull(chatwoot_synced_at)`), so the mock must not hand back rows that
      // are already done. Without this the "does not re-read" guard could never
      // fail: the code would receive the done rows and the assertion would pass
      // against the unfiltered query too.
      return builder(h.chatRows.filter((r) => !r.chatwootSyncedAt));
    }),
  },
  whatsappChatsTable: {
    __table: "whatsapp_chats",
    id: "id",
    phone: "phone",
    body: "body",
    direction: "direction",
    createdAt: "created_at",
    waMessageId: "wa_message_id",
    chatwootSyncedAt: "chatwoot_synced_at",
  },
  suppliersTable: { __table: "suppliers", id: "id", name: "name", phone: "phone" },
  sentLogTable: { __table: "sent_log", id: "id", supplierId: "supplier_id", rfqId: "rfq_id" },
  chatwootLinksTable: {
    __table: "chatwoot_links",
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
    // The REAL canonicalPhone, not a stubbed one. A stub that only stripped
    // non-digits hid the E.164 defect: production sends a local number
    // (`01001234567`) and the real function expands it to `20…`, which is what
    // Chatwoot demands. A mock must reproduce the failure it claims to guard.
    canonicalPhone: actual.canonicalPhone,
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
  h.sentLogRows = [];
  h.linkRows = [];
  h.contact = { id: 42 };
  h.conversation = { id: 7 };
  h.conversationsCreated = 0;
  h.links = [];
  h.contactArgs = { name: "", phone: "" };
  h.lastWhere = undefined;
  h.lastFrom = undefined;
  h.conversationExists = "201000000000";
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
    // The already-replayed row is filtered OUT by the query itself, so it is not
    // counted as a skip either — the batch's budget goes to work, not to
    // re-reading history (which is what froze the replay at 20 numbers).
    expect(h.created[0].content).toBe("جديدة");
    // The already-replayed row never enters the window (the query filters it),
    // so it is not counted as a skip and the budget is not spent on it.
    expect(res.skipped).toBe(0);
  });

  it("files the conversation under the supplier's own request, not 0", async () => {
    // THE DEFECT THAT LEFT 413 OF 414 CONVERSATIONS WITH `rfqId: 0`. The link
    // table is empty on a fresh console, and it was the ONLY source, so every
    // replayed conversation arrived unfiled and the console could not answer
    // "which request is this?". The supplier's `sent_log` is the authority.
    h.chatRows = [
      {
        id: 301,
        phone: "201001234567",
        body: "سعر الحربة",
        direction: "inbound",
        createdAt: new Date("2026-06-02T09:00:00Z"),
        waMessageId: "w301",
        chatwootSyncedAt: null,
      },
    ];
    h.linkRows = []; // nothing filed yet — the fresh-console case
    h.supplierRows = [{ id: 167, name: "هاي فولت", phone: "201001234567" }];
    h.sentLogRows = [{ rfqId: 777 }];
    await backfillPhone("201001234567", { limit: 10 });
    // The conversation is created against the supplier's request, and the link
    // row records it so the console can show the RFQ number.
    const saved = h.links.find((l) => l.phone === "201001234567");
    expect(saved?.rfqId).toBe(777);
  });

  it("does not spend the batch re-reading messages it already replayed", async () => {
    // THE DEFECT THAT FROZE THE REPLAY AT 20 NUMBERS. The window was the OLDEST
    // `limit` rows of the number, replayed or not, so a number with 100 done of
    // its 125 returned those 100 again, the batch spent itself skipping them,
    // and the 394 numbers behind it were never reached — `phonesConsidered: 20`
    // on every batch forever.
    const done = Array.from({ length: 5 }, (_, i) => ({
      id: 100 + i,
      phone: "201001234567",
      body: `قديم ${i}`,
      direction: "inbound",
      createdAt: new Date("2026-06-01T09:00:00Z"),
      waMessageId: `old${i}`,
      chatwootSyncedAt: new Date("2026-06-01T10:00:00Z"),
    }));
    h.chatRows = [
      ...done,
      {
        id: 200,
        phone: "201001234567",
        body: "جديد",
        direction: "inbound",
        createdAt: new Date("2026-06-02T09:00:00Z"),
        waMessageId: "new1",
        chatwootSyncedAt: null,
      },
    ];
    const res = await backfillPhone("201001234567", { limit: 10 });
    // The one message still owing a replay is the one that is replayed.
    expect(res.created).toBe(1);
    // …and the five already done are not re-read to fill the window.
    expect(res.skipped).toBe(0);
    // The window is defined by the QUERY, so assert the query: it must ask for
    // the rows whose `chatwoot_synced_at` is still NULL. Without this the guard
    // would pass on a mock that filtered by itself while the real SQL read the
    // whole history — which is exactly how the defect reached production.
    expect(asksForUnreplayed(h.lastWhere)).toBe(true);
  });

  it("replaces a conversation the console no longer has, instead of spinning", async () => {
    // THE DEFECT THAT MADE THE REPLAY SPIN FOREVER. A stored link pointed at a
    // conversation Chatwoot no longer had (its database was reset while our link
    // rows survived). Every message then answered 404, so nothing was ever
    // marked as replayed, the same 20 numbers were re-read on every batch, and
    // the run reported `messagesCreated: 0, errors: 12` forever.
    h.chatRows = [
      {
        id: 9,
        phone: "201001234567",
        body: "استفسار",
        direction: "inbound",
        createdAt: new Date("2026-06-02T09:00:00Z"),
        waMessageId: "w10",
        chatwootSyncedAt: null,
      },
    ];
    h.linkRows = [{ conversationId: 3, phone: "201001234567", rfqId: 0 }];
    // The console answers 404 for the stored conversation.
    h.conversationExists = null;
    const res = await backfillPhone("201001234567", { limit: 10 });
    // A replacement conversation is created and the message is delivered into
    // it — rather than failing against the dead id on every run.
    expect(res.created).toBe(1);
    expect(res.errors).toBe(0);
  });

  it("creates the contact with (name, phone), never the swap", async () => {
    // THE DEFECT THAT KILLED THE LIVE RUN. createContact takes (name, phone) —
    // two adjacent strings, so the compiler cannot see a swap — and the backfill
    // passed (phone, name). Chatwoot then received the SUPPLIER NAME as the phone
    // number and answered «Phone number should be in e164 format» for every
    // contact, so all 409 numbers errored and nothing was replayed.
    h.chatRows = [
      {
        id: 5,
        phone: "201001234567",
        body: "مرحبا",
        direction: "inbound",
        createdAt: new Date("2026-06-01T09:00:00Z"),
        waMessageId: "w9",
        chatwootSyncedAt: null,
      },
    ];
    // No existing contact, or the code reuses it and never calls createContact.
    h.contact = undefined;
    // A REAL supplier name, so the two arguments differ and the swap is visible.
    // With no supplier the fallback makes both arguments the phone number, and
    // the guard would pass against the swapped code.
    // A LOCAL Egyptian number, as `whatsapp_chats.phone` really stores it. A
    // bare `01001234567` is not E.164 and Chatwoot refuses it with «Phone number
    // should be in e164 format» — the second live failure after the swap.
    h.supplierRows = [{ id: 3, name: "شركة ساجدة ستور", phone: "201001234567" }];
    await backfillPhone("01001234567", { limit: 10 });
    // The second argument must be the NUMBER, in international form. Swapped, it
    // is a name; un-normalised, it lacks the country code and the plus.
    expect(h.contactArgs.phone).toBe("+201001234567");
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

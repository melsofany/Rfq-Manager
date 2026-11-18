import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A supplier replied to a message and the console showed «رسالة غير موجودة».
 *
 * Root cause, measured on production: an outbound message's own `wamid` is what
 * the supplier's reply quotes back in `context.id`, and we were not storing it.
 * 2,980 outbound rows carried `wa_message_id IS NULL`, including EVERY
 * interactive menu — the «طلبات التسعير» list the supplier actually replied to
 * was not in the table at all (0 greeting rows), so no lookup could ever
 * resolve it. Chatwoot solves the same problem by writing the id at send time
 * (`message.update!(source_id: message_id)`); this is the equivalent layer.
 *
 * These tests guard the WRITE, which is what makes the quote resolvable, plus
 * the two privacy rules that constrain it: an assistant conversation and a
 * representative's thread must never appear in the shared supplier inbox.
 */

const inserted: any[] = [];
const insertedTables: any[] = [];
let assistantPhones = new Set<string>();
let repRows: Array<{ phone: string | null; isActive: boolean | null }> = [];
let existingIds: string[] = [];

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      insert: vi.fn((table: any) => {
        insertedTables.push(table);
        const api: any = {
          values: vi.fn((v: any) => {
            inserted.push(v);
            api.onConflictDoNothing = vi.fn(() => Promise.resolve());
            api.onConflictDoUpdate = vi.fn(() => Promise.resolve());
            api.then = (r: any) => Promise.resolve().then(r);
            return api;
          }),
          then: (r: any) => Promise.resolve().then(r),
        };
        return api;
      }),
      select: vi.fn(() => {
        const api: any = {
          from: vi.fn(() => api),
          where: vi.fn(() => api),
          limit: vi.fn(() => Promise.resolve(existingIds.map((id) => ({ id })))),
          then: (r: any) =>
            Promise.resolve(
              // `isAiAssistantPhone` reads aiAssistantUsersTable; the rep guard
              // reads representativesTable. Both come through this one builder,
              // so the rows served depend on which table was selected.
              repRows.map((x) => ({ phone: x.phone, isActive: x.isActive })),
            ).then(r),
        };
        return api;
      }),
    },
  };
});

vi.mock("../../modules/ai-assistant/config", () => ({
  isAiAssistantPhone: vi.fn(async (phone: string) => assistantPhones.has(phone)),
  canonicalPhone: (p: string) => (p || "").replace(/\D/g, ""),
  resetAiPhoneCache: vi.fn(),
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { recordOutboundMessage } = await import("../../modules/communications/service");

const WAMID = "wamid.HBgMMjAxMDk0NjQxNTA1FQIAERgSNDAzRjBGNzVFNEE5NzYzRTFGAA==";

beforeEach(() => {
  inserted.length = 0;
  insertedTables.length = 0;
  assistantPhones = new Set();
  repRows = [];
  existingIds = [];
  vi.clearAllMocks();
});

describe("recordOutboundMessage — the reply-quote key is stored", () => {
  it("stores the wamid so the supplier's reply can resolve it", async () => {
    await recordOutboundMessage({
      phone: "201094641505",
      waMessageId: WAMID,
      body: "[قالب: supplier_greeting_ar]",
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].waMessageId).toBe(WAMID);
    expect(inserted[0].direction).toBe("outbound");
    expect(inserted[0].phone).toBe("201094641505");
  });

  it("does nothing without a wamid — a row with no id is the bug being fixed", async () => {
    await recordOutboundMessage({ phone: "201094641505", waMessageId: null, body: "x" });
    await recordOutboundMessage({ phone: "201094641505", waMessageId: "", body: "x" });
    expect(inserted).toHaveLength(0);
  });

  it("carries the supplier link so the console shows a name, not a number", async () => {
    await recordOutboundMessage({
      phone: "201094641505",
      waMessageId: WAMID,
      body: "[أمر شراء PDF: PO-2026-000098]",
      supplierId: 42,
      mediaType: "document",
      filename: "PO-2026-000098.pdf",
    });
    expect(inserted[0].supplierId).toBe(42);
    expect(inserted[0].mediaType).toBe("document");
    expect(inserted[0].filename).toBe("PO-2026-000098.pdf");
  });
});

describe("recordOutboundMessage — the shared inbox stays private", () => {
  it("never records a conversation with the AI assistant", async () => {
    assistantPhones.add("201098888170");
    await recordOutboundMessage({
      phone: "201098888170",
      waMessageId: WAMID,
      body: "[تقرير]",
    });
    expect(inserted).toHaveLength(0);
  });

  it("never records a representative's internal bot thread", async () => {
    // A rep's menu is an internal conversation, not supplier mail. One rep
    // already has 189 rows in the shared inbox; recording outbound rows without
    // this guard would add every menu the bot sends.
    repRows = [{ phone: "201022282802", isActive: true }];
    await recordOutboundMessage({
      phone: "201022282802",
      waMessageId: WAMID,
      body: "[قائمة: استلام/تسليم]",
    });
    expect(inserted).toHaveLength(0);
  });

  it("still records a real supplier whose number is not on either list", async () => {
    repRows = [{ phone: "201022282802", isActive: true }];
    assistantPhones.add("201098888170");
    await recordOutboundMessage({
      phone: "201155351999",
      waMessageId: WAMID,
      body: "[RFQ CRQ-2026-000368]",
    });
    expect(inserted).toHaveLength(1);
  });
});

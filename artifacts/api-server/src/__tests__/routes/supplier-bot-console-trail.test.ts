import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The supplier bot must leave the SAME trail in the console as the generic
 * inbound handler.
 *
 * The bot answers BEFORE `handleInboundMessage` runs, so it consumes the
 * supplier's message: whatever the bot does not record itself is never recorded
 * at all. The failure this guards is silent and employee-facing — the supplier
 * types a price, the bot stores it in a draft, and the employee opens the
 * Chatwoot conversation to find an empty thread with no idea a quote arrived.
 *
 * These tests drive the REAL handler, so they fail against a bot that answers
 * without recording (verified by reverting `recordSupplierBotInbound`).
 */

const selectCalls: Array<{ table: unknown; args: unknown }> = [];
const insertCalls: Array<{ table: unknown; values: Record<string, unknown> }> = [];
const mirrorInboundCalls: Array<Record<string, unknown>> = [];

vi.mock("@workspace/db", () => {
  const supplier = { id: 7, name: "مورد الاختبار", phone: "201000000007" };
  const tables = new Proxy({}, { get: (_t, prop) => ({ __table: String(prop) }) });
  return {
    ...tables,
    suppliersTable: { id: "sup.id", name: "sup.name", phone: "sup.phone" },
    whatsappChatsTable: { id: "wc.id", waMessageId: "wc.wa_message_id" },
    supplierBotSessionsTable: { phone: "s.phone" },
    supplierItemDraftsTable: { id: "d.id" },
    rfqTable: {
      id: "rfq.id",
      internalRfqNo: "rfq.no",
      customerRfqNo: "rfq.crno",
      status: "rfq.status",
      requiredResponseDate: "rfq.rrd",
    },
    rfqItemsTable: { id: "ri.id", rfqId: "ri.rfq_id" },
    sentLogTable: {
      id: "sl.id",
      rfqId: "sl.rfq_id",
      supplierId: "sl.supplier_id",
      closeDate: "sl.close_date",
    },
    offersTable: { id: "o.id" },
    offerItemsTable: { id: "oi.id" },
    db: {
      select: () => chainable(),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          insertCalls.push({ table, values });
          return Promise.resolve();
        },
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      delete: () => ({ where: () => Promise.resolve() }),
    },
    __supplier: supplier,
  };
});

/**
 * Drizzle builders are awaitable anywhere, so the chain must be thenable.
 * `limit()` and awaiting the builder both resolve to the queued rows.
 */
function chainable() {
  const rows: unknown[] = [];
  const obj: Record<string, unknown> = {};
  const pass = () => obj;
  obj.from = pass;
  obj.where = pass;
  obj.innerJoin = pass;
  obj.leftJoin = pass;
  obj.orderBy = pass;
  obj.groupBy = pass;
  obj.limit = () => Promise.resolve(rows);
  obj.then = (r: (v: unknown) => unknown) => Promise.resolve(rows).then(r);
  return obj;
}

vi.mock("../../modules/communications/service", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // Keep the REAL module (its exports are imported at load time by routes.ts)
  // and override only the senders, so no test ever touches the WhatsApp API.
  const stub = async () => "wamid.stub";
  return {
    ...actual,
    sendSupplierBotMainMenu: stub,
    sendSupplierBotRequestList: stub,
    sendSupplierBotItemList: stub,
    sendSupplierBotItemDetail: stub,
    sendSupplierBotItemSummary: stub,
    sendSupplierBotConfirm: stub,
    sendWhatsAppText: stub,
    sendWhatsAppInteractiveConfirmation: stub,
  };
});

vi.mock("../../modules/chatwoot/bridge", () => ({
  supplierByPhone: vi.fn(async () => ({ id: 7, name: "مورد الاختبار", phone: "201000000007" })),
  mirrorInboundMessage: vi.fn(async (o: Record<string, unknown>) => {
    mirrorInboundCalls.push(o);
  }),
  mirrorOutboundMessage: vi.fn(async () => {}),
  isChatwootConfigured: true,
  isOwnChatwootMessage: () => false,
  canonicalPhone: (p: string) => p.replace(/[^\d]/g, ""),
  phoneForConversation: vi.fn(async () => null),
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { handleSupplierBotMessage } = await import("../../modules/communications/routes");

beforeEach(() => {
  selectCalls.length = 0;
  insertCalls.length = 0;
  mirrorInboundCalls.length = 0;
  vi.clearAllMocks();
});

/** A supplier's plain-text message, as Meta delivers it. */
function textMessage(body: string) {
  return { id: `wamid.${body}`, type: "text", text: { body } } as never;
}

describe("the supplier bot leaves a trail the employee can read", () => {
  it("records the supplier's message so the console thread is not empty", async () => {
    const handled = await handleSupplierBotMessage("201000000007", textMessage("عندكم كام؟"));

    expect(handled).toBe(true);
    // The message must reach the console: either recorded locally, mirrored, or
    // both — an empty thread is the defect.
    const recorded = insertCalls.some((c) => c.values?.direction === "inbound");
    const mirrored = mirrorInboundCalls.length > 0;
    expect(recorded || mirrored).toBe(true);
  });

  it("mirrors the supplier's message into the console with its phone", async () => {
    await handleSupplierBotMessage("201000000007", textMessage("السعر 120"));

    expect(mirrorInboundCalls.length).toBeGreaterThan(0);
    expect(String(mirrorInboundCalls[0].phone)).toContain("201000000007");
  });

  it("keeps the supplier's own words, not a placeholder", async () => {
    await handleSupplierBotMessage("201000000007", textMessage("متاح بسعر 120 جنيه"));

    const seen = [
      ...insertCalls.map((c) => String(c.values?.body ?? "")),
      ...mirrorInboundCalls.map((m) => String(m.body ?? "")),
    ].join(" | ");
    expect(seen).toContain("120");
  });
});

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
const mirrorOutboundCalls: Array<Record<string, unknown>> = [];
// Every `sendWhatsAppText` call, recorded with its recipient: the assertion that
// matters for the human-agent notice is WHO was told, not merely that a message
// was sent somewhere.
const sendTextCalls: Array<{ to: string; body: string }> = [];
// The employee notice is recorded at its own boundary. It lives INSIDE the
// service module and calls `sendWhatsAppText` through the module-internal
// binding, so overriding the export would not intercept it — the notification
// itself must be observed instead.
const employeeNoticeCalls: Array<Record<string, unknown>> = [];

vi.mock("@workspace/db", () => {
  const supplier = { id: 7, name: "مورد الاختبار", phone: "201000000007" };
  const tables = new Proxy({}, { get: (_t, prop) => ({ __table: String(prop) }) });

  // One object is both `db` and the transaction handle, so the real
  // confirmation flow runs against the same recording mock.
  const dbMock: Record<string, unknown> = {
    select: () => ({ from: (t: unknown) => chainable(t) }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        insertCalls.push({ table, values });
        // Drizzle's `insert(...).values(...).returning()` is awaited.
        const done = Promise.resolve([{ id: 1 }]) as Promise<unknown[]> & {
          returning?: () => Promise<unknown[]>;
        };
        done.returning = () => Promise.resolve([{ id: 1 }]);
        return done;
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMock),
  };

  return {
    ...tables,
    suppliersTable: {
      __table: "suppliersTable",
      id: "sup.id",
      name: "sup.name",
      phone: "sup.phone",
    },
    whatsappChatsTable: {
      __table: "whatsappChatsTable",
      id: "wc.id",
      waMessageId: "wc.wa_message_id",
    },
    supplierBotSessionsTable: { __table: "supplierBotSessionsTable", phone: "s.phone" },
    supplierItemDraftsTable: { __table: "supplierItemDraftsTable", id: "d.id" },
    employeesTable: {
      __table: "employeesTable",
      id: "e.id",
      name: "e.name",
      phone: "e.phone",
      role: "e.role",
      isActive: "e.is_active",
    },
    rfqTable: {
      __table: "rfqTable",
      id: "rfq.id",
      internalRfqNo: "rfq.no",
      customerRfqNo: "rfq.crno",
      status: "rfq.status",
      requiredResponseDate: "rfq.rrd",
    },
    rfqItemsTable: { __table: "rfqItemsTable", id: "ri.id", rfqId: "ri.rfq_id" },
    sentLogTable: {
      __table: "sentLogTable",
      id: "sl.id",
      rfqId: "sl.rfq_id",
      supplierId: "sl.supplier_id",
      closeDate: "sl.close_date",
    },
    offersTable: { id: "o.id" },
    offerItemsTable: { id: "oi.id" },
    db: dbMock,
    __supplier: supplier,
  };
});

/**
 * Drizzle builders are awaitable anywhere, so the chain must be thenable.
 * `limit()` and awaiting the builder both resolve to the queued rows.
 */
const rowsByTable: Record<string, unknown[]> = {};
function chainable(table: unknown) {
  const name = (table as { __table?: string })?.__table ?? "";
  const rows = rowsByTable[name] ?? [];
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
  // `sendWhatsAppText` RECORDS its recipient: the human-agent notice is only
  // proven by showing the EMPLOYEE's number was messaged, which a bare stub
  // cannot express.
  const recordText = async (to: string, body: string) => {
    sendTextCalls.push({ to: String(to), body: String(body) });
    return "wamid.stub";
  };
  return {
    ...actual,
    sendSupplierBotMainMenu: stub,
    sendSupplierBotRequestList: stub,
    sendSupplierBotItemList: stub,
    sendSupplierBotItemDetail: stub,
    sendSupplierBotItemSummary: stub,
    sendSupplierBotConfirm: stub,
    sendWhatsAppText: recordText,
    sendWhatsAppInteractiveConfirmation: stub,
    // Recorded at the notice's OWN boundary: it calls `sendWhatsAppText` through
    // the module-internal binding, so overriding that export would not intercept
    // it and the test would "prove" nothing.
    notifyEmployeeOfSupplierRequest: async (
      to: string,
      opts: Record<string, unknown>,
    ): Promise<string> => {
      employeeNoticeCalls.push({ to, ...opts });
      return "wamid.stub";
    },
  };
});

vi.mock("../../modules/chatwoot/bridge", () => ({
  supplierByPhone: vi.fn(async () => ({ id: 7, name: "مورد الاختبار", phone: "201000000007" })),
  // `requestHumanAgent` resolves the responsible employee through this list, so
  // the mock must answer it or the notice would never be addressed to anyone.
  openPricingRequestsForSupplier: vi.fn(async () => [
    { rfqId: 55, rfqNo: "RFQ-2026-000055", employeeId: 4, employeeName: "سارة" },
  ]),
  mirrorInboundMessage: vi.fn(async (o: Record<string, unknown>) => {
    mirrorInboundCalls.push(o);
  }),
  mirrorOutboundMessage: vi.fn(async (o: Record<string, unknown>) => {
    mirrorOutboundCalls.push(o);
  }),
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
  mirrorOutboundCalls.length = 0;
  sendTextCalls.length = 0;
  employeeNoticeCalls.length = 0;
  for (const k of Object.keys(rowsByTable)) delete rowsByTable[k];
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

describe("a human-agent request actually reaches the employee", () => {
  it("notifies the responsible employee on WhatsApp, not only the SSE stream", async () => {
    // The supplier is told «تم تحويل طلبك إلى <الموظف> وسيتواصل معك». That
    // promise was previously backed by an SSE broadcast alone, which reaches
    // only a portal page that happens to be OPEN — with nobody watching, the
    // request sat unseen while the supplier waited. The employee must be
    // reached on their own phone.
    rowsByTable.employeesTable = [{ phone: "201111111111" }];
    rowsByTable.rfqTable = [{ id: 55, internalRfqNo: "RFQ-2026-000055" }];
    rowsByTable.suppliersTable = [{ name: "مورد الاختبار" }];

    const handled = await handleSupplierBotMessage("201000000007", {
      id: "wamid.agent",
      type: "interactive",
      interactive: { button_reply: { id: "sup_menu:agent" } },
    } as never);

    expect(handled).toBe(true);
    // The notice is addressed to the EMPLOYEE — the assertion that matters is
    // WHO was told. A notice nobody receives is the defect under guard.
    expect(employeeNoticeCalls.length).toBeGreaterThan(0);
    expect(String(employeeNoticeCalls[0].to)).toBe("201111111111");
    expect(String(employeeNoticeCalls[0].supplierName)).toContain("مورد الاختبار");
  });

  it("still answers the supplier when no employee phone is on file", async () => {
    // A missing phone is a data gap, not a reason to leave the supplier with
    // silence. The acknowledgement must still go out.
    rowsByTable.employeesTable = [];

    const handled = await handleSupplierBotMessage("201000000007", {
      id: "wamid.agent2",
      type: "interactive",
      interactive: { button_reply: { id: "sup_menu:agent" } },
    } as never);

    expect(handled).toBe(true);
    expect(employeeNoticeCalls.length).toBe(0);
    const toSupplier = sendTextCalls.filter((c) => c.to === "201000000007");
    expect(toSupplier.length).toBeGreaterThan(0);
  });
});

describe("a submitted quote reaches the console", () => {
  it("puts the priced items in the thread, with the prices and the phone", async () => {
    // The employee reviews the offer in Chatwoot. A bare acknowledgement there
    // means they must open the RFQ screen to learn what was quoted — the quote
    // itself has to be in the thread.
    const { mirrorSupplierQuoteToConsole } = await import("../../modules/communications/routes");

    rowsByTable.sentLogTable = [{ id: 1 }];
    rowsByTable.rfqItemsTable = [
      { id: 900, lineItem: "10", partNo: "PN-1", description: "قاطع 30A", uom: "قطعة", qty: "5" },
    ];
    rowsByTable.supplierItemDraftsTable = [
      { rfqItemId: 900, unitPrice: "120", currency: "EGP", deliveryDays: 7 },
    ];

    await mirrorSupplierQuoteToConsole(
      { id: 7, name: "مورد الاختبار" },
      "201000000007",
      55,
      "RFQ-2026-000055",
    );

    expect(mirrorOutboundCalls.length).toBe(1);
    const body = String(mirrorOutboundCalls[0].body ?? "");
    // The price, the item it belongs to, and the request number — the three
    // things the employee needs to review the offer.
    expect(body).toContain("120");
    expect(body).toContain("PN-1");
    expect(body).toContain("RFQ-2026-000055");
    expect(String(mirrorOutboundCalls[0].phone)).toContain("201000000007");
  });

  it("wires the mirror into the CONFIRMATION itself, not just the helper", async () => {
    // The defect this catches: the helper works and is never called. A test that
    // invokes `mirrorSupplierQuoteToConsole` directly passes even when the
    // confirmation path never uses it, so the employee still sees nothing.
    rowsByTable.sentLogTable = [{ id: 1, employeeId: null }];
    rowsByTable.rfqTable = [{ id: 55, no: "RFQ-2026-000055" }];
    rowsByTable.rfqItemsTable = [
      { id: 900, lineItem: "10", partNo: "PN-1", description: "قاطع 30A", uom: "قطعة", qty: "5" },
    ];
    rowsByTable.supplierItemDraftsTable = [
      { rfqItemId: 900, unitPrice: "120", currency: "EGP", deliveryDays: 7 },
    ];
    rowsByTable.supplierBotSessionsTable = [
      { phone: "201000000007", supplierId: 7, rfqId: 55, rfqItemId: 900, step: "await_price" },
    ];
    rowsByTable.offersTable = [];
    rowsByTable.offerItemsTable = [];

    const msg = {
      id: "wamid.confirm",
      type: "interactive",
      interactive: { button_reply: { id: "sup_confirm:1", title: "إرسال" } },
    } as never;
    await handleSupplierBotMessage("201000000007", msg);

    // The quote must reach the console as a result of the confirmation.
    const bodies = mirrorOutboundCalls.map((m) => String(m.body ?? "")).join(" | ");
    expect(bodies).toContain("120");
    expect(bodies).toContain("RFQ-2026-000055");
  });

  it("does not post an empty summary when nothing was priced", async () => {
    const { mirrorSupplierQuoteToConsole } = await import("../../modules/communications/routes");
    rowsByTable.sentLogTable = [{ id: 1 }];
    rowsByTable.rfqItemsTable = [{ id: 900, partNo: "PN-1", description: "قاطع" }];
    rowsByTable.supplierItemDraftsTable = [];

    await mirrorSupplierQuoteToConsole(
      { id: 7, name: "مورد الاختبار" },
      "201000000007",
      55,
      "RFQ-2026-000055",
    );

    expect(mirrorOutboundCalls.length).toBe(0);
  });
});

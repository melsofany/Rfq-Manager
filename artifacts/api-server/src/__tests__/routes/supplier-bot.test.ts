import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WhatsApp interactive supplier bot.
 *
 * Two classes of defect matter more than the happy path, and both are the kind
 * this repository has already been bitten by:
 *
 *   1. CROSS-SUPPLIER LEAKAGE — a supplier reading another supplier's requests,
 *      items or prices. The queries are scoped by `supplierId` in the WHERE
 *      clause, and these tests drive the REAL query builders to prove the scope
 *      is applied rather than trusting a filter downstream.
 *
 *   2. A DRAFT PRESENTED AS A QUOTATION — a half-typed WhatsApp answer becoming
 *      a price an employee approves. Confirmation is the only path to an offer,
 *      and the offer it writes is UNAPPROVED.
 *
 * The parsing tests are here because a bot that cannot read «١٢٠» or «120 جنيه»
 * re-asks the same question forever, which is how a supplier abandons the flow.
 */

// ── A DB mock that records the queries it is asked ───────────────────────────
// Recording the WHERE arguments is the point: a mock that returns rows directly
// cannot tell a scoped query from an unscoped one, so a test asserting "supplier
// B cannot see supplier A's items" would pass against an unscoped query.
const selectCalls: Array<{ table: unknown; args: unknown }> = [];
let selectQueue: unknown[][] = [];

function chainable(resolveWith: () => unknown) {
  const obj: Record<string, unknown> = {};
  const passthrough = () => obj;
  obj.from = (table: unknown) => {
    selectCalls.push({ table, args: null });
    return obj;
  };
  obj.where = (args: unknown) => {
    if (selectCalls.length > 0) selectCalls[selectCalls.length - 1].args = args;
    return obj;
  };
  obj.innerJoin = passthrough;
  obj.leftJoin = passthrough;
  obj.orderBy = passthrough;
  obj.groupBy = passthrough;
  obj.limit = () => Promise.resolve(resolveWith());
  obj.then = (r: (v: unknown) => unknown) => Promise.resolve(resolveWith()).then(r);
  return obj;
}

const draftsStore = new Map<string, Record<string, unknown>>();
const insertCalls: Array<{ table: unknown; values: unknown }> = [];
const updateCalls: Array<{ table: unknown; set: unknown }> = [];
const deleteCalls: Array<{ table: unknown }> = [];

vi.mock("@workspace/db", () => {
  const rfqTable = {
    id: "rfq.id",
    internalRfqNo: "rfq.internal_rfq_no",
    status: "rfq.status",
    customerRfqNo: "rfq.customer_rfq_no",
    requiredResponseDate: "rfq.rrd",
  };
  const rfqItemsTable = {
    id: "rfq_items.id",
    rfqId: "rfq_items.rfq_id",
    lineItem: "li",
    partNo: "pn",
    description: "desc",
    uom: "uom",
    qty: "qty",
  };
  const sentLogTable = {
    id: "sl.id",
    rfqId: "sl.rfq_id",
    supplierId: "sl.supplier_id",
    employeeId: "sl.employee_id",
    closeDate: "sl.close_date",
    offerSubmitted: "sl.offer_submitted",
  };
  const offersTable = {
    id: "o.id",
    rfqId: "o.rfq_id",
    supplierId: "o.supplier_id",
    employeeId: "o.employee_id",
  };
  const offerItemsTable = { id: "oi.id", offerId: "oi.offer_id" };
  const supplierItemDraftsTable = {
    id: "d.id",
    rfqId: "d.rfq_id",
    rfqItemId: "d.rfq_item_id",
    supplierId: "d.supplier_id",
    availability: "d.availability",
    unitPrice: "d.unit_price",
    currency: "d.currency",
    deliveryDays: "d.delivery_days",
    originCountry: "d.origin_country",
    brand: "d.brand",
    notes: "d.notes",
    attachmentMediaId: "d.ami",
    attachmentName: "d.an",
  };
  const supplierBotSessionsTable = {
    phone: "s.phone",
    supplierId: "s.supplier_id",
    rfqId: "s.rfq_id",
    rfqItemId: "s.rfq_item_id",
    step: "s.step",
  };

  const insertBuilder = (table: unknown) => ({
    values: (v: unknown) => {
      insertCalls.push({ table, values: v });
      const rec = v as Record<string, unknown>;
      const key = `${rec.rfqId}:${rec.rfqItemId}:${rec.supplierId}`;
      const storeInsert = () => {
        if (table === supplierItemDraftsTable) draftsStore.set(key, { ...rec });
      };
      return {
        // Faithful to Postgres: on conflict the INSERT values are DISCARDED and
        // only the listed `set` columns are applied to the existing row. Storing
        // the insert values first would "prove" a bug that does not exist — and
        // would hide the real one, where a later answer erases an earlier one.
        onConflictDoUpdate: (cfg: unknown) => {
          const c = cfg as { set?: Record<string, unknown> };
          if (table === supplierItemDraftsTable) {
            if (draftsStore.has(key)) {
              draftsStore.set(key, { ...(draftsStore.get(key) ?? {}), ...(c.set ?? {}) });
            } else {
              storeInsert();
            }
          }
          return Promise.resolve();
        },
        returning: () => {
          storeInsert();
          return Promise.resolve([{ id: 501, ...rec }]);
        },
        then: (r: (v: unknown) => unknown) => {
          storeInsert();
          return Promise.resolve().then(r);
        },
      };
    },
  });

  const tx = {
    select: () => chainable(() => selectQueue.shift() ?? []),
    insert: insertBuilder,
    update: (table: unknown) => ({
      set: (s: unknown) => {
        updateCalls.push({ table, set: s });
        return { where: () => Promise.resolve() };
      },
    }),
    delete: (table: unknown) => ({
      where: () => {
        deleteCalls.push({ table });
        return Promise.resolve();
      },
    }),
  };

  return {
    db: {
      select: () => chainable(() => selectQueue.shift() ?? []),
      insert: insertBuilder,
      update: (table: unknown) => ({
        set: (s: unknown) => {
          updateCalls.push({ table, set: s });
          return { where: () => Promise.resolve() };
        },
      }),
      delete: (table: unknown) => ({
        where: () => {
          deleteCalls.push({ table });
          return Promise.resolve();
        },
      }),
      transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    },
    rfqTable,
    rfqItemsTable,
    sentLogTable,
    offersTable,
    offerItemsTable,
    supplierItemDraftsTable,
    supplierBotSessionsTable,
  };
});

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ __eq: [col, val] }),
  and: (...a: unknown[]) => ({ __and: a }),
  or: (...a: unknown[]) => ({ __or: a }),
  desc: (c: unknown) => ({ __desc: c }),
  asc: (c: unknown) => ({ __asc: c }),
  inArray: (c: unknown, v: unknown) => ({ __inArray: [c, v] }),
  ne: (c: unknown, v: unknown) => ({ __ne: [c, v] }),
  ilike: (c: unknown, v: unknown) => ({ __ilike: [c, v] }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ __sql: [strings, values] }),
    {},
  ),
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const bot = await import("../../modules/communications/supplier-bot");

beforeEach(() => {
  selectCalls.length = 0;
  insertCalls.length = 0;
  deleteCalls.length = 0;
  updateCalls.length = 0;
  draftsStore.clear();
  selectQueue = [];
  vi.clearAllMocks();
});

/** Collect every column referenced by an `eq(...)` in a (possibly nested) where. */
function eqColumns(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== "object") return out;
  const n = node as Record<string, unknown>;
  if (n.__eq) {
    out.push((n.__eq as unknown[])[0]);
    return out;
  }
  if (n.__and) for (const c of n.__and as unknown[]) eqColumns(c, out);
  if (n.__or) for (const c of n.__or as unknown[]) eqColumns(c, out);
  if (n.__inArray) out.push((n.__inArray as unknown[])[0]);
  if (n.__ne) out.push((n.__ne as unknown[])[0]);
  return out;
}

// ── Parsing: a bot that cannot read the answer re-asks forever ───────────────

describe("parsePrice", () => {
  it("reads the shapes a supplier actually types", () => {
    expect(bot.parsePrice("120")).toBe(120);
    expect(bot.parsePrice("120.50")).toBe(120.5);
    expect(bot.parsePrice("1,250")).toBe(1250);
    expect(bot.parsePrice("120 جنيه")).toBe(120);
    expect(bot.parsePrice("120 EGP")).toBe(120);
    expect(bot.parsePrice("السعر 350.75 ج")).toBe(350.75);
  });

  it("reads Arabic-Indic digits, which an Arabic keyboard produces", () => {
    expect(bot.parsePrice("١٢٠")).toBe(120);
    expect(bot.parsePrice("٢٥٠٫٥")).toBe(250);
    expect(bot.parsePrice("۳۰۰")).toBe(300);
  });

  it("returns null rather than zero when there is no number", () => {
    // A zero here would be stored as a real quote and drag every average down.
    expect(bot.parsePrice("")).toBeNull();
    expect(bot.parsePrice("متاح")).toBeNull();
    expect(bot.parsePrice("0")).toBeNull();
    expect(bot.parsePrice("-5")).toBeNull();
  });
});

describe("parseAvailability", () => {
  it("checks the negative FIRST — «غير متاح» contains «متاح»", () => {
    expect(bot.parseAvailability("غير متاح")).toBe("unavailable");
    expect(bot.parseAvailability("مش متاح")).toBe("unavailable");
    expect(bot.parseAvailability("not available")).toBe("unavailable");
  });

  it("reads the positive forms", () => {
    expect(bot.parseAvailability("متاح")).toBe("available");
    expect(bot.parseAvailability("موجود")).toBe("available");
    expect(bot.parseAvailability("available")).toBe("available");
  });

  it("returns null for anything else instead of guessing", () => {
    expect(bot.parseAvailability("")).toBeNull();
    expect(bot.parseAvailability("سأرد لاحقاً")).toBeNull();
  });
});

describe("parseDeliveryDays", () => {
  it("reads days in the forms typed", () => {
    expect(bot.parseDeliveryDays("7")).toBe(7);
    expect(bot.parseDeliveryDays("7 أيام")).toBe(7);
    expect(bot.parseDeliveryDays("١٤")).toBe(14);
  });
  it("rejects nonsense rather than storing it", () => {
    expect(bot.parseDeliveryDays("قريباً")).toBeNull();
    expect(bot.parseDeliveryDays("0")).toBeNull();
    expect(bot.parseDeliveryDays("99999")).toBeNull();
  });
});

describe("isSkip", () => {
  it("recognises the skip words for optional steps", () => {
    expect(bot.isSkip("تخطي")).toBe(true);
    expect(bot.isSkip("تخطى")).toBe(true);
    expect(bot.isSkip("skip")).toBe(true);
    expect(bot.isSkip("-")).toBe(true);
    expect(bot.isSkip("مصر")).toBe(false);
  });
});

describe("itemLabel", () => {
  it("prefers the part number, then the line item, then the description", () => {
    expect(bot.itemLabel({ partNo: "P-1", lineItem: "L-1", description: "d" })).toContain("P-1");
    expect(bot.itemLabel({ partNo: null, lineItem: "L-1", description: "d" })).toContain("L-1");
    expect(bot.itemLabel({ partNo: null, lineItem: null, description: "valve" })).toBe("valve");
  });

  it("truncates a long description so a WhatsApp list row fits", () => {
    const long = "x".repeat(200);
    expect(bot.itemLabel({ description: long }).length).toBeLessThanOrEqual(60);
  });
});

// ── Scoping: the security invariant ──────────────────────────────────────────

describe("supplier scoping (a supplier must never see another's data)", () => {
  it("scopes the open-request list by supplierId in the WHERE clause", async () => {
    selectQueue = [[], []]; // sentLog rows, then item rows
    await bot.listSupplierOpenRequests(42);
    const scoped = selectCalls.some((c) =>
      eqColumns(c.args).some((col) => col === "sl.supplier_id"),
    );
    expect(scoped).toBe(true);
  });

  it("refuses to list items when the request was not sent to this supplier", async () => {
    // The authorisation select returns nothing -> no items, no matter what the
    // item table holds.
    selectQueue = [[]];
    const items = await bot.listSupplierRequestItems(99, 7);
    expect(items).toEqual([]);
  });

  it("authorises by the sent-log pair, and fails CLOSED when the check throws", async () => {
    selectQueue = [[{ id: 1 }]];
    const ok = await bot.supplierMayAnswer(42, 7);
    expect(ok.ok).toBe(true);

    // An unverifiable authorisation is not an authorisation.
    const original = selectQueue;
    selectQueue = undefined as unknown as unknown[][];
    const failed = await bot.supplierMayAnswer(42, 7);
    expect(failed.ok).toBe(false);
    selectQueue = original;
  });
});

// ── Drafts: partial answers must accumulate, never overwrite ─────────────────

describe("draft accumulation", () => {
  it("refuses to write a draft for an item that is not in the request", async () => {
    // The item id arrives in a WhatsApp payload, so it is caller-supplied. Every
    // write goes through `upsertDraft`, which is therefore the one place that can
    // guarantee a draft is only ever created for an item that really belongs to
    // the (supplier, request) pair. Without this a crafted payload could plant a
    // draft against another request's line.
    selectQueue = [
      [{ id: 1 }], // the sent-log row: this supplier IS entitled to this request
      [{ id: 10 }], // ...but the request contains ONLY item 10
    ];
    await expect(bot.upsertDraft(1, 2, 999, { unitPrice: 50 })).rejects.toThrow();
    expect(draftsStore.size).toBe(0);
  });

  it("writes a draft for an item that IS in the request", async () => {
    selectQueue = [[{ id: 1 }], [{ id: 10 }]];
    await bot.upsertDraft(1, 2, 10, { unitPrice: 50 });
    expect(draftsStore.get("2:10:1")).toBeTruthy();
  });

  it("keeps previously answered fields when a later answer arrives", async () => {
    selectQueue = [[{ id: 1 }], [{ id: 3 }]];
    await bot.upsertDraft(1, 2, 3, { unitPrice: 120 });
    selectQueue = [[{ id: 1 }], [{ id: 3 }]];
    await bot.upsertDraft(1, 2, 3, { deliveryDays: 7 });
    const stored = draftsStore.get("2:3:1");
    // The second write must not erase the first — that is what makes
    // «استكمال الرد لاحقاً» work. NUMERIC comes back as a string, as Postgres
    // returns it, so the assertion compares the value not the JS type.
    expect(Number(stored?.unitPrice)).toBe(120);
    expect(stored?.deliveryDays).toBe(7);
  });

  it("counts an item as answered only when it carries a PRICE", async () => {
    selectQueue = [
      [{ id: 1 }], // authorisation
      [
        { id: 10, rfqId: 2, lineItem: null, partNo: "A", description: "a", uom: "pc", qty: "1" },
        { id: 11, rfqId: 2, lineItem: null, partNo: "B", description: "b", uom: "pc", qty: "1" },
      ], // items
      [
        {
          rfqItemId: 10,
          supplierId: 1,
          rfqId: 2,
          availability: "available",
          unitPrice: "50",
          currency: "EGP",
          deliveryDays: null,
          originCountry: null,
          brand: null,
          notes: null,
        },
      ], // drafts
    ];
    const s = await bot.summariseDrafts(1, 2);
    // «متاح» alone is not an answer — the price is what makes it a quote.
    expect(s.pricedCount).toBe(1);
    expect(s.totalCount).toBe(2);
    expect(s.unanswered.map((u) => u.rfqItemId)).toEqual([11]);
  });
});

// ── Confirmation: the only path from a message to a price ────────────────────

describe("confirmDrafts", () => {
  it("refuses when nothing is priced, instead of writing an empty offer", async () => {
    selectQueue = [
      [{ id: 1 }],
      [{ id: 10, rfqId: 2, lineItem: null, partNo: "A", description: "a", uom: "pc", qty: "1" }],
      [],
    ];
    const r = await bot.confirmDrafts(1, 2);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_priced_items");
    // Nothing was written.
    expect(insertCalls.filter((c) => (c.values as { rfqId?: unknown })?.rfqId === 2)).toEqual([]);
  });

  it("writes the offer UNAPPROVED so an employee still reviews it", async () => {
    selectQueue = [
      [{ id: 1 }], // authorisation (listSupplierRequestItems)
      [{ id: 10, rfqId: 2, lineItem: null, partNo: "A", description: "a", uom: "pc", qty: "1" }], // items
      [
        {
          rfqItemId: 10,
          supplierId: 1,
          rfqId: 2,
          availability: "available",
          unitPrice: "120",
          currency: "EGP",
          deliveryDays: 5,
          originCountry: "مصر",
          brand: "X",
          notes: "n",
        },
      ], // drafts
      // inside the transaction:
      [{ id: 1, employeeId: 9 }], // sent log
      [], // existing offer
      [], // its prior offer_items (none)
      [{ status: "SENT" }], // rfq status
    ];
    const r = await bot.confirmDrafts(1, 2);
    expect(r.ok).toBe(true);
    expect(r.savedItems).toBe(1);

    const offerInsert = insertCalls.find((c) => {
      const v = c.values as { totalPrice?: unknown };
      return v && "totalPrice" in v;
    });
    expect(offerInsert).toBeTruthy();
    // The offer itself must not be marked approved anywhere.
    const values = offerInsert?.values as Record<string, unknown>;
    expect(values.isApproved).toBeUndefined();

    const itemInsert = insertCalls.find((c) => {
      const v = c.values as { offerId?: unknown; price?: unknown };
      return v && "offerId" in v && "price" in v;
    });
    expect(itemInsert).toBeTruthy();
    // Still false — a WhatsApp message is not a signed quotation.
    expect((itemInsert?.values as Record<string, unknown>).taxIncluded).toBe(false);
  });

  it("carries origin/brand/currency into the offer item's notes", async () => {
    selectQueue = [
      [{ id: 1 }],
      [{ id: 10, rfqId: 2, lineItem: null, partNo: "A", description: "a", uom: "pc", qty: "1" }],
      [
        {
          rfqItemId: 10,
          supplierId: 1,
          rfqId: 2,
          availability: "available",
          unitPrice: "120",
          currency: "USD",
          deliveryDays: 5,
          originCountry: "ألمانيا",
          brand: "Siemens",
          notes: "أصلي",
        },
      ],
      [{ id: 1, employeeId: 9 }],
      [],
      [], // prior offer_items
      [{ status: "SENT" }],
    ];
    await bot.confirmDrafts(1, 2);
    const itemInsert = insertCalls.find((c) => {
      const v = c.values as { offerId?: unknown; price?: unknown };
      return v && "offerId" in v && "price" in v;
    });
    const notes = (itemInsert?.values as Record<string, unknown>).notes as string;
    expect(notes).toContain("ألمانيا");
    expect(notes).toContain("Siemens");
    expect(notes).toContain("USD");
  });

  it("does NOT delete the offer's existing items — that would wipe an employee's approval", async () => {
    // `is_approved` marks the approved supplier price, which is the reference
    // cost the customer-rfq margin check and the RFQ KPIs read. Re-confirming
    // from WhatsApp used to DELETE every offer_item and re-insert them, silently
    // discarding an approval an employee had already made. The supplier is
    // restating their own prices; they are not entitled to un-approve them.
    selectQueue = [
      [{ id: 1 }],
      [{ id: 10, rfqId: 2, lineItem: null, partNo: "A", description: "a", uom: "pc", qty: "1" }],
      [
        {
          rfqItemId: 10,
          supplierId: 1,
          rfqId: 2,
          availability: "available",
          unitPrice: "120",
          currency: "EGP",
          deliveryDays: 5,
          originCountry: null,
          brand: null,
          notes: null,
        },
      ],
      [{ id: 1, employeeId: 9 }], // sent log
      [{ id: 77, employeeId: 9 }], // an EXISTING offer
      [], // its prior offer_items (none yet)
      [{ status: "SENT" }],
    ];
    const r = await bot.confirmDrafts(1, 2);
    expect(r.ok).toBe(true);
    expect(r.offerId).toBe(77);

    // The offer row is updated in place (its `set` carries totalPrice)...
    const offerUpdate = updateCalls.find(
      (c) => (c.set as { totalPrice?: unknown })?.totalPrice !== undefined,
    );
    expect(offerUpdate).toBeTruthy();
    // ...and its items are NOT wiped.
    expect(deleteCalls).toEqual([]);
  });

  it("keeps an approval when the price is unchanged, and updates the line in place", async () => {
    selectQueue = [
      [{ id: 1 }],
      [{ id: 10, rfqId: 2, lineItem: null, partNo: "A", description: "a", uom: "pc", qty: "1" }],
      [
        {
          rfqItemId: 10,
          supplierId: 1,
          rfqId: 2,
          availability: "available",
          unitPrice: "120",
          currency: null,
          deliveryDays: 5,
          originCountry: null,
          brand: null,
          notes: null,
        },
      ],
      [{ id: 1, employeeId: 9 }],
      [{ id: 77, employeeId: 9 }],
      [{ id: 900, rfqItemId: 10, price: "120", isApproved: true }], // same price, approved
      [{ status: "SENT" }],
    ];
    const r = await bot.confirmDrafts(1, 2);
    expect(r.ok).toBe(true);
    expect(r.approvalsCleared).toBe(0);
    expect(deleteCalls).toEqual([]);
    // The line is UPDATED (its `set` carries a price), not re-inserted.
    expect(updateCalls.some((c) => (c.set as { price?: unknown })?.price === "120")).toBe(true);
    // ...and the approval is not touched.
    const approvalUpdate = updateCalls.find(
      (c) => (c.set as { isApproved?: unknown })?.isApproved !== undefined,
    );
    expect(approvalUpdate).toBeUndefined();
    // No new offer_item row was inserted for an item that already had one.
    const itemInsert = insertCalls.find((c) => {
      const v = c.values as { offerId?: unknown; price?: unknown };
      return v && "offerId" in v && "price" in v;
    });
    expect(itemInsert).toBeUndefined();
  });

  it("releases an approval when the supplier RESTATES the price", async () => {
    // An approval is an approval OF A PRICE. Leaving it set after the price moves
    // would make `is_approved` a reference cost that no longer matches the quoted
    // figure — a silently-wrong number the margin check and KPIs would trust.
    selectQueue = [
      [{ id: 1 }],
      [{ id: 10, rfqId: 2, lineItem: null, partNo: "A", description: "a", uom: "pc", qty: "1" }],
      [
        {
          rfqItemId: 10,
          supplierId: 1,
          rfqId: 2,
          availability: "available",
          unitPrice: "150", // the supplier restated it
          currency: null,
          deliveryDays: 5,
          originCountry: null,
          brand: null,
          notes: null,
        },
      ],
      [{ id: 1, employeeId: 9 }],
      [{ id: 77, employeeId: 9 }],
      [{ id: 900, rfqItemId: 10, price: "120", isApproved: true }], // was 120, approved
      [{ status: "SENT" }],
    ];
    const r = await bot.confirmDrafts(1, 2);
    expect(r.ok).toBe(true);
    expect(r.approvalsCleared).toBe(1);
    expect(deleteCalls).toEqual([]);
    const approvalUpdate = updateCalls.find(
      (c) => (c.set as { isApproved?: unknown })?.isApproved === false,
    );
    expect(approvalUpdate).toBeTruthy();
  });

  it("writes the SAME items the confirmation screen showed", async () => {
    // The screen's ✅ list and the written rows come from one classification, so
    // an item shown as answered must be the one that lands in the offer.
    const items = [
      { id: 10, lineItem: null, partNo: "A", description: "a", uom: "pc", qty: "1", draft: null },
      { id: 11, lineItem: null, partNo: "B", description: "b", uom: "pc", qty: "1", draft: null },
    ];
    const drafts = new Map([
      [
        10,
        {
          availability: "available",
          unitPrice: "120",
          currency: null,
          deliveryDays: null,
          originCountry: null,
          brand: null,
          notes: null,
        },
      ],
    ]);
    const s = bot.classifyDrafts(items, drafts);
    expect(s.answered.map((a) => a.rfqItemId)).toEqual([10]);
    expect(s.unanswered.map((u) => u.rfqItemId)).toEqual([11]);
  });
});

describe("step ladder", () => {
  it("advances through the fields in order and ends", () => {
    expect(bot.STEP_ORDER).toEqual([
      "await_price",
      "await_delivery",
      "await_origin",
      "await_brand",
      "await_notes",
    ]);
  });

  it("prompts in Arabic for every step, naming the item", () => {
    for (const step of bot.STEP_ORDER) {
      const p = bot.stepPrompt(step, "بند تجريبي");
      expect(p).toContain("بند تجريبي");
      expect(p.length).toBeGreaterThan(10);
    }
  });
});

describe("kill-switch", () => {
  // The bot claims plain text from a registered supplier, so it changes the
  // behaviour of a live channel. The switch has to be read at MESSAGE time, not
  // at module load: an operator setting SUPPLIER_BOT_ENABLED=false expects the
  // next message to behave, and a load-time constant would keep the old value
  // for the life of the process.
  it("reads the flag per message, not once at import", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../modules/communications/routes.ts", import.meta.url), "utf8"),
    );
    // The check must exist inside the handler and be evaluated on each call.
    const handler = src.slice(src.indexOf("async function handleSupplierBotMessage"));
    expect(handler).toContain("supplierBotEnabled()");
    expect(handler.indexOf("supplierBotEnabled()")).toBeLessThan(
      handler.indexOf("supplierByPhone"),
    );
    // A module-level constant would freeze the flag.
    expect(src).not.toMatch(/^const\s+SUPPLIER_BOT_ENABLED\s*=/m);
    expect(src).toMatch(/process\.env\.SUPPLIER_BOT_ENABLED\s*!==\s*"false"/);
  });
});

describe("the bot ROUTES, it does not collect data (operator correction)", () => {
  /**
   * The operator's correction, in full: «البوت للاختيار والإسناد فقط — لا
   * يُدخل أسعارًا ولا أي بيانات». An earlier flow asked the supplier for
   * availability, price, delivery days, origin, brand and notes, then wrote the
   * answers as a draft offer.
   *
   * That is wrong twice over: it asks the supplier for the figures the
   * responsible EMPLOYEE negotiates, and it keeps the answer outside the console
   * thread — which is where the employee actually works. The bot's job is to
   * route the supplier to that employee and hand the thread over.
   *
   * This guard is source-level on purpose: the wizard's helpers still exist
   * (deleting them is riskier than leaving them unreachable), so what must be
   * pinned is that NO path can enter the wizard.
   */
  it("cannot enter a data-entry step from any button", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const routes = readFileSync(join(here, "../../modules/communications/routes.ts"), "utf8");

    // Nothing may set the session step to a data-entry state. The only writers
    // of `step` are the wizard's own transitions; if none remains, the wizard is
    // unreachable whatever its handlers still contain.
    const stepWrites = routes.match(/step:\s*["']await_/g) ?? [];
    expect(stepWrites).toEqual([]);

    // The item's action button must offer the hand-off, not an availability
    // question — the first rung of the removed wizard.
    expect(routes).not.toContain("sup_avail:");
  });

  it("every bot button has a handler (a button nobody handles is dead)", async () => {
    // The button and its handler live in two different files, so renaming one
    // leaves a control the supplier can tap and nothing happens — silent from
    // the outside, because the webhook still returns 200. This guard compares
    // the payloads the service SENDS with the prefixes the router HANDLES.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const service = readFileSync(join(here, "../../modules/communications/service.ts"), "utf8");
    const routes = readFileSync(join(here, "../../modules/communications/routes.ts"), "utf8");

    const sent = new Set<string>();
    for (const m of service.matchAll(/["'`]((?:sup|rfq_pick)_[a-z_]+):/g)) sent.add(m[1]);
    expect(sent.size).toBeGreaterThan(3);

    const handled = new Set<string>();
    for (const m of routes.matchAll(/head === "([a-z_]+)"/g)) handled.add(m[1]);
    for (const m of routes.matchAll(/payload\.startsWith\("([a-z_]+):"\)/g)) handled.add(m[1]);

    const dead = [...sent].filter((p) => !handled.has(p));
    expect(dead).toEqual([]);
  });

  it("hands the conversation to the responsible employee, not to a price prompt", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const routes = readFileSync(join(here, "../../modules/communications/routes.ts"), "utf8");

    // The hand-off names the owner from the sent-log row, and mirrors the tap so
    // the employee sees the supplier's choice inside the thread.
    expect(routes).toContain("responsibleEmployeeFor");
    expect(routes).toContain("sendSupplierRequestHandedOff");
    // Choosing a request must ALSO confirm the hand-off (it used to open the
    // wizard's first step).
    expect(routes).not.toMatch(/sendSupplierRequestConfirmed\(\s*phone,\s*chosen/);
  });
});

describe("inbound messages are recorded at the dispatch point", () => {
  /**
   * Every handler the webhook tries before `handleInboundMessage` owns the
   * message it returns `true` for, so the persisting handler never sees it.
   *
   * Making each interceptor remember to record itself failed THREE times in one
   * session — the bot's media path, the request pick, and the representative bot
   * — and the symptom was identical every time and misleading: the menu appears
   * to work and then the conversation stops. So recording moved to ONE place,
   * before any handler is consulted.
   *
   * Found live: a request pick (`wamid.P456`) and every representative message
   * were missing from `whatsapp_chats` entirely.
   */
  it("records before dispatching, on BOTH webhook paths", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const routes = readFileSync(join(here, "../../modules/communications/routes.ts"), "utf8");

    const calls = routes.match(/await recordInboundOnce\(/g) ?? [];
    // `Whatsapp.on.message` and `dispatchWebhookPayload` — one call each. A
    // handler added to one path only is the recorded "dispatch-order" defect.
    expect(calls.length).toBe(2);

    // The recorder must be idempotent on the WhatsApp message id, or a
    // redelivered webhook doubles the thread.
    const rec = routes.slice(routes.indexOf("async function recordInboundOnce"));
    expect(rec.slice(0, 900)).toContain("waMessageId");
  });
});

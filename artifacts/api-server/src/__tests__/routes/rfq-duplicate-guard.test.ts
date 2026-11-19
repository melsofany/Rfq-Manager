/**
 * Route guard: POST /rfq must REUSE the existing RFQ for the same customer
 * request instead of creating a second row.
 *
 * The measured production damage is the reason this exists: 29 duplicated
 * customer numbers, one with 5 rows and 55 sends, its offers split across two
 * rows — so the comparison and analysis each saw a fragment.
 *
 * The mocked DB serves whatever rows it is given, so the assertions are on the
 * route's DECISIONS (which row is updated, whether an rfq insert happened).
 * The SQL predicate itself is proven against a real engine in
 * `shared/rfq-duplicate.live.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../modules/rfq/offers-pdf.js", () => ({ generateOffersPdf: vi.fn() }));
vi.mock("../../modules/reports/dispatch-pdf.js", () => ({ generateDispatchReportPdf: vi.fn() }));
vi.mock("../../shared/email", () => ({
  sendRfqEmail: vi.fn(async () => ({ status: "sent", error: null })),
  sendSupplierGreetingEmail: vi.fn(async () => ({ status: "sent", error: null })),
}));
vi.mock("../../modules/communications/service", () => ({
  recordOutboundMessage: vi.fn(async () => undefined),
  sendRfqWhatsApp: vi.fn(async () => ({ status: "sent", error: null })),
  sendSupplierGreetingWhatsApp: vi.fn(async () => ({ status: "sent", error: null })),
}));
vi.mock("../../shared/supplier-guide", () => ({
  loadSupplierGuide: vi.fn(async () => null),
  supplierGuideUrl: vi.fn(() => "/guide.pdf"),
}));
vi.mock("../../shared/google-sheets", () => ({
  lookupRfqFromSheet: vi.fn(async () => []),
  listSheetRfqNumbers: vi.fn(async () => []),
  listSheetTabs: vi.fn(async () => []),
}));
vi.mock("../../modules/rfq/assignment", () => ({
  ensureAssignmentsForRfqSafe: vi.fn(async () => undefined),
}));
vi.mock("../../shared/permissions", () => ({
  guardFor: () => (_req: any, _res: any, next: any) => next(),
}));

// ── Tables (truthy handles; identity is what the mock matches on) ────────────
const rfqTbl = { _: "rfq", id: "id", customerRfqNo: "customerRfqNo" };
const rfqItemsTbl = { _: "rfqItems", rfqId: "rfqId" };
const customerRfqsTbl = { _: "customerRfqs", id: "id", customerRfqNo: "customerRfqNo" };
const auditTbl = { _: "audit" };
const offersTbl = { _: "offers", rfqId: "rfqId" };

// ── Per-test state ───────────────────────────────────────────────────────────
const state: {
  sameNumberRows: any[];
  storedItemRows: any[];
  freshRow: any;
  inserts: Array<{ table: any; values: any }>;
  updates: Array<{ table: any; set: any }>;
} = { sameNumberRows: [], storedItemRows: [], freshRow: null, inserts: [], updates: [] };

function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  if (!obj.limit) obj.limit = () => chainable(value, methods);
  if (!obj.groupBy) obj.groupBy = () => chainable(value, methods);
  return obj;
}

vi.mock("@workspace/db", () => ({
  rfqTable: rfqTbl,
  rfqItemsTable: rfqItemsTbl,
  sentLogTable: { _: "sentLog" },
  suppliersTable: { _: "suppliers" },
  employeesTable: { _: "employees" },
  offersTable: offersTbl,
  offerItemsTable: { _: "offerItems" },
  offerAttachmentsTable: { _: "offerAttachments" },
  auditLogTable: auditTbl,
  customerRfqsTable: customerRfqsTbl,
  customerRfqItemsTable: { _: "customerRfqItems" },
  db: {
    select: vi.fn((arg?: any) => ({
      from: (table: any) => {
        // The item-count query projects `n`; the stored-items query does not.
        if (table === rfqItemsTbl) {
          const rows =
            arg && typeof arg === "object" && "n" in arg
              ? state.sameNumberRows.map((r) => ({ rfqId: r.id, n: state.storedItemRows.length }))
              : state.storedItemRows;
          return chainable(rows, { where: () => chainable(rows) });
        }
        if (table === offersTbl) {
          // Offer counts are per-rfq; the fixture keeps them on the rows.
          const rows = state.sameNumberRows.map((r) => ({ rfqId: r.id, n: r.offerCount ?? 0 }));
          return chainable(rows, { where: () => chainable(rows) });
        }
        if (table === rfqTbl) {
          // The normalized search projects specific columns; the post-update
          // re-read is a bare select() and must return the UPDATED row.
          if (arg == null)
            return chainable([state.freshRow ?? {}], {
              where: () => chainable([state.freshRow ?? {}]),
            });
          return chainable(state.sameNumberRows, { where: () => chainable(state.sameNumberRows) });
        }
        if (table === customerRfqsTbl)
          return chainable([], { where: () => chainable([], { limit: () => chainable([]) }) });
        return chainable([]);
      },
    })),
    insert: vi.fn((table: any) => ({
      values: vi.fn((values: any) => {
        state.inserts.push({ table, values });
        return chainable(values, { returning: () => chainable([state.freshRow ?? {}]) });
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((set: any) => {
        state.updates.push({ table, set });
        return chainable([], { where: () => chainable([]) });
      }),
    })),
    transaction: vi.fn(async (fn: any) => fn({})),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: any[]) => ({ __sql: strings.join("?"), values }),
      { raw: (s: string) => ({ __raw: s }) },
    ),
    eq: (col: any, val: any) => ({ __eq: [col, val] }),
    and: (...args: any[]) => ({ __and: args }),
    or: (...args: any[]) => ({ __or: args }),
    inArray: (col: any, vals: any[]) => ({ __inArray: [col, vals] }),
    ilike: (col: any, val: any) => ({ __ilike: [col, val] }),
    count: () => ({ __count: true }),
  };
});

let app: any;
beforeEach(async () => {
  state.sameNumberRows = [];
  state.storedItemRows = [];
  state.freshRow = null;
  state.inserts = [];
  state.updates = [];
  vi.clearAllMocks();
  const mod = await import("../../modules/rfq/routes");
  app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    req.session = { employeeId: 1, role: "manager" };
    next();
  });
  app.use("/api", mod.default);
  // Surface the real error instead of a bare 500.
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("ROUTE ERROR:", err?.message, "\n", err?.stack);
    res.status(500).json({ error: err?.message });
  });
});

const THREE_ITEMS = [
  { partNo: "CB640A", description: "BREAKER" },
  { partNo: "CB640B", description: "BREAKER 2" },
  { partNo: "CB640C", description: "BREAKER 3" },
];

describe("POST /api/rfq — reuse instead of duplicating", () => {
  it("reuses the existing RFQ and inserts NO new rfq row", async () => {
    state.sameNumberRows = [
      {
        id: 121,
        internalRfqNo: "CRQ-2026-000075",
        customerRfqNo: "26R007225",
        status: "QUOTED",
        expiresAt: null,
        createdAt: new Date("2026-06-28"),
      },
    ];
    // The same three lines the caller re-sends — nothing should be inserted.
    state.storedItemRows = [
      { id: 1, partNo: "CB640A", lineItem: null, description: "BREAKER" },
      { id: 2, partNo: "CB640B", lineItem: null, description: "BREAKER 2" },
      { id: 3, partNo: "CB640C", lineItem: null, description: "BREAKER 3" },
    ];
    state.freshRow = {
      id: 121,
      internalRfqNo: "CRQ-2026-000075",
      customerRfqNo: "26R007225",
      status: "QUOTED",
      expiresAt: null,
      customerRfqDate: null,
      requiredResponseDate: null,
      employeeId: 1,
      notes: null,
      createdAt: new Date("2026-06-28"),
      updatedAt: new Date("2026-06-28"),
    };

    const res = await request(app)
      .post("/api/rfq")
      .send({ customerRfqNo: "26R007225", items: THREE_ITEMS });

    expect(res.status).toBe(200);
    expect(res.body.reused).toBe(true);
    expect(res.body.id).toBe(121);
    expect(res.body.addedItemCount).toBe(0);
    // The decisive assertion: no NEW rfq row was created.
    expect(state.inserts.filter((i) => i.table === rfqTbl)).toHaveLength(0);
    // And no item rows — every line was already present.
    expect(state.inserts.filter((i) => i.table === rfqItemsTbl)).toHaveLength(0);
  });

  it("extends the closing date and revives a terminal RFQ on reuse", async () => {
    state.sameNumberRows = [
      {
        id: 120,
        internalRfqNo: "CRQ-2026-000074",
        customerRfqNo: "26R007225",
        status: "FAILED",
        expiresAt: new Date("2026-06-04T00:00:00Z"),
        createdAt: new Date("2026-06-28"),
      },
    ];
    state.storedItemRows = [];
    state.freshRow = {
      id: 120,
      internalRfqNo: "CRQ-2026-000074",
      customerRfqNo: "26R007225",
      status: "SENT",
      expiresAt: new Date("2026-12-31T23:59:59.999Z"),
      customerRfqDate: null,
      requiredResponseDate: null,
      employeeId: 1,
      notes: null,
      createdAt: new Date("2026-06-28"),
      updatedAt: new Date("2026-06-28"),
    };

    const res = await request(app)
      .post("/api/rfq")
      .send({
        customerRfqNo: "26R007225",
        expiresAt: "2026-12-31T23:59:59.999Z",
        items: [{ partNo: "CB640A", description: "BREAKER" }],
      });

    expect(res.status).toBe(200);
    const rfqUpdate = state.updates.find((u) => u.table === rfqTbl);
    expect(rfqUpdate).toBeTruthy();
    expect(rfqUpdate!.set.status).toBe("SENT");
    expect(new Date(rfqUpdate!.set.expiresAt).toISOString()).toBe("2026-12-31T23:59:59.999Z");
    expect(state.inserts.filter((i) => i.table === rfqTbl)).toHaveLength(0);
  });

  it("creates a new RFQ when the customer number is genuinely new", async () => {
    state.sameNumberRows = [];
    state.freshRow = {
      id: 999,
      internalRfqNo: "CRQ-2026-000999",
      customerRfqNo: "BRAND-NEW-1",
      status: "DRAFT",
      expiresAt: null,
      customerRfqDate: null,
      requiredResponseDate: null,
      employeeId: 1,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const res = await request(app)
      .post("/api/rfq")
      .send({ customerRfqNo: "BRAND-NEW-1", items: [{ partNo: "X", description: "ITEM X" }] });

    expect(res.status).toBe(201);
    expect(res.body.reused).toBeUndefined();
    expect(state.inserts.filter((i) => i.table === rfqTbl)).toHaveLength(1);
  });
});

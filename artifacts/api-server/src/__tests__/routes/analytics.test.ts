/**
 * Tests for GET /analytics/overview's financial-statements snapshot.
 *
 * The overview duplicates the statement maths rather than calling the
 * /accounts/* routes, so it is the easiest place for the two to drift apart.
 * These tests pin it to the same conventions: contra accounts net against
 * their section, and the unclosed period result is carried into equity so the
 * accounting equation holds.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.session = { employeeId: 7, role: "manager" };
    next();
  },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

function chainable(value: any): any {
  return { then: (resolve: any) => Promise.resolve(value).then(resolve) };
}

let coaRows: any[] = [];
let journalEntryRows: any[] = [];
let journalLineRows: any[] = [];

// The overview queries ~20 tables; every one except the chart of accounts and
// the journal lines can safely come back empty for these assertions.
function selectBuilder() {
  const api: any = {
    from: vi.fn((table: any) => {
      let rows: any[] = [];
      if (table === TABLES.chartOfAccountsTable) rows = coaRows;
      else if (table === TABLES.journalEntriesTable) rows = journalEntryRows;
      else if (table === TABLES.journalLinesTable) rows = journalLineRows;
      const cur: any = {
        innerJoin: vi.fn((joinTable: any) => {
          if (table === TABLES.journalLinesTable && joinTable === TABLES.journalEntriesTable) {
            const byId = new Map(journalEntryRows.map((e: any) => [e.id, e]));
            rows = rows.map((l: any) => {
              const e = byId.get(l.entryId);
              return e ? { ...l, entryDate: e.entryDate, status: e.status } : l;
            });
          }
          return cur;
        }),
        leftJoin: vi.fn(() => cur),
        where: vi.fn((cond: any) => {
          // accountBalance() filters journal_lines by account code. Drizzle
          // columns carry a snake_case `.name`; the fixture rows use camelCase.
          if (cond?.__eq) {
            const [col, val] = cond.__eq;
            const snake = col?.name ?? String(col);
            const camel = snake.replace(/_([a-z])/g, (_m: string, ch: string) => ch.toUpperCase());
            rows = rows.filter((r: any) => {
              if (snake in r) return String(r[snake]) === String(val);
              if (camel in r) return String(r[camel]) === String(val);
              return true;
            });
          }
          return cur;
        }),
        groupBy: vi.fn(() => cur),
        orderBy: vi.fn(() => cur),
        limit: vi.fn(() => chainable(rows)),
        then: (resolve: any) => Promise.resolve(rows).then(resolve),
      };
      return cur;
    }),
  };
  return api;
}

const dbMock: any = {
  select: vi.fn(() => selectBuilder()),
  selectDistinct: vi.fn(() => selectBuilder()),
  insert: vi.fn(() => ({ values: vi.fn(() => chainable([{ id: 1 }])) })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })) })),
  delete: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })),
};

let TABLES: Record<string, any> = {};

vi.mock("@workspace/db", async () => {
  const actual: any = await vi.importActual("@workspace/db");
  TABLES = actual;
  return { ...actual, db: dbMock, ACCOUNT_CODES: actual.ACCOUNT_CODES };
});

vi.mock("drizzle-orm", () => {
  const sql: any = (strings: TemplateStringsArray) => ({
    __raw: true,
    toString: () => strings.join("?"),
  });
  sql.template = { raw: (s: any) => ({ __raw: true, toString: () => s }) };
  const opaque = () => ({ __op: true });
  return {
    eq: (a: any, b: any) => ({ __eq: [a, b], col: a, val: b }),
    ne: opaque,
    count: opaque,
    countDistinct: opaque,
    sql,
    desc: (a: any) => a,
    asc: (a: any) => a,
    gte: opaque,
    lte: opaque,
    isNotNull: opaque,
    inArray: opaque,
    or: (...args: any[]) => args.find((a) => a !== undefined) ?? undefined,
    and: (...args: any[]) => args.find((a) => a !== undefined) ?? undefined,
  };
});

let testApp: express.Express;

beforeAll(async () => {
  const { default: analyticsRouter } = await import("../../modules/reports/analytics");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { employeeId: 7, role: "manager" };
    next();
  });
  testApp.use("/api", analyticsRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  coaRows = [];
  journalEntryRows = [];
  journalLineRows = [];
});

// A balanced month: cash 1100 (asset), capital 1000 (equity), sales 500
// (revenue), sales returns 100 (revenue type, DEBIT balance), COGS 300
// (expense). Debits 1100+100+300 = credits 1000+500, so the ledger is sound.
// Revenue nets to 400 → profit 100 → equity 1100 = assets 1100.
function seedProfitableMonthWithReturns() {
  coaRows = [
    { id: 1, code: "1001", nameAr: "النقدية", type: "asset", isActive: true },
    { id: 2, code: "3100", nameAr: "رأس المال", type: "equity", isActive: true },
    { id: 3, code: "4100", nameAr: "المبيعات", type: "revenue", isActive: true },
    { id: 4, code: "4101", nameAr: "مردود المبيعات", type: "revenue", isActive: true },
    { id: 5, code: "5100", nameAr: "تكلفة المبيعات", type: "expense", isActive: true },
  ];
  journalEntryRows = [{ id: 1, entryDate: "2026-08-05", status: "posted" }];
  journalLineRows = [
    { entryId: 1, accountCode: "1001", debit: "1100", credit: "0" },
    { entryId: 1, accountCode: "3100", debit: "0", credit: "1000" },
    { entryId: 1, accountCode: "4100", debit: "0", credit: "500" },
    { entryId: 1, accountCode: "4101", debit: "100", credit: "0" },
    { entryId: 1, accountCode: "5100", debit: "300", credit: "0" },
  ];
}

describe("GET /api/analytics/overview — financial statements", () => {
  it("nets a contra-revenue account instead of inflating revenue", async () => {
    seedProfitableMonthWithReturns();
    const res = await request(testApp).get("/api/analytics/overview");
    expect(res.status).toBe(200);
    // Revenue 500 − returns 100 = 400; expenses 300 → profit 100.
    // Pre-fix this was 500 + 100 − 300 = 300 because Math.abs() added returns.
    expect(Number(res.body.financials.statements.netProfit)).toBe(100);
  });

  it("carries the period result into equity so the equation balances", async () => {
    seedProfitableMonthWithReturns();
    const res = await request(testApp).get("/api/analytics/overview");
    expect(res.status).toBe(200);
    expect(Number(res.body.financials.statements.totalAssets)).toBe(1100);
    // Equity = capital 1000 + period result 100
    expect(Number(res.body.financials.statements.totalEquity)).toBe(1100);
    expect(res.body.financials.statements.balanced).toBe(true);
  });
});

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

let sessionState = { employeeId: 7, role: "manager", employeeName: "Sara" };
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.session = { ...sessionState };
    next();
  },
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) => {
    if (!sessionState.employeeId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(sessionState.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  },
}));

function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

const operatingExpensesTbl = "operatingExpenses";
const expenseAttachmentsTbl = "expenseAttachments";
const auditTbl = "audit";
const chartOfAccountsTbl = "chartOfAccounts";
const journalEntriesTbl = "journalEntries";
const journalLinesTbl = "journalLines";
const accountingClosingsTbl = "accountingClosings";

let expenseRows: any[];
let attachmentRows: any[];

function selectBuilder() {
  const api: any = {
    from: vi.fn((table: any) => {
      let rows: any[] = [];
      if (table === operatingExpensesTbl) rows = expenseRows;
      else if (table === expenseAttachmentsTbl) rows = attachmentRows;
      else if (table === chartOfAccountsTbl) rows = [{ code: "1001" }, { code: "1010" }, { code: "5300" }, { code: "5990" }];
      else if (table === journalEntriesTbl) rows = [];
      const cur: any = {
        innerJoin: vi.fn(() => cur),
        leftJoin: vi.fn(() => cur),
        where: vi.fn(() => cur),
        groupBy: vi.fn(() => cur),
        orderBy: vi.fn(() => cur),
        limit: vi.fn(() => cur),
        then: (resolve: any) => Promise.resolve(rows).then(resolve),
      };
      return cur;
    }),
  };
  return api;
}

const dbMock: any = {
  select: vi.fn((table: any) => (table === accountingClosingsTbl ? chainable([]) : selectBuilder())),
  insert: vi.fn(() => ({
    values: vi.fn(() => chainable([{ id: 1 }], { returning: vi.fn(() => chainable([{ id: 1 }])) })),
  })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })) })),
  delete: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })),
};

const ACCOUNT_CODES_MOCK = {
  CASH: "1001",
  BANK: "1010",
  RENT_EXPENSE: "5300",
  MISC_EXPENSE: "5990",
  IT_EXPENSE: "5700",
  UTILITIES_EXPENSE: "5400",
  TELECOM_EXPENSE: "5410",
  MAINTENANCE_EXPENSE: "5500",
  ADMIN_EXPENSE: "5600",
  SALARIES_EXPENSE: "5200",
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  operatingExpensesTable: operatingExpensesTbl,
  expenseAttachmentsTable: expenseAttachmentsTbl,
  auditLogTable: auditTbl,
  chartOfAccountsTable: chartOfAccountsTbl,
  journalEntriesTable: journalEntriesTbl,
  journalLinesTable: journalLinesTbl,
  accountingClosingsTable: accountingClosingsTbl,
  ACCOUNT_CODES: ACCOUNT_CODES_MOCK,
}));

vi.mock("drizzle-orm", () => {
  const sqlTag = (strings: TemplateStringsArray, ...vals: any[]) =>
    strings.reduce((acc: string, s: string, i: number) => acc + s + (vals[i] != null ? String(vals[i]) : ""), "");
  (sqlTag as any).raw = (s: any) => s;
  return {
    eq: (a: any, _b: any) => a,
    and: (...args: any[]) => args.find((a) => a !== undefined) ?? undefined,
    desc: (a: any) => a,
    gte: (_a: any, _b: any) => undefined,
    lte: (_a: any, _b: any) => undefined,
    sql: sqlTag as any,
  };
});

let testApp: express.Express;

beforeAll(async () => {
  const { default: expensesRouter } = await import("../../modules/expenses/routes");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { ...sessionState };
    next();
  });
  testApp.use("/api", expensesRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionState = { employeeId: 7, role: "manager", employeeName: "Sara" };
  expenseRows = [];
  attachmentRows = [];
});

describe("Operating expenses API", () => {
  it("GET /api/expenses returns the list", async () => {
    expenseRows = [
      { id: 1, category: "إيجارات", description: null, expenseDate: "2026-08-01", amount: "5000", notes: null, employeeName: "Sara", createdAt: new Date() },
    ];
    const res = await request(testApp).get("/api/expenses");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].category).toBe("إيجارات");
    expect(res.body[0].amount).toBe("5000");
  });

  it("POST /api/expenses creates an expense, posts a journal entry, and audits it", async () => {
    const res = await request(testApp)
      .post("/api/expenses")
      .send({ category: "نثريات", expenseDate: "2026-08-05", amount: 250 });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(1);
    expect(dbMock.insert).toHaveBeenCalled();
    // expense row + journal entry header + journal lines + audit = 4 inserts
    expect(dbMock.insert).toHaveBeenCalledTimes(4);
  });

  it("POST /api/expenses rejects missing fields", async () => {
    const res = await request(testApp).post("/api/expenses").send({ category: "", amount: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it("GET /api/expenses/:id returns detail with attachments", async () => {
    expenseRows = [
      { id: 5, category: "صيانة", description: "تكييف", expenseDate: "2026-07-20", amount: "800", notes: null, employeeName: "Sara", createdAt: new Date() },
    ];
    attachmentRows = [
      { id: 9, originalName: "inv.pdf", mimeType: "application/pdf", size: 1024, createdAt: new Date() },
    ];
    const res = await request(testApp).get("/api/expenses/5");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(5);
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0].originalName).toBe("inv.pdf");
  });

  it("DELETE /api/expenses/:id requires manager role and deletes", async () => {
    expenseRows = [{ id: 3 }];
    const res = await request(testApp).delete("/api/expenses/3");
    expect(res.status).toBe(200);
    expect(dbMock.delete).toHaveBeenCalled();
  });

  it("DELETE /api/expenses/:id forbids non-managers", async () => {
    sessionState.role = "employee";
    const res = await request(testApp).delete("/api/expenses/3");
    expect(res.status).toBe(403);
  });
});

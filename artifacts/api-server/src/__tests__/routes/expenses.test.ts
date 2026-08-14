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

let expenseRows: any[];
let attachmentRows: any[];

function selectBuilder() {
  const api: any = {
    from: vi.fn((table: any) => {
      let rows: any[] = [];
      if (table === operatingExpensesTbl) rows = expenseRows;
      else if (table === expenseAttachmentsTbl) rows = attachmentRows;
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
  select: vi.fn(() => selectBuilder()),
  insert: vi.fn(() => ({
    values: vi.fn(() => chainable([{ id: 1 }], { returning: vi.fn(() => chainable([{ id: 1 }])) })),
  })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })) })),
  delete: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  operatingExpensesTable: operatingExpensesTbl,
  expenseAttachmentsTable: expenseAttachmentsTbl,
  auditLogTable: auditTbl,
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: any, _b: any) => a,
  and: (...args: any[]) => args.find((a) => a !== undefined) ?? undefined,
  desc: (a: any) => a,
  gte: (_a: any, _b: any) => undefined,
  lte: (_a: any, _b: any) => undefined,
  sql: { template: { raw: (s: any) => s } },
}));

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

  it("POST /api/expenses creates an expense and audits it", async () => {
    const res = await request(testApp)
      .post("/api/expenses")
      .send({ category: "نثريات", expenseDate: "2026-08-05", amount: 250 });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(1);
    expect(dbMock.insert).toHaveBeenCalled();
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

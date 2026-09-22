import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth: requireRole honours the session role ──────────────────────────
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole:
    (...roles: string[]) =>
    (req: any, res: any, next: any) => {
      if (!roles.includes(req.session?.role ?? "")) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    },
}));

const chainable = (value: any, methods: Record<string, any> = {}): any => {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
};

vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  and: (...args: any[]) => ({ __op: "and", args }),
  or: (...args: any[]) => ({ __op: "or", args }),
  desc: (col: any) => ({ __op: "desc", col }),
  asc: (col: any) => ({ __op: "asc", col }),
  count: () => ({ __op: "count" }),
  ilike: (left: any, right: any) => ({ __op: "ilike", left, right }),
  gte: (left: any, right: any) => ({ __op: "gte", left, right }),
}));

// ── DB mock ──────────────────────────────────────────────────────────────────
const usersTable = { _: "aiUsers", id: "id", phone: "phone", isActive: "isActive" };
const settingsTable = { _: "aiSettings", id: "id", key: "key" };
const employeesTbl = { _: "employees", id: "id", name: "name", role: "role", isActive: "isActive" };
const auditTbl = { _: "audit" };
const messagesTbl = { _: "aiMessages", id: "id", phone: "phone", role: "role" };

let userRows: any[] = [];
let employeeRows: any[] = [];

const dbMock: any = {
  select: vi.fn((arg?: any) => ({
    from: vi.fn((table: any) => {
      if (table === usersTable)
        return chainable([...userRows], {
          where: () => chainable([...userRows]),
          orderBy: () => chainable([...userRows]),
        });
      if (table === employeesTbl) {
        if (arg && typeof arg === "object" && "isActive" in arg)
          return chainable([...employeeRows], { where: () => chainable([...employeeRows]) });
        // employee-active probe: select({ isActive }).where(...).limit(1)
        return chainable([...employeeRows.slice(0, 1)], {
          where: () =>
            chainable([...employeeRows.slice(0, 1)], {
              limit: () => chainable(employeeRows.slice(0, 1)),
            }),
        });
      }
      return chainable([], { where: () => chainable([]) });
    }),
  })),
  insert: vi.fn(() => ({
    values: vi.fn(() =>
      chainable({ id: 1 }, { returning: () => chainable([{ id: 1, phone: "2010" }]) }),
    ),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => chainable([], { returning: () => chainable([{ id: 1 }]) })),
    })),
  })),
  delete: vi.fn(() => ({ where: vi.fn(() => chainable([])) })),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  aiAssistantUsersTable: usersTable,
  aiAssistantSettingsTable: settingsTable,
  aiAssistantMessagesTable: messagesTbl,
  employeesTable: employeesTbl,
  auditLogTable: auditTbl,
}));

let app: express.Express;

describe("AI assistant admin routes", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    userRows = [];
    employeeRows = [];
    const { default: router } = await import("../../modules/ai-assistant/routes");
    app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.session = { employeeId: 1, role: "manager" };
      next();
    });
    app.use(router);
  });

  it("GET /ai-assistant/users returns the allowlist", async () => {
    userRows = [
      {
        id: 1,
        phone: "201012345678",
        name: "مدير",
        employeeId: null,
        role: "manager",
        isActive: true,
      },
    ];
    const res = await request(app).get("/ai-assistant/users");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].phone).toBe("201012345678");
  });

  it("POST /ai-assistant/users canonicalizes and adds a number", async () => {
    const res = await request(app)
      .post("/ai-assistant/users")
      .send({ phone: "+20 101 234 5678", name: "أحمد" });
    expect(res.status).toBe(201);
    const valuesArg = dbMock.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(valuesArg.phone).toBe("201012345678");
  });

  it("POST /ai-assistant/users rejects an invalid phone", async () => {
    const res = await request(app).post("/ai-assistant/users").send({ phone: "123" });
    expect(res.status).toBe(400);
  });

  it("DELETE /ai-assistant/users/:id deletes", async () => {
    const res = await request(app).delete("/ai-assistant/users/5");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("PUT /ai-assistant/settings persists flags", async () => {
    const res = await request(app)
      .put("/ai-assistant/settings")
      .send({ enabled: false, language: "en", allowPdf: false });
    expect(res.status).toBe(200);
    const setArg = dbMock.update.mock.results[0].value.set.mock.calls[0][0];
    expect(setArg.enabled).toBe(false);
    expect(setArg.language).toBe("en");
    expect(setArg.allowPdf).toBe(false);
  });

  it("forbids a non-admin/manager role", async () => {
    const { default: router } = await import("../../modules/ai-assistant/routes");
    const restricted = express();
    restricted.use(express.json());
    restricted.use((req: any, _res, next) => {
      req.session = { employeeId: 9, role: "purchasing" };
      next();
    });
    restricted.use(router);
    const res = await request(restricted).get("/ai-assistant/users");
    expect(res.status).toBe(403);
  });
});

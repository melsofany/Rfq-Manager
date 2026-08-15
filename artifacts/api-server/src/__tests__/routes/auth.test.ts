import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Auth module uses bcryptjs — stub it so we don't depend on real hashing.
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn().mockResolvedValue(true), hash: vi.fn().mockResolvedValue("hashed") },
  compare: vi.fn().mockResolvedValue(true),
  hash: vi.fn().mockResolvedValue("hashed"),
}));

// ── Chainable + thenable DB mock ─────────────────────────────────────────────
function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

const employeesTbl = { _: "employees", id: "id", email: "email", phone: "phone" };

// Per-test state.
let employeeRow: any | null; // a single employee returned by select().where().limit(1) / select().where()
let listRows: any[]; // GET /employees
let insertedRow: any; // POST /employees insert().returning()
let updatedRow: any | null; // PATCH /employees/:id update().returning()

// Mutable session so tests can flip role.
const sessionState: { employeeId: number; role?: string } = { employeeId: 1, role: "admin" };

vi.mock("@workspace/db", () => {
  const dbMock: any = {
    select: vi.fn((_arg?: any) => ({
      from: vi.fn((_table: any) => {
        // Used by email/phone duplicate checks + login/me lookups: .where().limit(1)
        return chainable(employeeRow ? [employeeRow] : [], {
          where: vi.fn(() =>
            chainable(employeeRow ? [employeeRow] : [], {
              limit: vi.fn(() => chainable(employeeRow ? [employeeRow] : [])),
              orderBy: vi.fn(() => chainable(listRows)),
            }),
          ),
          orderBy: vi.fn(() => chainable(listRows)),
        });
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(() => chainable([insertedRow])) })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((_vals: any) => ({
        where: vi.fn(() => ({ returning: vi.fn(() => chainable(updatedRow ? [updatedRow] : [])) })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(() => chainable(updatedRow ? [updatedRow] : [])) })),
    })),
  };
  return {
    db: dbMock,
    employeesTable: employeesTbl,
    // Re-export the same table handles some route modules import.
    auditLogTable: { _: "audit" },
  };
});

// Stub logger.
vi.mock("../../shared/logger", () => ({ logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } }));

let testApp: express.Express;

beforeAll(async () => {
  const { default: authRouter } = await import("../../modules/users/auth");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = sessionState;
    next();
  });
  testApp.use("/api", authRouter);
});

beforeEach(() => {
  employeeRow = null;
  listRows = [];
  insertedRow = null;
  updatedRow = null;
  sessionState.employeeId = 1;
  sessionState.role = "admin";
});

describe("POST /api/employees — permissions persistence", () => {
  it("stores the permissions map and returns it in the response", async () => {
    insertedRow = {
      id: 5,
      name: "Data Clerk",
      email: "clerk@cortoba.com",
      role: "data_entry",
      phone: null,
      isActive: true,
      permissions: { "customer-rfq": true, "customer-po": true },
      createdAt: new Date("2026-01-01"),
    };
    const res = await request(testApp)
      .post("/api/employees")
      .send({
        name: "Data Clerk",
        email: "clerk@cortoba.com",
        password: "secret123",
        role: "data_entry",
        permissions: { "customer-rfq": true, "customer-po": true, "rfq": false },
      });
    expect(res.status).toBe(201);
    // Falsy entries are stripped; only true ones persist.
    expect(res.body.permissions).toEqual({ "customer-rfq": true, "customer-po": true });
  });

  it("normalizes a null/empty permissions payload to null (role default)", async () => {
    insertedRow = {
      id: 6,
      name: "Mgr",
      email: "mgr@cortoba.com",
      role: "manager",
      phone: null,
      isActive: true,
      permissions: null,
      createdAt: new Date("2026-01-01"),
    };
    const res = await request(testApp)
      .post("/api/employees")
      .send({ name: "Mgr", email: "mgr@cortoba.com", password: "secret123", role: "manager" });
    expect(res.status).toBe(201);
    expect(res.body.permissions).toBeNull();
  });
});

describe("PATCH /api/employees/:id — permissions update", () => {
  it("updates the permissions map and returns it", async () => {
    updatedRow = {
      id: 5,
      name: "Data Clerk",
      email: "clerk@cortoba.com",
      role: "data_entry",
      phone: null,
      isActive: true,
      permissions: { dashboard: true, customers: true, "customer-rfq": true, "customer-po": true },
      createdAt: new Date("2026-01-01"),
    };
    const res = await request(testApp)
      .patch("/api/employees/5")
      .send({ permissions: { dashboard: true, customers: true, "customer-rfq": true, "customer-po": true, accounts: false } });
    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual({
      dashboard: true,
      customers: true,
      "customer-rfq": true,
      "customer-po": true,
    });
  });

  it("forbids non-admin from updating employees", async () => {
    sessionState.role = "data_entry";
    const res = await request(testApp).patch("/api/employees/5").send({ name: "X" });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/employees — returns permissions per row", () => {
  it("includes the permissions field (null when unset)", async () => {
    listRows = [
      {
        id: 1,
        name: "Admin",
        email: "admin@cortoba.com",
        role: "admin",
        phone: null,
        isActive: true,
        permissions: null,
        createdAt: new Date("2026-01-01"),
      },
      {
        id: 2,
        name: "Clerk",
        email: "clerk@cortoba.com",
        role: "data_entry",
        phone: "0100",
        isActive: true,
        permissions: { "customer-rfq": true },
        createdAt: new Date("2026-01-02"),
      },
    ];
    const res = await request(testApp).get("/api/employees");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].permissions).toBeNull();
    expect(res.body[1].permissions).toEqual({ "customer-rfq": true });
  });
});

describe("POST /api/auth/login — returns permissions", () => {
  it("includes permissions in the logged-in employee object", async () => {
    employeeRow = {
      id: 2,
      name: "Clerk",
      email: "clerk@cortoba.com",
      passwordHash: "hashed",
      role: "data_entry",
      phone: null,
      isActive: true,
      permissions: { "customer-rfq": true, "customer-po": true },
      createdAt: new Date("2026-01-01"),
    };
    const res = await request(testApp)
      .post("/api/auth/login")
      .send({ email: "clerk@cortoba.com", password: "secret123" });
    expect(res.status).toBe(200);
    expect(res.body.employee.permissions).toEqual({ "customer-rfq": true, "customer-po": true });
  });
});

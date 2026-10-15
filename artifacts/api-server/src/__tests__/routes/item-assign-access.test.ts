import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ── drizzle-orm sentinels ───────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  and: (...args: any[]) => ({ __op: "and", args }),
  inArray: (left: any, right: any) => ({ __op: "inArray", left, right }),
  asc: (col: any) => ({ __op: "asc", col }),
  sql: Object.assign((strings: any, ...values: any[]) => ({ __op: "sql", strings, values }), {
    raw: (s: string) => ({ __op: "sql.raw", s }),
  }),
}));

function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

const employeesTable = { _: "employees", id: "id", permissions: "permissions" };

// employee row returned for the permission lookup (null ⇒ role default).
let permissionRow: { permissions: any } | null;

const dbMock: any = {
  select: vi.fn((_arg?: any) => ({
    from: vi.fn((table: any) => {
      if (table === employeesTable) {
        return chainable(permissionRow ? [permissionRow] : [], {
          where: vi.fn(() => chainable(permissionRow ? [permissionRow] : [])),
        });
      }
      return chainable([], { where: vi.fn(() => chainable([])) });
    }),
  })),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  employeesTable,
  rfqItemsTable: { _: "rfqItems" },
  rfqItemAssignmentsTable: { _: "assignments" },
  itemCategoriesTable: { _: "itemCategories" },
  auditLogTable: { _: "audit" },
}));

vi.mock("../../shared/logger", () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

let hasAssignAccess: typeof import("../../modules/rfq/assignments").hasAssignAccess;
let hasAssignmentManageAccess: typeof import("../../modules/rfq/assignments").hasAssignmentManageAccess;

beforeAll(async () => {
  ({ hasAssignAccess, hasAssignmentManageAccess } = await import("../../modules/rfq/assignments"));
});

beforeEach(() => {
  vi.clearAllMocks();
  permissionRow = null;
});

const req = (role: string) => ({ session: { employeeId: 7, role } });

describe("hasAssignAccess", () => {
  it("admin is always allowed (no lookup needed)", async () => {
    expect(await hasAssignAccess(req("admin"))).toBe(true);
  });

  it("purchasing + manager are allowed by role default", async () => {
    expect(await hasAssignAccess(req("purchasing"))).toBe(true);
    expect(await hasAssignAccess(req("manager"))).toBe(true);
  });

  it("data_entry is NOT allowed by default", async () => {
    expect(await hasAssignAccess(req("data_entry"))).toBe(false);
  });

  it("an explicit grant allows a data_entry", async () => {
    permissionRow = { permissions: { rfq: true, "rfq:assign": true } };
    expect(await hasAssignAccess(req("data_entry"))).toBe(true);
  });

  it("an explicit map that omits the key revokes even for purchasing", async () => {
    permissionRow = { permissions: { rfq: true } };
    expect(await hasAssignAccess(req("purchasing"))).toBe(false);
  });
});

describe("hasAssignmentManageAccess (change category + owner)", () => {
  it("allows admin and manager", () => {
    expect(hasAssignmentManageAccess(req("admin"))).toBe(true);
    expect(hasAssignmentManageAccess(req("manager"))).toBe(true);
  });

  it("refuses purchasing and data_entry regardless of the rfq:assign grant", () => {
    // The operator's rule: assigning an item moves KPI responsibility between
    // employees, so only a manager/admin does it. The `rfq:assign` permission
    // deliberately does NOT open this gate.
    permissionRow = { permissions: { rfq: true, "rfq:assign": true } };
    expect(hasAssignmentManageAccess(req("purchasing"))).toBe(false);
    expect(hasAssignmentManageAccess(req("data_entry"))).toBe(false);
  });

  it("refuses an anonymous session", () => {
    expect(hasAssignmentManageAccess({ session: {} })).toBe(false);
  });
});

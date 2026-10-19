import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  const RUNS = { __t: "runs" };
  const SLIPS = { __t: "slips" };
  const EMPLOYEES = { __t: "employees" };
  const state = {
    run: { id: 1, period: "2026-07", status: "approved" } as Record<string, unknown> | undefined,
    rows: [] as { slip: Record<string, unknown>; employee: Record<string, unknown> }[],
    updates: [] as { table: unknown; set: Record<string, unknown> }[],
    inserts: [] as unknown[],
    sends: [] as { phone: string; employeeName: string; period: string; net: number }[],
    failFor: new Set<string>(),
    configured: true,
    queries: [] as { cond: unknown }[],
  };
  return { RUNS, SLIPS, EMPLOYEES, state };
});

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, value: unknown) => ({ __op: "eq", value }),
  and: (...conds: unknown[]) => ({ __op: "and", conds }),
  inArray: (_col: unknown, values: unknown[]) => ({ __op: "inArray", values }),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        if (table === H.RUNS) {
          return { where: () => ({ limit: async () => (H.state.run ? [H.state.run] : []) }) };
        }
        return {
          innerJoin: () => ({
            where: async (cond: unknown) => {
              H.state.queries.push({ cond });
              return H.state.rows;
            },
          }),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          H.state.updates.push({ table, set });
        },
      }),
    }),
    insert: () => {
      H.state.inserts.push({});
      return { values: async () => ({}) };
    },
  },
  hrEmployeesTable: H.EMPLOYEES,
  hrPayrollRunsTable: H.RUNS,
  hrPayslipsTable: H.SLIPS,
}));

vi.mock("../modules/communications/service", () => ({
  isWhatsAppConfigured: H.state.configured,
  sendPayslipWhatsApp: vi.fn(
    async (opts: { phone: string; employeeName: string; period: string; net: number }) => {
      H.state.sends.push(opts);
      if (H.state.failFor.has(opts.phone)) throw new Error("قالب واتساب مرفوض");
      return "wamid.TEST";
    },
  ),
}));

vi.mock("../modules/hr/payslip-pdf", () => ({
  generatePayslipPdf: vi.fn(async () => Buffer.from("%PDF-1.4 test")),
}));

vi.mock("../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { deliverPayslips } from "../modules/hr/payroll-delivery";

function slip(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    runId: 1,
    employeeId: 100,
    basicSalary: "6000",
    allowances: "500",
    bonuses: "0",
    incentives: "0",
    deductions: "0",
    absenceDays: 0,
    absenceAmount: "0",
    finesApplied: "0",
    finesDeferred: "0",
    socialEmployee: "660",
    healthEmployee: "60",
    incomeTax: "205",
    gross: "6500",
    net: "5575",
    deliveryStatus: "pending",
    deliveredAt: null,
    deliveryError: null,
    ...overrides,
  };
}

function employee(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    employeeNo: "EMP-0001",
    fullName: "محمد أحمد",
    phone: "201001234567",
    jobTitle: null,
    department: null,
    ...overrides,
  };
}

beforeEach(() => {
  H.state.run = { id: 1, period: "2026-07", status: "approved" };
  H.state.rows = [];
  H.state.updates = [];
  H.state.inserts = [];
  H.state.sends = [];
  H.state.failFor.clear();
  H.state.configured = true;
  H.state.queries = [];
});

describe("payslip WhatsApp delivery", () => {
  it("sends each employee their own payslip to their own number", async () => {
    H.state.rows = [
      { slip: slip({ id: 11, employeeId: 100 }), employee: employee() },
      {
        slip: slip({ id: 12, employeeId: 200 }),
        employee: employee({
          id: 200,
          employeeNo: "EMP-0002",
          fullName: "سارة علي",
          phone: "201119876543",
        }),
      },
    ];

    const out = await deliverPayslips(1);

    expect(out.results.map((r) => r.outcome)).toEqual(["sent", "sent"]);
    expect(H.state.sends.map((s) => s.phone)).toEqual(["201001234567", "201119876543"]);
    expect(H.state.sends.map((s) => s.employeeName)).toEqual(["محمد أحمد", "سارة علي"]);
    // Every write targets the payslip row — nothing goes to the shared inbox.
    expect(H.state.updates.every((u) => u.table === H.SLIPS)).toBe(true);
    expect(H.state.updates.map((u) => u.set.deliveryStatus)).toEqual(["sent", "sent"]);
  });

  it("never writes a chat row to the shared WhatsApp inbox", async () => {
    H.state.rows = [{ slip: slip(), employee: employee() }];

    await deliverPayslips(1);

    expect(H.state.inserts).toEqual([]);
  });

  it("keeps going when one employee fails and records the reason on their row", async () => {
    H.state.failFor.add("201119876543");
    H.state.rows = [
      { slip: slip({ id: 11, employeeId: 100 }), employee: employee() },
      {
        slip: slip({ id: 12, employeeId: 200 }),
        employee: employee({ id: 200, fullName: "سارة علي", phone: "201119876543" }),
      },
    ];

    const out = await deliverPayslips(1);

    expect(out.results.map((r) => r.outcome)).toEqual(["sent", "failed"]);
    const failed = H.state.updates.find((u) => u.set.deliveryStatus === "failed");
    expect(failed?.set.deliveryError).toBe("قالب واتساب مرفوض");
  });

  it("skips an employee already delivered unless force is set", async () => {
    H.state.rows = [{ slip: slip({ deliveryStatus: "sent" }), employee: employee() }];

    await deliverPayslips(1);
    expect(H.state.sends).toHaveLength(0);

    await deliverPayslips(1, { force: true });
    expect(H.state.sends).toHaveLength(1);
  });

  it("marks an employee with no usable number as skipped instead of failing", async () => {
    H.state.rows = [{ slip: slip(), employee: employee({ phone: "" }) }];

    const out = await deliverPayslips(1);

    expect(out.results[0].outcome).toBe("skipped_no_phone");
    expect(H.state.sends).toHaveLength(0);
    expect(H.state.updates[0].set.deliveryStatus).toBe("failed");
  });

  it("refuses to send for a run that is not approved", async () => {
    H.state.run = { id: 1, period: "2026-07", status: "draft" };
    await expect(deliverPayslips(1)).rejects.toThrow("لا يمكن إرسال الكشوف قبل اعتماد المسير");
  });

  it("passes the requested employee filter through to the query", async () => {
    H.state.rows = [{ slip: slip(), employee: employee() }];

    await deliverPayslips(1, { employeeIds: [100] });
    expect(H.state.queries.at(-1)?.cond).toEqual({
      __op: "and",
      conds: [
        { __op: "eq", value: 1 },
        { __op: "inArray", values: [100] },
      ],
    });

    await deliverPayslips(1);
    expect(H.state.queries.at(-1)?.cond).toEqual({ __op: "eq", value: 1 });
  });
});

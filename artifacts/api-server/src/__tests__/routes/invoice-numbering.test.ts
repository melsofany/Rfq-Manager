import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `nextEntryNo` scans the current max document number and adds one, so two
 * overlapping requests — or a submit retried after a slow response — can
 * compute the same number. The loser hit the unique index and the whole
 * request 500'd (production: repeated `sales_invoices_invoice_no_key`
 * violations, every attempt generating `INV-2026-000001`).
 *
 * `insertWithDocNo` serializes allocation with a per-series advisory lock, and
 * keeps a retry for a unique violation; it must NOT retry any other error.
 * (Measured on a real Postgres: retry alone recovered 5 of 8 concurrent
 * inserts — the lock is what makes it deterministic.)
 */

const selectQueue: any[] = [];

function chainable(rows: any[]): any {
  const api: any = {
    from: vi.fn(() => api),
    where: vi.fn(() => api),
    then: (resolve: any) => Promise.resolve(rows).then(resolve),
  };
  return api;
}

const executeCalls: any[] = [];

vi.mock("@workspace/db", () => {
  return {
    db: {
      select: vi.fn(() => chainable(selectQueue.shift() ?? [])),
      transaction: vi.fn(async (fn: any) =>
        fn({
          select: vi.fn(() => chainable(selectQueue.shift() ?? [])),
          insert: vi.fn(() => ({ values: () => ({ returning: async () => [{ id: 1 }] }) })),
          execute: vi.fn(async (q: any) => {
            executeCalls.push(q);
            return { rows: [] };
          }),
        }),
      ),
    },
    journalEntriesTable: { entryNo: { _: "entryNo" }, id: { _: "id" } },
    journalLinesTable: { _: "journalLines" },
    chartOfAccountsTable: { code: { _: "code" }, id: { _: "id" } },
    salesInvoicesTable: { invoiceNo: { _: "invoiceNo" } },
    supplierInvoicesTable: { invoiceNo: { _: "invoiceNo" } },
    supplierPaymentsTable: { paymentNo: { _: "paymentNo" } },
    ACCOUNT_CODES: {},
  };
});

vi.mock("drizzle-orm", () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      __sql: strings.join("?"),
      values,
    }),
    {},
  ),
  eq: (a: unknown, b: unknown) => ({ __eq: [a, b] }),
  and: (...args: unknown[]) => ({ __and: args }),
  gte: () => ({}),
  lte: () => ({}),
  desc: () => ({}),
}));

const { nextEntryNo, insertWithDocNo } = await import("../../modules/accounts/posting");

/** A unique-index violation as drizzle surfaces it: SQL in the message, the
 * Postgres error (23505) on `cause`. */
function uniqueViolation(): Error {
  const err = new Error(
    'Failed query: insert into "sales_invoices" ...\nparams: INV-2026-000001',
  ) as Error & { cause: unknown };
  err.cause = {
    code: "23505",
    constraint: "sales_invoices_invoice_no_key",
    message: 'duplicate key value violates unique constraint "sales_invoices_invoice_no_key"',
  };
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  executeCalls.length = 0;
});

describe("nextEntryNo", () => {
  it("starts at 000001 when the series is empty", async () => {
    selectQueue.push([]);
    expect(await nextEntryNo("INV", 2026)).toBe("INV-2026-000001");
  });

  it("continues from the highest existing number, ignoring other years", async () => {
    selectQueue.push([
      { no: "INV-2026-000001" },
      { no: "INV-2026-000045" },
      { no: "INV-2026-000007" },
    ]);
    expect(await nextEntryNo("INV", 2026)).toBe("INV-2026-000046");
  });
});

describe("insertWithDocNo", () => {
  it("takes the per-series advisory lock before allocating", async () => {
    selectQueue.push([{ no: "INV-2026-000009" }]);
    const insert = vi.fn(async (docNo: string) => ({ id: 1, invoiceNo: docNo }));
    await insertWithDocNo("INV", "2026-09-22", insert);
    expect(executeCalls.length).toBe(1);
    expect(String(executeCalls[0].__sql)).toContain("pg_advisory_xact_lock");
    expect(executeCalls[0].values).toEqual([7_391_051]);
  });

  it("returns the generated number and the inserted row", async () => {
    selectQueue.push([{ no: "INV-2026-000009" }]);
    const insert = vi.fn(async (docNo: string) => ({ id: 1, invoiceNo: docNo }));
    const { docNo, row } = await insertWithDocNo("INV", "2026-09-22", insert);
    expect(docNo).toBe("INV-2026-000010");
    expect(row).toEqual({ id: 1, invoiceNo: "INV-2026-000010" });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("re-reads and retries when a concurrent request took the number", async () => {
    // First scan still sees the old max (the racing insert isn't committed yet);
    // the second scan sees the winner's row.
    selectQueue.push([{ no: "INV-2026-000009" }]);
    selectQueue.push([{ no: "INV-2026-000010" }]);
    const attempted: string[] = [];
    const insert = vi.fn(async (docNo: string) => {
      attempted.push(docNo);
      if (attempted.length === 1) throw uniqueViolation();
      return { id: 2, invoiceNo: docNo };
    });
    const { docNo } = await insertWithDocNo("INV", "2026-09-22", insert);
    expect(attempted).toEqual(["INV-2026-000010", "INV-2026-000011"]);
    expect(docNo).toBe("INV-2026-000011");
  });

  it("does not retry a non-collision error", async () => {
    selectQueue.push([{ no: "INV-2026-000009" }]);
    const boom = new Error("connection terminated");
    const insert = vi.fn(async () => {
      throw boom;
    });
    await expect(insertWithDocNo("INV", "2026-09-22", insert)).rejects.toBe(boom);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("gives up after repeated collisions with an Arabic error", async () => {
    for (let i = 0; i < 6; i++) selectQueue.push([{ no: "INV-2026-000009" }]);
    const insert = vi.fn(async () => {
      throw uniqueViolation();
    });
    await expect(insertWithDocNo("INV", "2026-09-22", insert)).rejects.toThrow();
    expect(insert).toHaveBeenCalledTimes(5);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The read-only query path borrows a pooled client, opens a transaction and must
 * ALWAYS close it. A query error (a wrong column name, a typo) previously left
 * the transaction open and aborted, and returned the poisoned client to the
 * pool — so every later statement on that connection failed with
 * "current transaction is aborted, commands ignored until end of transaction
 * block", including the assistant's own history insert.
 *
 * These tests assert the connection is returned CLEAN on every path.
 */

const queries: string[] = [];
let failOn: RegExp | null = null;

const client = {
  query: vi.fn(async (sql: string) => {
    queries.push(sql);
    if (failOn && failOn.test(sql)) throw new Error('column "details" does not exist');
    return { rows: [] };
  }),
  release: vi.fn(),
};

vi.mock("@workspace/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPool: () => ({ connect: async () => client }),
}));

const { runReadOnlyQuery } = await import("../../modules/ai-assistant/query-exec");

beforeEach(() => {
  queries.length = 0;
  failOn = null;
  client.query.mockClear();
  client.release.mockClear();
});

describe("runReadOnlyQuery always closes its transaction", () => {
  it("rolls back on the happy path too, and releases once", async () => {
    failOn = null;
    const res = await runReadOnlyQuery("select count(*) from customer_pos");
    expect(res.ok).toBe(true);
    expect(queries).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("ROLLS BACK a failed statement so the pooled client is not left poisoned", async () => {
    failOn = /"details"/;
    const res = await runReadOnlyQuery('select "details" from audit_log');
    expect(res.ok).toBe(false);
    // The bug: this never happened, so the returned connection stayed in an
    // aborted transaction and every later query on it failed.
    expect(queries).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("releases the client exactly once even when both query and rollback fail", async () => {
    failOn = /./; // every statement, including ROLLBACK, throws
    const res = await runReadOnlyQuery("select 1");
    expect(res.ok).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

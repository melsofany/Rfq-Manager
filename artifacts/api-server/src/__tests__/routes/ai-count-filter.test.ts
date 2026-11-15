/**
 * «كام طلب تسعير مفتوح دلوقتي؟» was answered with the TABLE TOTAL (4,738).
 *
 * The tool could only count everything or the last N days, so the model had no
 * way to express the filter and reported the total under the question's own word
 * («مفتوح») — a confident, wrong answer. The fix adds `status` (a filtered
 * count) and `distinctStatus` (the values that actually exist), so the word can
 * be mapped onto data instead of invented.
 *
 * `distinctStatus` matters as much as the filter: the column holds `draft`/
 * `sent`, and a model asked for «مفتوح» would otherwise guess a value like
 * `open` that matches nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const chain: Record<string, unknown> = {};
  const make = () => {
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.groupBy = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve(hoisted.rows));
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(hoisted.rows).then(res);
    return chain;
  };
  return { rows: [] as unknown[], chain: make(), sql: (s: TemplateStringsArray) => s.join("") };
});

// A Proxy returns a stable identity for EVERY export, so the suite stays correct
// as `db-tools`'s import list grows (enumerating tables by hand makes it fail as
// a confusing "No X export" before any assertion runs).
vi.mock("@workspace/db", async (importOriginal) => {
  // `importOriginal` supplies every table handle the module imports (enumerating
  // them by hand breaks as a confusing "No X export" the moment the import list
  // grows). Only the query builder is replaced, so the real table objects — with
  // their real column definitions — reach the registry.
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const chain = (): Record<string, unknown> => ({
    select: () => chain(),
    from: () => chain(),
    where: () => chain(),
    groupBy: () => chain(),
    orderBy: () => chain(),
    limit: () => Promise.resolve(hoisted.rows),
    then: (res: (v: unknown) => unknown) => Promise.resolve(hoisted.rows).then(res),
  });
  return { ...actual, getPool: () => null, db: { select: () => chain() } };
});

describe("countRecords", () => {
  beforeEach(() => {
    hoisted.rows.length = 0;
    hoisted.rows.push({ cnt: 7 });
  });

  it("returns the count and the status it filtered on", async () => {
    const { countRecords } = await import("../../modules/ai-assistant/db-tools");
    const r = await countRecords({ table: "customer_rfqs", status: "draft" });
    expect(r.count).toBe(7);
    expect(r.status).toBe("draft");
  });

  it("reports the statuses that EXIST when asked, never a guessed one", async () => {
    hoisted.rows.length = 0;
    hoisted.rows.push({ value: "sent", cnt: 4073 }, { value: "draft", cnt: 671 });
    const { countRecords } = await import("../../modules/ai-assistant/db-tools");
    const r = await countRecords({ table: "customer_rfqs", distinctStatus: true });
    expect(r.statuses).toEqual([
      { value: "sent", count: 4073 },
      { value: "draft", count: 671 },
    ]);
    // The total is available, but it is NOT presented as a filtered answer.
    expect(r.count).toBe(4744);
  });

  it("refuses a status filter on a table without a status column", async () => {
    const { countRecords } = await import("../../modules/ai-assistant/db-tools");
    await expect(countRecords({ table: "no_such_table", status: "draft" })).rejects.toThrow();
  });
});

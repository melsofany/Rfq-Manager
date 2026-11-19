/**
 * LIVE Postgres test for the duplicate-RFQ guard.
 *
 * The mocked route tests cannot see this: the whole point of the fix is a SQL
 * predicate (`lower(regexp_replace(btrim(...)))`) that a mocked `select` never
 * executes. Here the REAL predicate runs against a REAL engine, so a predicate
 * that does not match `normalizeRfqNumber` fails loudly instead of passing
 * against a mock that returns whatever it is given.
 *
 * Runs ONLY when `TEST_DATABASE_URL` is set (CI without a database skips it).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
// Own schema so parallel live suites cannot drop each other's tables.
const SCHEMA = "live_rfq_dup";
if (TEST_DB) {
  const u = new URL(TEST_DB);
  u.searchParams.set("options", `-csearch_path=${SCHEMA},public`);
  process.env.DATABASE_URL = u.toString();
}

const suite = TEST_DB ? describe : describe.skip;

suite("duplicate RFQ guard — live Postgres", () => {
  let pool: any;

  beforeAll(async () => {
    const { getPool } = await import("@workspace/db");
    pool = getPool();
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await pool.query(`DROP TABLE IF EXISTS rfq_items CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS rfq CASCADE`);
    await pool.query(
      `CREATE TABLE rfq (
         id serial PRIMARY KEY,
         internal_rfq_no text NOT NULL UNIQUE,
         customer_rfq_no text NOT NULL,
         status text NOT NULL DEFAULT 'DRAFT',
         expires_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await pool.query(
      `CREATE TABLE rfq_items (
         id serial PRIMARY KEY,
         rfq_id integer NOT NULL REFERENCES rfq(id) ON DELETE CASCADE,
         part_no text,
         line_item text,
         description text NOT NULL
       )`,
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  // The exact predicate the route builds, run against real rows.
  async function findExisting(customerRfqNo: string) {
    const { normalizeRfqNumber, customerNoMatchSql } = await import("../../shared/rfq-identity");
    const { rfqTable } = await import("@workspace/db");
    const { db } = await import("@workspace/db");
    const normalized = normalizeRfqNumber(customerRfqNo);
    const rows = await db
      .select({ id: rfqTable.id, customerRfqNo: rfqTable.customerRfqNo, status: rfqTable.status })
      .from(rfqTable)
      .where(customerNoMatchSql(rfqTable.customerRfqNo, normalized));
    return rows;
  }

  it("matches a stored number that differs only by padding or letter case", async () => {
    // The real duplicates measured on production: 5 rows differ by padding,
    // 18 by letter case. A raw-string compare finds none of them.
    await pool.query(
      `INSERT INTO rfq (internal_rfq_no, customer_rfq_no, status) VALUES
         ('CRQ-T1', ' Almaza0005 ', 'QUOTED'),
         ('CRQ-T2', 'Almaza0005', 'FAILED')`,
    );
    const rows = await findExisting("almaza0005");
    expect(rows.map((r: any) => r.id).length).toBe(2);
  });

  it("does NOT merge two different customer requests", async () => {
    // A guard that over-matches is worse than the duplicate it prevents: it
    // would attach one customer's offers to another's request.
    await pool.query(
      `INSERT INTO rfq (internal_rfq_no, customer_rfq_no, status) VALUES
         ('CRQ-T3', '26R007225', 'QUOTED'),
         ('CRQ-T4', '26R007226', 'QUOTED')`,
    );
    const rows = await findExisting("26R007225");
    expect(rows.map((r: any) => r.customerRfqNo)).toEqual(["26R007225"]);
  });

  it("treats an inner-whitespace difference as the same number", async () => {
    await pool.query(
      `INSERT INTO rfq (internal_rfq_no, customer_rfq_no, status) VALUES
         ('CRQ-T5', 'Mohamed  Alaa  Soliman', 'SENT')`,
    );
    const rows = await findExisting("Mohamed Alaa Soliman");
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("ranks the open row first so the reuse continues the live comparison", async () => {
    const { pickExistingRfq } = await import("../../shared/rfq-identity");
    const rows = await findExisting("almaza0005");
    const counts = await pool.query(
      `SELECT rfq_id, count(*)::int AS n FROM rfq_items WHERE rfq_id = ANY($1) GROUP BY rfq_id`,
      [rows.map((r: any) => r.id)],
    );
    const map = new Map(counts.rows.map((c: any) => [c.rfq_id, c.n]));
    const best = pickExistingRfq(rows.map((r: any) => ({ ...r, itemCount: map.get(r.id) ?? 0 })));
    // QUOTED is open; FAILED is terminal — continuing the terminal row would
    // resurrect a request the expiry sweep already closed.
    expect(best?.status).toBe("QUOTED");
  });
});

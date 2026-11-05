import { describe, it, expect, beforeAll } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
// Each live suite gets its OWN Postgres schema so the files can run in parallel
// without dropping each other's tables.
const SCHEMA = "live_fin";
if (TEST_DB) {
  const u = new URL(TEST_DB);
  u.searchParams.set("options", `-csearch_path=${SCHEMA},public`);
  process.env.DATABASE_URL = u.toString();
}
const suite = TEST_DB ? describe : describe.skip;

suite("finance migration on a PRE-EXISTING database", () => {
  let pool: any;
  beforeAll(async () => {
    const { getPool } = await import("@workspace/db");
    pool = getPool();
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    // The PGlite socket server outlives a single vitest run, so start from a
    // clean slate or rows from a previous run leak into the assertions.
    await pool.query(`DROP TABLE IF EXISTS finance_payments CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS finance_payment_requests CASCADE`);
    // Build the tables as they exist on a deployed database, BEFORE this change:
    // finance_payments has no payment_no, and finance_supplier_statements does
    // not exist at all.
    await pool.query(`CREATE TABLE IF NOT EXISTS finance_payment_requests (
      id SERIAL PRIMARY KEY, po_id INTEGER, supplier_id INTEGER, supplier_name TEXT,
      internal_po_no TEXT, po_no TEXT, due_amount NUMERIC(15,4) NOT NULL DEFAULT 0,
      paid_amount NUMERIC(15,4) NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'unpaid',
      selected_at TIMESTAMPTZ NOT NULL DEFAULT now(), employee_id INTEGER, employee_name TEXT,
      notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS finance_payments (
      id SERIAL PRIMARY KEY, request_id INTEGER NOT NULL, amount NUMERIC(15,4) NOT NULL,
      payment_date TEXT NOT NULL, method TEXT NOT NULL, reference TEXT, notes TEXT,
      employee_id INTEGER, employee_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    // A row must survive the migration.
    await pool.query(
      `INSERT INTO finance_payments (request_id, amount, payment_date, method) VALUES (1, 400, '2026-11-01', 'نقدية')`,
    );
    const { initDb } = await import("../../shared/init-db");
    await initDb();
  }, 180_000);

  it("adds payment_no to the pre-existing finance_payments table", async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'finance_payments' AND column_name = 'payment_no'`,
    );
    expect(cols.rows).toHaveLength(1);
  });

  it("creates finance_supplier_statements with its unique index", async () => {
    const t = await pool.query(`SELECT to_regclass('public.finance_supplier_statements') AS t`);
    expect(t.rows[0].t).toBe("finance_supplier_statements");
    const idx = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'finance_supplier_statements'`,
    );
    const defs: string[] = idx.rows.map((r: any) => r.indexdef);
    expect(defs.some((d) => d.includes("finance_supplier_statements_no_uq"))).toBe(true);
    const uq = defs.find((d) => d.includes("finance_supplier_statements_no_uq"))!;
    expect(uq.toLowerCase()).toContain("unique");
  });

  it("keeps the pre-existing payment row", async () => {
    const r = await pool.query(
      `SELECT amount, payment_no FROM finance_payments WHERE amount = 400`,
    );
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0].amount)).toBe(400);
    expect(r.rows[0].payment_no).toBeNull();
  });

  it("allows repeated NULL payment_no but rejects a duplicate number", async () => {
    // Two un-numbered legacy rows must coexist (a UNIQUE index treats NULLs as
    // distinct). Both are inserted BEFORE the duplicate attempt: under the
    // PGlite socket server a rejected statement tears down the connection, so
    // the provoking insert has to be the last operation in this suite.
    await pool.query(
      `INSERT INTO finance_payments (request_id, amount, payment_date, method) VALUES (1, 1, '2026-11-02', 'نقدية')`,
    );
    await pool.query(
      `INSERT INTO finance_payments (request_id, amount, payment_date, method) VALUES (1, 2, '2026-11-02', 'نقدية')`,
    );
    const nulls = await pool.query(
      `SELECT count(*)::int AS n FROM finance_payments WHERE payment_no IS NULL`,
    );
    expect(nulls.rows[0].n).toBe(3);

    await pool.query(
      `INSERT INTO finance_payments (request_id, amount, payment_date, method, payment_no)
       VALUES (1, 100, '2026-11-02', 'شيك', 'PAY-2026-000001')`,
    );
    let failed = false;
    try {
      await pool.query(
        `INSERT INTO finance_payments (request_id, amount, payment_date, method, payment_no)
         VALUES (1, 100, '2026-11-02', 'شيك', 'PAY-2026-000001')`,
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});

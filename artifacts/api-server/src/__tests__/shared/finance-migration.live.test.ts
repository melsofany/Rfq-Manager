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
    const t = await pool.query(`SELECT to_regclass('finance_supplier_statements') AS t`);
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

  // ── سداد إجمالي للمورد ────────────────────────────────────────────────────
  // The bulk payment order is a NEW table, and a `CREATE TABLE IF NOT EXISTS`
  // is a no-op on a deployed database — so these guards are what prove the DDL
  // actually reaches production rather than only a fresh install.

  it("creates finance_bulk_payments with its unique number index", async () => {
    const t = await pool.query(`SELECT to_regclass('finance_bulk_payments') AS t`);
    expect(t.rows[0].t).toBe("finance_bulk_payments");
    const idx = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'finance_bulk_payments'`,
    );
    const defs: string[] = idx.rows.map((r: any) => r.indexdef);
    const uq = defs.find((d) => d.includes("finance_bulk_payments_no_uq"));
    expect(uq).toBeTruthy();
    // The number must be unique or two transfers could share one document id.
    expect(uq!.toLowerCase()).toContain("unique");
  });

  it("creates finance_payment_allocations and links it to both sides", async () => {
    const t = await pool.query(`SELECT to_regclass('finance_payment_allocations') AS t`);
    expect(t.rows[0].t).toBe("finance_payment_allocations");
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'finance_payment_allocations'`,
    );
    const names = cols.rows.map((r: any) => r.column_name);
    // bulk_payment_id is what makes the lines ONE document; request_id is which
    // order received the money; payment_id lets a deleted payment drop its line.
    expect(names).toContain("bulk_payment_id");
    expect(names).toContain("request_id");
    expect(names).toContain("payment_id");
    expect(names).toContain("amount");
  });

  it("lets one bulk document own several allocation lines", async () => {
    // The allocation has an FK to the request, so the orders must exist first —
    // otherwise the insert is rejected for the wrong reason and the test would
    // pass without proving anything about the document.
    await pool.query(
      `INSERT INTO finance_payment_requests (id, po_id, supplier_id, supplier_name, due_amount, paid_amount, status)
       VALUES (901, 1, 1, 'sinamix', 100, 0, 'unpaid'),
              (902, 2, 1, 'sinamix', 150, 0, 'unpaid')`,
    );
    await pool.query(
      `INSERT INTO finance_bulk_payments
         (payment_no, supplier_id, supplier_name, amount, payment_date, method, order_count)
       VALUES ('PAY-2026-000900', 1, 'sinamix', 250, '2026-11-03', 'تحويل بنكي', 2)`,
    );
    const bulk = await pool.query(
      `SELECT id FROM finance_bulk_payments WHERE payment_no = 'PAY-2026-000900'`,
    );
    const bulkId = bulk.rows[0].id;
    // Two lines under ONE document — the whole point of the feature.
    await pool.query(
      `INSERT INTO finance_payment_allocations (bulk_payment_id, request_id, amount)
       VALUES ($1, 901, 100), ($1, 902, 150)`,
      [bulkId],
    );
    const allocs = await pool.query(
      `SELECT count(*)::int AS n, sum(amount)::numeric AS total
         FROM finance_payment_allocations WHERE bulk_payment_id = $1`,
      [bulkId],
    );
    expect(allocs.rows[0].n).toBe(2);
    expect(Number(allocs.rows[0].total)).toBe(250);
  });

  it("cascades allocations away when their document is deleted", async () => {
    const bulk = await pool.query(
      `SELECT id FROM finance_bulk_payments WHERE payment_no = 'PAY-2026-000900'`,
    );
    const bulkId = bulk.rows[0].id;
    await pool.query(`DELETE FROM finance_bulk_payments WHERE id = $1`, [bulkId]);
    const left = await pool.query(
      `SELECT count(*)::int AS n FROM finance_payment_allocations WHERE bulk_payment_id = $1`,
      [bulkId],
    );
    // An orphaned line would report a split for a document that no longer exists.
    expect(left.rows[0].n).toBe(0);
  });
});

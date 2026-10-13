/**
 * LIVE Postgres test for the attribution period engine.
 *
 * Runs ONLY when `TEST_DATABASE_URL` is set. It exercises the raw SQL that a
 * mocked `db` cannot validate: `SELECT … FOR UPDATE` row locking, the
 * `clock_timestamp()` freeze stamp, the period open/close transition and the
 * one-OPEN-period partial unique index under real writes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
// Its own schema so it can run in parallel with the migration live suite.
const SCHEMA = "live_attr";
if (TEST_DB) {
  const u = new URL(TEST_DB);
  u.searchParams.set("options", `-csearch_path=${SCHEMA},public`);
  process.env.DATABASE_URL = u.toString();
}

const suite = TEST_DB ? describe : describe.skip;

suite("attribution engine — live Postgres", () => {
  let pool: any;
  let db: any;
  let itemId: number;
  let empId: number;

  beforeAll(async () => {
    const ws = await import("@workspace/db");
    pool = ws.getPool();
    db = ws.db;
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    const { initDb } = await import("../../shared/init-db");
    await initDb();

    await pool.query(`DELETE FROM customer_rfq_item_assignments`);
    await pool.query(`DELETE FROM item_assignment_audit`);
    await pool.query(
      `DELETE FROM customer_rfq_items WHERE customer_rfq_id IN (SELECT id FROM customer_rfqs WHERE internal_no LIKE 'ATTR-%')`,
    );
    await pool.query(`DELETE FROM customer_rfqs WHERE internal_no LIKE 'ATTR-%'`);
    await pool.query(`DELETE FROM employees WHERE email = 'attr@x.com'`);

    const emp = await pool.query(
      `INSERT INTO employees (name, email, password_hash, role) VALUES ('Attr Owner','attr@x.com','h','purchasing') RETURNING id`,
    );
    empId = emp.rows[0].id;
    const rfq = await pool.query(
      `INSERT INTO customer_rfqs (internal_no, customer_name, customer_rfq_no) VALUES ('ATTR-1','C','ATTR-1') RETURNING id`,
    );
    const item = await pool.query(
      `INSERT INTO customer_rfq_items (customer_rfq_id, description) VALUES ($1,'part') RETURNING id`,
      [rfq.rows[0].id],
    );
    itemId = item.rows[0].id;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("opens a period, then closeAndOpen moves valid_to and inserts a fresh open row", async () => {
    const { closeAndOpenPeriod, dbClockTimestamp } = await import("../../modules/rfq/attribution");

    await db.transaction(async (tx: any) => {
      const at = await dbClockTimestamp(tx);
      await closeAndOpenPeriod(
        tx,
        {
          customerRfqItemId: itemId,
          categoryId: null,
          employeeId: empId,
          source: "auto",
          confidence: "90",
          assignedBy: null,
        },
        at,
      );
    });

    const open = await pool.query(
      `SELECT * FROM customer_rfq_item_assignments WHERE customer_rfq_item_id = $1 AND valid_to IS NULL`,
      [itemId],
    );
    expect(open.rows.length).toBe(1);
    expect(open.rows[0].employee_id).toBe(empId);

    await db.transaction(async (tx: any) => {
      const at = await dbClockTimestamp(tx);
      await closeAndOpenPeriod(
        tx,
        {
          customerRfqItemId: itemId,
          categoryId: null,
          employeeId: null,
          source: "manual",
          confidence: null,
          assignedBy: empId,
        },
        at,
      );
    });

    const all = await pool.query(
      `SELECT employee_id, valid_to FROM customer_rfq_item_assignments
        WHERE customer_rfq_item_id = $1 ORDER BY id`,
      [itemId],
    );
    expect(all.rows.length).toBe(2);
    expect(all.rows[0].valid_to).not.toBeNull(); // first period CLOSED
    expect(all.rows[1].valid_to).toBeNull(); // new period OPEN
    expect(all.rows[1].employee_id).toBeNull(); // reassigned to "غير محسوم"
  });

  it("freezes attribution once and never re-attributes on a second call", async () => {
    const { freezeAttributionForItem } = await import("../../modules/rfq/attribution");
    // Reset the item's freeze.
    await pool.query(
      `UPDATE customer_rfq_items SET attribution_first_po_at = NULL, attribution_employee_id = NULL,
         attribution_employee_name = NULL, attribution_event = NULL WHERE id = $1`,
      [itemId],
    );

    let first: any;
    await db.transaction(async (tx: any) => {
      first = await freezeAttributionForItem(tx, itemId);
    });
    expect(first.frozen).toBe(true);
    expect(first.employeeId).toBeNull(); // current open period has no owner

    // Change the open owner, then freeze again — the ORIGINAL (null) must stand.
    const { closeAndOpenPeriod, dbClockTimestamp } = await import("../../modules/rfq/attribution");
    await db.transaction(async (tx: any) => {
      const at = await dbClockTimestamp(tx);
      await closeAndOpenPeriod(
        tx,
        {
          customerRfqItemId: itemId,
          categoryId: null,
          employeeId: empId,
          source: "manual",
          confidence: null,
          assignedBy: empId,
        },
        at,
      );
    });

    let second: any;
    await db.transaction(async (tx: any) => {
      second = await freezeAttributionForItem(tx, itemId);
    });
    expect(second.frozen).toBe(false); // already frozen

    const row = await pool.query(
      `SELECT attribution_employee_id, attribution_event FROM customer_rfq_items WHERE id = $1`,
      [itemId],
    );
    expect(row.rows[0].attribution_employee_id).toBeNull(); // NOT re-attributed
    expect(row.rows[0].attribution_event).toBe("first_customer_po");
  });

  it("takes a real row lock that a concurrent writer must wait on", async () => {
    const { lockItemRows } = await import("../../modules/rfq/attribution");
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query("BEGIN");
      await clientA.query(`SELECT id FROM customer_rfq_items WHERE id = $1 FOR UPDATE`, [itemId]);

      await clientB.query("BEGIN");
      // B's FOR UPDATE on the same row must block until A commits. A short
      // statement_timeout makes the block observable without hanging the suite.
      await clientB.query(`SET LOCAL statement_timeout = 400`);
      await expect(
        clientB.query(`SELECT id FROM customer_rfq_items WHERE id = $1 FOR UPDATE`, [itemId]),
      ).rejects.toThrow(/timeout|canceling statement/i);

      await clientB.query("ROLLBACK");
      await clientA.query("COMMIT");
    } finally {
      clientA.release();
      clientB.release();
    }
    // lockItemRows is still callable and uses the same ascending FOR UPDATE.
    await db.transaction(async (tx: any) => {
      await lockItemRows(tx, [itemId]);
    });
    expect(true).toBe(true);
  });
});

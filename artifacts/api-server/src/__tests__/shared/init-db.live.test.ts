/**
 * LIVE Postgres integration test for the responsibility migration.
 *
 * Runs ONLY when `TEST_DATABASE_URL` is set (a throwaway database — the test
 * truncates/creates tables). CI without a database skips it, so the mocked
 * `init-db.test.ts` stays the fast unit guard while this proves the DDL actually
 * applies to a real engine: the partial unique index, the gist EXCLUDE overlap
 * guard, the RESTRICT foreign keys, and idempotent re-run / partial-resume.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
// Each live suite gets its OWN Postgres schema so the files can run in parallel
// without dropping each other's tables.
const SCHEMA = "live_mig";
if (TEST_DB) {
  const u = new URL(TEST_DB);
  u.searchParams.set("options", `-csearch_path=${SCHEMA},public`);
  process.env.DATABASE_URL = u.toString();
}

const suite = TEST_DB ? describe : describe.skip;

suite("init-db migration — live Postgres", () => {
  // `pool` comes from @workspace/db (which depends on `pg`); api-server itself
  // does not list `pg`, so importing it directly is not resolvable here.
  let pool: any;

  beforeAll(async () => {
    const { getPool } = await import("@workspace/db");
    pool = getPool();
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    // Clean slate for the responsibility-related objects.
    await pool.query(`DROP TABLE IF EXISTS customer_rfq_item_assignments CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS customer_po_item_deliveries CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS customer_po_items CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS customer_rfqs CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS employees CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS customers CASCADE`);
    const { initDb } = await import("../../shared/init-db");
    await initDb();
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("creates the partial unique index and drops the absolute one", async () => {
    const idx = await pool.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'customer_rfq_item_assignments'`,
    );
    const defs: string[] = idx.rows.map((r: any) => r.indexdef);
    expect(defs.some((d) => d.includes("customer_rfq_item_assignments_open_uq"))).toBe(true);
    expect(defs.some((d) => d.includes("customer_rfq_item_assignments_item_uq"))).toBe(false);
    const openUq = defs.find((d) => d.includes("customer_rfq_item_assignments_open_uq"))!;
    expect(openUq.toLowerCase()).toContain("where");
    expect(openUq.toLowerCase()).toContain("valid_to is null");
  });

  it("creates the gist EXCLUDE overlap guard with the expected definition", async () => {
    const ext = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`);
    expect(ext.rows.length).toBe(1); // btree_gist was available
    const c = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'customer_rfq_item_assignments_no_overlap'
          AND conrelid = 'customer_rfq_item_assignments'::regclass`,
    );
    expect(c.rows.length).toBe(1);
    expect(c.rows[0].def).toContain("EXCLUDE USING gist");
    expect(c.rows[0].def).toContain("&&");
  });

  it("uses RESTRICT on every FK that protects responsibility history", async () => {
    const fks = await pool.query(
      `SELECT c.conname, c.confdeltype, a.attname
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'f'
          AND c.conrelid IN (
            'customer_rfq_item_assignments'::regclass,
            'customer_po_items'::regclass
          )`,
    );
    const del = new Map<string, string>(fks.rows.map((r: any) => [r.attname, r.confdeltype]));
    // 'r' = RESTRICT
    expect(del.get("employee_id")).toBe("r");
    expect(del.get("customer_rfq_item_id")).toBe("r");
  });

  it("adds the attribution + soft-cancel + delivery-void columns", async () => {
    const cols = async (t: string) =>
      (
        await pool.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
          [t],
        )
      ).rows.map((r: any) => r.column_name);
    const itemCols = await cols("customer_rfq_items");
    expect(itemCols).toEqual(
      expect.arrayContaining([
        "is_cancelled",
        "attribution_first_po_at",
        "attribution_employee_id",
        "attribution_employee_name",
        "attribution_event",
      ]),
    );
    const delCols = await cols("customer_po_item_deliveries");
    expect(delCols).toEqual(
      expect.arrayContaining([
        "idempotency_key",
        "operation_key",
        "payload_hash",
        "wa_message_id",
        "voided",
        "voided_at",
        "voided_by",
        "voided_by_name",
        "void_reason",
      ]),
    );
  });

  it("enforces one OPEN period per item but allows many CLOSED periods", async () => {
    const emp = await pool.query(
      `INSERT INTO employees (name, email, password_hash, role) VALUES ('E','e@x.com','h','purchasing') RETURNING id`,
    );
    const empId = emp.rows[0].id;
    const cust = await pool.query(`INSERT INTO customers (name) VALUES ('C') RETURNING id`);
    const rfq = await pool.query(
      `INSERT INTO customer_rfqs (internal_no, customer_name, customer_rfq_no) VALUES ('CRFQ-X','C','X-1') RETURNING id`,
    );
    const item = await pool.query(
      `INSERT INTO customer_rfq_items (customer_rfq_id) VALUES ($1) RETURNING id`,
      [rfq.rows[0].id],
    );
    const itemId = item.rows[0].id;

    // Two closed periods for the same item are fine.
    await pool.query(
      `INSERT INTO customer_rfq_item_assignments
         (customer_rfq_item_id, employee_id, source, valid_from, valid_to)
       VALUES ($1,$2,'auto','2025-01-01','2025-02-01'), ($1,$2,'manual','2025-02-01','2025-03-01')`,
      [itemId, empId],
    );
    // A single open period is fine.
    await pool.query(
      `INSERT INTO customer_rfq_item_assignments
         (customer_rfq_item_id, employee_id, source, valid_from)
       VALUES ($1,$2,'manual','2025-03-01')`,
      [itemId, empId],
    );
    // A SECOND open period must be rejected by the partial unique index.
    await expect(
      pool.query(
        `INSERT INTO customer_rfq_item_assignments
           (customer_rfq_item_id, employee_id, source, valid_from)
         VALUES ($1,$2,'auto','2025-04-01')`,
        [itemId, empId],
      ),
    ).rejects.toThrow(/duplicate key|open_uq/);
    expect(cust.rows.length).toBe(1);
  });

  it("rejects an OVERLAPPING period via the gist EXCLUDE constraint", async () => {
    const rfq = await pool.query(
      `INSERT INTO customer_rfqs (internal_no, customer_name, customer_rfq_no) VALUES ('CRFQ-Y','C','Y-1') RETURNING id`,
    );
    const item = await pool.query(
      `INSERT INTO customer_rfq_items (customer_rfq_id) VALUES ($1) RETURNING id`,
      [rfq.rows[0].id],
    );
    const itemId = item.rows[0].id;
    await pool.query(
      `INSERT INTO customer_rfq_item_assignments
         (customer_rfq_item_id, source, valid_from, valid_to)
       VALUES ($1,'auto','2025-01-01','2025-06-01')`,
      [itemId],
    );
    // An overlapping CLOSED period (both rows closed → the unique index does not
    // apply, so ONLY the EXCLUDE can catch it).
    await expect(
      pool.query(
        `INSERT INTO customer_rfq_item_assignments
           (customer_rfq_item_id, source, valid_from, valid_to)
         VALUES ($1,'manual','2025-03-01','2025-09-01')`,
        [itemId],
      ),
    ).rejects.toThrow(/conflicting key|no_overlap|exclusion/i);
  });

  it("is idempotent — a second initDb() run applies cleanly", async () => {
    const { initDb } = await import("../../shared/init-db");
    await expect(initDb()).resolves.toBeUndefined();
    const c = await pool.query(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conname = 'customer_rfq_item_assignments_no_overlap'
          AND conrelid = 'customer_rfq_item_assignments'::regclass`,
    );
    expect(c.rows[0].n).toBe(1);
  });

  it("resumes a PARTIAL migration — a dropped constraint is recreated", async () => {
    await pool.query(
      `ALTER TABLE customer_rfq_item_assignments DROP CONSTRAINT customer_rfq_item_assignments_no_overlap`,
    );
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conname = 'customer_rfq_item_assignments_no_overlap'
          AND conrelid = 'customer_rfq_item_assignments'::regclass`,
    );
    expect(before.rows[0].n).toBe(0);
    const { initDb } = await import("../../shared/init-db");
    await initDb();
    const after = await pool.query(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conname = 'customer_rfq_item_assignments_no_overlap'
          AND conrelid = 'customer_rfq_item_assignments'::regclass`,
    );
    expect(after.rows[0].n).toBe(1);
  });

  it("replaces a constraint whose DEFINITION is wrong (not just its name)", async () => {
    // Clear rows first: the wrong definition below would be rejected on data
    // that already has several periods for one item.
    await pool.query(`DELETE FROM customer_rfq_item_assignments`);
    // Simulate a stale definition by recreating it without the tstzrange form.
    await pool.query(
      `ALTER TABLE customer_rfq_item_assignments DROP CONSTRAINT customer_rfq_item_assignments_no_overlap`,
    );
    await pool.query(
      `ALTER TABLE customer_rfq_item_assignments ADD CONSTRAINT customer_rfq_item_assignments_no_overlap
         EXCLUDE USING gist (customer_rfq_item_id WITH =)`,
    );
    const { initDb } = await import("../../shared/init-db");
    await initDb();
    const c = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'customer_rfq_item_assignments_no_overlap'`,
    );
    expect(c.rows[0].def).toContain("tstzrange");
    expect(c.rows[0].def).toContain("&&");
  });
});

/**
 * Category de-duplication — verified against a REAL Postgres (PGlite).
 *
 * The unit tests prove the plan and the shape of the SQL; only a real database
 * proves the SQL RUNS and moves the references. A mocked `update` cannot see a
 * missing `WHERE`, an ambiguous column, or a unique index that rejects a move —
 * which is exactly how the previous repair shipped broken.
 *
 * Gated on PGlite being importable, so a CI image without it skips rather than
 * fails. Run locally with the package on `NODE_PATH`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  categoryDedupeSql,
  CATEGORY_REFERENCES,
  CATEGORY_UNIQUE_EXPR,
  planCategoryDedupe,
  refCountExpr,
} from "../../shared/category-dedupe";

let PGliteCtor: any = null;
try {
  ({ PGlite: PGliteCtor } = await import("@electric-sql/pglite" as string));
} catch {
  PGliteCtor = null;
}
const suite = PGliteCtor ? describe : describe.skip;

const DDL = `
  CREATE TABLE supplier_categories (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    parent_id INTEGER, is_active BOOLEAN NOT NULL DEFAULT true, deleted_at TIMESTAMPTZ);
  CREATE TABLE supplier_category_links (id SERIAL PRIMARY KEY, supplier_id INTEGER NOT NULL,
    category_id INTEGER NOT NULL, UNIQUE (supplier_id, category_id));
  CREATE TABLE item_categories (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, code TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true, deleted_at TIMESTAMPTZ, parent_id INTEGER);
  CREATE TABLE rfq_items (id SERIAL PRIMARY KEY, category_id INTEGER);
  CREATE TABLE customer_rfq_items (id SERIAL PRIMARY KEY, category_id INTEGER, suggested_category_id INTEGER);
  CREATE TABLE purchase_order_items (id SERIAL PRIMARY KEY, category_id INTEGER);
  CREATE TABLE customer_rfq_item_categories (id SERIAL PRIMARY KEY, customer_rfq_item_id INTEGER,
    category_id INTEGER, UNIQUE (customer_rfq_item_id, category_id));
  CREATE TABLE employee_categories (id SERIAL PRIMARY KEY, employee_id INTEGER, category_id INTEGER,
    UNIQUE (employee_id, category_id));
  CREATE TABLE customer_rfq_item_assignments (id SERIAL PRIMARY KEY, category_id INTEGER);
  CREATE TABLE rfq_item_assignments (id SERIAL PRIMARY KEY, category_id INTEGER);
  CREATE TABLE item_category_keywords (id SERIAL PRIMARY KEY, category_id INTEGER, keyword TEXT,
    UNIQUE (category_id, keyword));
  CREATE TABLE item_category_aliases (id SERIAL PRIMARY KEY, category_id INTEGER, alias TEXT UNIQUE);
  CREATE TABLE item_classification_identity (id SERIAL PRIMARY KEY, category_id INTEGER,
    identity_key TEXT UNIQUE);
  CREATE TABLE supplier_item_category_links (id SERIAL PRIMARY KEY, supplier_id INTEGER,
    category_id INTEGER, UNIQUE (supplier_id, category_id));
`;

suite("category dedupe on a REAL Postgres", () => {
  let db: any;
  let seeded: Record<string, any> = {};

  beforeAll(async () => {
    db = new PGliteCtor();
    await db.exec(DDL);
    await seed();
    seeded = (await counts()).rows[0];
    // Same ORDER as init-db.ts: the raw-name constraints go first (the repair
    // renames the survivor, which collides with the retired twin otherwise),
    // the functional indexes after.
    await db.exec(
      `ALTER TABLE supplier_categories DROP CONSTRAINT IF EXISTS supplier_categories_name_key;`,
    );
    await db.exec(
      `ALTER TABLE item_categories DROP CONSTRAINT IF EXISTS item_categories_name_key;`,
    );
    await runDedupe();
    await addPreventionIndexes();
  });

  /** The production shape: the spaced copy is EMPTY, the canonical row has all. */
  async function seed() {
    await db.exec(`
      INSERT INTO supplier_categories (id,name,is_active,deleted_at) VALUES
        (2,'معدات فندقيه',false,NOW()), (2332,'معدات  فندقيه',true,NULL),
        (17,'3m schotch',true,NULL), (2338,'3m   schotch',true,NULL),
        (24,'لواصق شحوم وسيلكون و CRC',false,NOW()), (2334,'لواصق  شحوم  وسيلكون و  CRC',true,NULL);
      SELECT setval('supplier_categories_id_seq', 2400);
      INSERT INTO supplier_category_links (supplier_id, category_id) SELECT g, 2332 FROM generate_series(1,14) g;
      INSERT INTO supplier_category_links (supplier_id, category_id) VALUES (1,17),(2,17),(3,17);
      INSERT INTO supplier_category_links (supplier_id, category_id) VALUES (1,2338),(2,2338),(3,2338),(4,2338);
      INSERT INTO supplier_category_links (supplier_id, category_id) SELECT g, 2334 FROM generate_series(20,23) g;

      INSERT INTO item_categories (id,name,is_active,deleted_at) VALUES
        (27,'معدات فندقيه',true,NULL), (5218,'معدات  فندقيه',true,NULL),
        (41,'3m schotch',true,NULL), (5224,'3m   schotch',true,NULL),
        (34,'اسطوانات غاز وادوات لحام وتنكات',true,NULL), (5219,'اسطوانات غاز وادوات لحام  وتنكات',true,NULL);
      SELECT setval('item_categories_id_seq', 6000);
      INSERT INTO customer_rfq_items (category_id) SELECT 27 FROM generate_series(1,20);
      INSERT INTO customer_rfq_items (category_id) VALUES (41),(41);
      INSERT INTO employee_categories (employee_id, category_id) VALUES (7,41);
      INSERT INTO customer_rfq_item_assignments (category_id) VALUES (41),(41);
      INSERT INTO customer_rfq_items (category_id) SELECT 34 FROM generate_series(1,116);
      INSERT INTO employee_categories (employee_id, category_id) VALUES (7,34);
      INSERT INTO customer_rfq_item_assignments (category_id) SELECT 34 FROM generate_series(1,116);
      INSERT INTO item_category_keywords (category_id, keyword) SELECT 34, 'kw'||g FROM generate_series(1,4) g;
      INSERT INTO item_classification_identity (category_id, identity_key) SELECT 34, 'k'||g FROM generate_series(1,39) g;
    `);
  }

  /** Every relation's row count — the "nothing was lost" measurement. */
  function counts() {
    return db.query(
      `SELECT (SELECT count(DISTINCT (supplier_id,
                lower(btrim(regexp_replace(c.name,'\\s+',' ','g')))))
               FROM supplier_category_links l JOIN supplier_categories c ON c.id = l.category_id) scl,
              (SELECT count(*) FROM customer_rfq_items) crfq,
              (SELECT count(*) FROM employee_categories) emp,
              (SELECT count(*) FROM customer_rfq_item_assignments) asg,
              (SELECT count(*) FROM item_category_keywords) kw,
              (SELECT count(*) FROM item_classification_identity) mem`,
    );
  }

  /** Exactly what `init-db.ts` runs: load the rows, plan, then apply. */
  async function runDedupe() {
    for (const [table, refs, parent] of [
      ["supplier_categories", CATEGORY_REFERENCES.supplier, true],
      ["item_categories", CATEGORY_REFERENCES.item, true],
    ] as const) {
      const { rows } = await db.query(
        `SELECT id, name, is_active, (${refCountExpr(table, [...refs])}) AS ref_count FROM ${table} cat`,
      );
      const plan = planCategoryDedupe(
        (rows as any[]).map((r) => ({
          id: Number(r.id),
          name: String(r.name),
          isActive: r.is_active,
          refCount: Number(r.ref_count ?? 0),
        })),
      );
      for (const stmt of categoryDedupeSql(table, [...refs], plan, { parentColumn: parent })) {
        await db.query(stmt);
      }
    }
  }

  async function addPreventionIndexes() {
    await db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS supplier_categories_name_uq ON supplier_categories (${CATEGORY_UNIQUE_EXPR}) WHERE deleted_at IS NULL;`,
    );
    await db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS item_categories_name_uq ON item_categories (${CATEGORY_UNIQUE_EXPR}) WHERE deleted_at IS NULL;`,
    );
  }

  it("resolves every duplicate WITHOUT losing a reference", async () => {
    // NOTHING was lost: every reference count is unchanged by the repair.
    expect((await counts()).rows[0]).toEqual(seeded);

    // No duplicate group survives.
    const dup = await db.query(
      `SELECT count(*)::int n FROM (
         SELECT lower(btrim(regexp_replace(name,'\\s+',' ','g'))) k FROM item_categories
         WHERE deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1) x`,
    );
    expect(dup.rows[0].n).toBe(0);

    // The REFERENCED rows survive, active, with a NORMALISED name.
    const surv = await db.query(
      `SELECT id, name, is_active, deleted_at IS NOT NULL AS retired
       FROM item_categories WHERE id IN (27,5218,41,5224,34,5219) ORDER BY id`,
    );
    const byId = new Map<number, any>(surv.rows.map((r: any) => [r.id as number, r]));
    for (const id of [27, 41, 34]) {
      expect(byId.get(id).retired).toBe(false);
      expect(byId.get(id).is_active).toBe(true);
      expect(byId.get(id).name).not.toMatch(/  /);
    }
    // The empty spaced copies are RETIRED (soft), never hard-deleted.
    for (const id of [5218, 5224, 5219]) {
      expect(byId.get(id).retired).toBe(true);
      expect(byId.get(id).is_active).toBe(false);
    }

    // The supplier side: every link still resolves to a LIVE category, and each
    // supplier keeps exactly one link per TRADE. The measured shape has suppliers
    // 1-3 linked to BOTH spellings of «3m schotch» — that is the double-link the
    // dedupe is meant to fold, so the trade must have ONE row per supplier, not
    // two. Counting ids instead of trades would call that correct fold a loss.
    const live = await db.query(
      `SELECT count(*)::int n FROM supplier_category_links l
       JOIN supplier_categories c ON c.id = l.category_id
       WHERE c.deleted_at IS NULL`,
    );
    expect(live.rows[0].n).toBe(22);

    const perTrade = await db.query(
      `SELECT lower(btrim(regexp_replace(c.name,'\\s+',' ','g'))) trade,
              count(DISTINCT l.supplier_id)::int suppliers
       FROM supplier_category_links l JOIN supplier_categories c ON c.id = l.category_id
       WHERE c.deleted_at IS NULL GROUP BY 1 ORDER BY 1`,
    );
    const byTrade = new Map(perTrade.rows.map((r: any) => [r.trade, r.suppliers]));
    // «3m schotch» is linked by suppliers 1,2,3 (via 17) AND 1,2,3,4 (via 2338)
    // → ONE trade, FOUR suppliers. Nothing was lost by the fold.
    expect(byTrade.get("3m schotch")).toBe(4);
    expect(byTrade.get("معدات فندقيه")).toBe(14);
    expect(byTrade.get("لواصق شحوم وسيلكون و crc")).toBe(4);
  });

  it("is idempotent — a second run changes nothing", async () => {
    const before = await db.query(
      `SELECT (SELECT count(*) FROM supplier_category_links) scl,
              (SELECT count(*) FROM customer_rfq_items) crfq,
              (SELECT count(*) FROM item_categories WHERE deleted_at IS NULL) live`,
    );
    await runDedupe();
    const after = await db.query(
      `SELECT (SELECT count(*) FROM supplier_category_links) scl,
              (SELECT count(*) FROM customer_rfq_items) crfq,
              (SELECT count(*) FROM item_categories WHERE deleted_at IS NULL) live`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("PREVENTS a spaced variant from being inserted again", async () => {
    // This is what makes the repair permanent: without the functional index the
    // next write re-creates the duplicate and the repair runs forever.
    let refused = false;
    try {
      await db.exec(`INSERT INTO item_categories (name) VALUES ('معدات   فندقيه')`);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);

    // A genuinely different name is still accepted.
    await db.exec(`INSERT INTO item_categories (name) VALUES ('تصنيف جديد تماما')`);
    const n = await db.query(
      `SELECT count(*)::int n FROM item_categories WHERE name = 'تصنيف جديد تماما'`,
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("lets a RETIRED row be restored when nothing else owns its name", async () => {
    // The operator's «استعادة» must work for a normally deleted category. The
    // index is partial (`deleted_at IS NULL`) precisely so a retired row does not
    // block itself from coming back.
    await db.exec(`INSERT INTO item_categories (name, is_active, deleted_at)
      VALUES ('تصنيف محذوف', false, NOW())`);
    const [row] = (await db.query(`SELECT id FROM item_categories WHERE name = 'تصنيف محذوف'`))
      .rows as any[];
    await db.exec(
      `UPDATE item_categories SET is_active = true, deleted_at = NULL WHERE id = ${row.id}`,
    );
    const r = await db.query(
      `SELECT is_active, deleted_at FROM item_categories WHERE id = ${row.id}`,
    );
    expect(r.rows[0].is_active).toBe(true);
    expect(r.rows[0].deleted_at).toBeNull();
  });

  it("REFUSES to restore a retired duplicate whose twin is still active", async () => {
    // This is why the restore ROUTE needs a guard: the index rejects the write,
    // and without a check the operator sees an opaque 500 instead of the reason.
    // The correct answer is «دمج», which is the confirmed flow.
    let error: string | null = null;
    try {
      await db.exec(
        `UPDATE item_categories SET is_active = true, deleted_at = NULL WHERE id = 5218`,
      );
    } catch (e: any) {
      error = String(e?.message ?? e);
    }
    expect(error).toContain("item_categories_name_uq");
    // Still retired — the failed restore changed nothing.
    const r = await db.query(`SELECT is_active, deleted_at FROM item_categories WHERE id = 5218`);
    expect(r.rows[0].deleted_at).not.toBeNull();
  });
});

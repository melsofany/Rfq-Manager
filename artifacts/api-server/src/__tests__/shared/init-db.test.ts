import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// init-db.ts holds every migration as a raw SQL template literal. A SQL comment
// must use "--"; a stray JS-style "//" comment inside one of those literals makes
// the WHOLE multi-statement query a syntax error, and because the statements in
// one client.query share an implicit transaction, every sibling migration is
// rolled back silently (init failures are caught and only warned about at boot).
// That is exactly how customer_po_items.customer_po_id stayed NOT NULL and broke
// the soft-cancel after the customer-PO item fix.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../../shared/init-db.ts"), "utf8");

// Backtick-delimited template literals (the SQL bodies). No nested backticks are
// used in this file, so a simple scan is sufficient.
function sqlLiterals(src: string): string[] {
  const out: string[] = [];
  const re = /`([\s\S]*?)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe("init-db migrations", () => {
  it("never uses a JS-style // comment inside a SQL literal", () => {
    const offenders: string[] = [];
    for (const body of sqlLiterals(source)) {
      body.split("\n").forEach((line, i) => {
        if (/^\s*\/\//.test(line)) offenders.push(`line ${i}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every ALTER TABLE ... DROP NOT NULL working (no JS comment markers)", () => {
    // Guard the specific class of bug: the DROP NOT NULL must live in a SQL
    // literal that parses cleanly.
    expect(source).toContain("ALTER COLUMN customer_po_id DROP NOT NULL");
    const literal = sqlLiterals(source).find((b) =>
      b.includes("ALTER COLUMN customer_po_id DROP NOT NULL"),
    );
    expect(literal).toBeDefined();
    expect(literal!).not.toMatch(/^\s*\/\//m);
  });

  it("keeps the customer_po_id DROP NOT NULL in its own statement (not a shared block)", () => {
    // A failure in any sibling statement rolls back the whole implicit
    // transaction, so this migration must not share a query with unrelated DDL.
    const literal = sqlLiterals(source).find((b) =>
      b.includes("ALTER COLUMN customer_po_id DROP NOT NULL"),
    );
    expect(literal).toBeDefined();
    const statements = literal!
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(1);
  });

  it("keeps the ai_assistant_settings seed model in step with the code default", () => {
    // `loadSettings()` prefers the DB row, so a DDL default that drifts from
    // `DEFAULT_MODEL` pins production to a model the code never chose. That is how
    // the deployed assistant ended up on `gemini-3.8-flash` after the code moved
    // to `gemini-3.6-flash`, spending its per-model budget on 503s — and, after
    // the provider switch, how it would have stayed on Gemini while the code
    // defaulted to DeepSeek.
    const agentConfig = readFileSync(resolve(here, "../../modules/ai-assistant/config.ts"), "utf8");
    const match = agentConfig.match(
      /DEFAULT_MODEL\s*=\s*process\.env\.AI_MODEL\s*\|\|\s*"([^"]+)"/,
    );
    expect(match, "DEFAULT_MODEL must be a literal model id").not.toBeNull();
    const defaultModel = match![1];

    const ddlDefault = source.match(/model TEXT NOT NULL DEFAULT '([^']+)'/);
    expect(ddlDefault, "the settings DDL must declare a model default").not.toBeNull();
    expect(ddlDefault![1]).toBe(defaultModel);

    // …and the seed migration must pin to that same value, so an existing row
    // carrying the retired Gemini id is moved off it on the next boot (the
    // deployed row held `gemini-3.6-flash`, which `loadSettings()` would have
    // preferred over the new DeepSeek default forever).
    // …and every Gemini-family id must be migrated off, because the deployed row
    // held `gemini-3.5-flash-lite` — a LIVE id — which a retired-id list would
    // have left in place, making the DeepSeek switch inert in production. The
    // predicate is therefore the FAMILY (`ILIKE 'gemini%'`), not a list: a list
    // can only ever enumerate the ids someone thought of.
    expect(source).toContain(`SET model = '${defaultModel}'`);
    expect(source).toMatch(/model ILIKE 'gemini%'/);
    // And a family predicate must not be a bare equality check, which the live id
    // would not satisfy.
    expect(source).not.toMatch(/model IN \(\s*'gemini-3\.6-flash'/);
  });

  it("repairs existing duplicate primaries BEFORE creating the one-primary index", () => {
    // The partial unique index cannot be created while a category has two
    // primary owners, so the repair UPDATE must run first — in its own
    // statement (a shared literal could be rolled back by a sibling failure).
    const repairIdx = source.indexOf("UPDATE employee_categories ec");
    const indexIdx = source.indexOf("employee_categories_one_primary_uq");
    expect(repairIdx).toBeGreaterThan(-1);
    expect(indexIdx).toBeGreaterThan(-1);
    expect(repairIdx).toBeLessThan(indexIdx);

    const repair = sqlLiterals(source).find((b) => b.includes("UPDATE employee_categories ec"));
    expect(repair).toBeDefined();
    expect(
      repair!
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean),
    ).toHaveLength(1);

    const indexLiteral = sqlLiterals(source).find((b) =>
      b.includes("CREATE UNIQUE INDEX IF NOT EXISTS employee_categories_one_primary_uq"),
    );
    expect(indexLiteral).toBeDefined();
    expect(indexLiteral!).toContain("WHERE is_primary");
  });

  it("creates the customer-item assignment tables + the one-OPEN-period index", () => {
    // Responsibility lives on the CUSTOMER item now, and the database — not the
    // API — is what guarantees one OPEN period per customer item (a partial
    // index: a closed period may coexist with a new one).
    expect(source).toContain("CREATE TABLE IF NOT EXISTS customer_rfq_item_assignments");
    expect(source).toContain("CREATE TABLE IF NOT EXISTS item_assignment_audit");
    expect(source).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS customer_rfq_item_assignments_open_uq",
    );
    expect(source).toMatch(/customer_rfq_item_assignments_open_uq[\s\S]*?WHERE valid_to IS NULL/);
    // The absolute (one row per item forever) index must be gone/replaced.
    expect(source).toContain("DROP INDEX IF EXISTS customer_rfq_item_assignments_item_uq");
  });

  it("uses RESTRICT on every FK that protects responsibility history", () => {
    // Deleting an employee or an item must never silently erase the assignment
    // history — an employee is DISABLED, an item is soft-cancelled.
    expect(source).toContain(
      "customer_rfq_item_id INTEGER NOT NULL REFERENCES customer_rfq_items(id) ON DELETE RESTRICT",
    );
    expect(source).toContain("employee_id INTEGER REFERENCES employees(id) ON DELETE RESTRICT");
    expect(source).toContain("ON DELETE RESTRICT");
    expect(source).toContain(
      "FOREIGN KEY (customer_rfq_item_id) REFERENCES customer_rfq_items(id) ON DELETE RESTRICT",
    );
  });

  it("compares constraint DEFINITIONS (not just names) before deciding to replace", () => {
    // A constraint that exists with the wrong definition is the partial-resume
    // trap; the migration must read pg_get_constraintdef / confdeltype.
    expect(source).toContain("pg_get_constraintdef");
    expect(source).toContain("confdeltype");
    expect(source).toContain("pg_available_extensions");
  });

  it("adds the delivery idempotency indexes with the mandatory UNIQUE shape", () => {
    expect(source).toContain("customer_po_item_deliveries_operation_uq");
    expect(source).toContain("(operation_key, customer_po_item_id)");
    expect(source).toContain("customer_po_item_deliveries_idem_uq");
    expect(source).toContain("customer_po_item_deliveries_wa_uq");
  });

  it("adds the customer-item attribution columns and the delivery void columns", () => {
    for (const col of [
      "attribution_first_po_at",
      "attribution_employee_id",
      "attribution_employee_name",
      "attribution_event",
      "is_cancelled",
    ]) {
      expect(source).toContain(col);
    }
    for (const col of ["voided", "voided_at", "voided_by_name", "void_reason"]) {
      expect(source).toContain(col);
    }
  });

  it("migrates the legacy rfq_item_assignments deterministically and idempotently", () => {
    // The migration must (a) collapse N supplier lines of one customer item to a
    // single row (DISTINCT ON), (b) prefer a manual responsibility over an auto
    // one, (c) only migrate rows that actually carry a customer origin, and
    // (d) be re-runnable (ON CONFLICT DO NOTHING).
    const literal = sqlLiterals(source).find((b) =>
      b.includes("INSERT INTO customer_rfq_item_assignments"),
    );
    expect(literal, "the migration INSERT must exist").toBeDefined();
    expect(literal!).toContain("SELECT DISTINCT ON (ri.customer_rfq_item_id)");
    expect(literal!).toContain("WHERE ri.customer_rfq_item_id IS NOT NULL");
    expect(literal!).toMatch(/CASE a\.source WHEN 'manual' THEN 0 ELSE 1 END/);
    // The absolute unique index this once targeted was replaced by the PARTIAL
    // open-period index, so a bare `ON CONFLICT (customer_rfq_item_id)` no longer
    // resolves ("no unique or exclusion constraint matching the ON CONFLICT
    // specification"). The predicate MUST match the partial index.
    expect(literal!).toContain(
      "ON CONFLICT (customer_rfq_item_id) WHERE valid_to IS NULL DO NOTHING",
    );
    // …and it is a single statement so no sibling can roll it back.
    expect(
      literal!
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean),
    ).toHaveLength(1);
  });

  it("creates the responsibility tables BEFORE any data-dependent migration", () => {
    // initDb() aborts at the FIRST failing statement, so a data-dependent
    // migration that fails on real data (the phone canonicalization crashed on a
    // duplicate `representatives_phone_key`) silently skipped every later
    // CREATE. That is how `item_categories` ended up missing in production while
    // the server kept serving. The responsibility tables must therefore be
    // created EARLY — before the phone canonicalization and the backfills.
    const itemCategories = source.indexOf("CREATE TABLE IF NOT EXISTS item_categories");
    const assignments = source.indexOf("CREATE TABLE IF NOT EXISTS customer_rfq_item_assignments");
    const phoneMigration = source.indexOf("UPDATE representatives");
    expect(itemCategories).toBeGreaterThan(-1);
    expect(assignments).toBeGreaterThan(-1);
    expect(phoneMigration).toBeGreaterThan(-1);
    expect(itemCategories).toBeLessThan(phoneMigration);
    expect(assignments).toBeLessThan(phoneMigration);
    // …and still after the tables they reference.
    expect(itemCategories).toBeGreaterThan(source.indexOf("CREATE TABLE IF NOT EXISTS employees"));
  });

  it("canonicalizes representative phones without crashing on a duplicate", () => {
    // `representatives.phone` is UNIQUE. The old naive UPDATE aborted with
    // `duplicate key value violates unique constraint "representatives_phone_key"`
    // whenever two rows canonicalized to the same value, which stopped the whole
    // boot sequence. The migration must only rewrite rows whose canonical value
    // is unique across the table, leaving genuine collisions untouched.
    const literal = sqlLiterals(source).find(
      (b) => b.includes("UPDATE representatives") && b.includes("regexp_replace"),
    );
    expect(literal, "the phone canonicalization must exist").toBeDefined();
    expect(literal!).toContain("HAVING count(*) = 1");
    // The naive form — a bare UPDATE ... SET phone = regexp_replace(...) — must be
    // gone; it is what crashed production.
    expect(literal!).not.toMatch(
      /UPDATE representatives\s+SET phone = regexp_replace\(phone, '\[0-9\]'/,
    );
  });

  it("the ELEC→كهرباء merge rewrites EVERY category-linked table (no lost links)", () => {
    // A duplicate «ELEC» category must never survive as a live relation. Every
    // table that carries a category_id has to be repointed to the canonical
    // «كهرباء» row, or an item/assignment/ownership keeps a category that the
    // alias table now maps elsewhere — i.e. a lost link.
    const required = [
      "UPDATE customer_rfq_items SET category_id",
      "UPDATE rfq_items SET category_id",
      "UPDATE purchase_order_items SET category_id",
      "UPDATE customer_rfq_item_assignments SET category_id",
      "UPDATE rfq_item_assignments SET category_id",
      "INSERT INTO customer_rfq_item_categories",
      "INSERT INTO employee_categories",
      "INSERT INTO item_category_keywords",
      "INSERT INTO item_category_aliases",
    ];
    for (const stmt of required) {
      expect(source, `merge must cover: ${stmt}`).toContain(stmt);
    }
    // The junction/ownership/keyword merges must add-then-drop (never a bare
    // delete) so a relation is never lost between the two steps.
    expect(source).toContain("DELETE FROM customer_rfq_item_categories");
    expect(source).toContain("DELETE FROM employee_categories");
    expect(source).toContain("DELETE FROM item_category_keywords");
  });

  it("the ELEC→كهرباء merge never NULLs a category (COALESCE fallback)", () => {
    // `(SELECT id ... WHERE name='كهرباء')` is NULL when the canonical row is
    // missing (e.g. an operator renamed it). A bare assignment would then WIPE
    // every ELEC item's category. The merge must fall back to the existing value.
    const updates = [
      "customer_rfq_items",
      "rfq_items",
      "purchase_order_items",
      "customer_rfq_item_assignments",
      "rfq_item_assignments",
    ];
    for (const tbl of updates) {
      const literal = sqlLiterals(source).find(
        (b) => b.includes(`UPDATE ${tbl} SET category_id`) && b.includes("كهرباء"),
      );
      expect(literal, `${tbl} merge statement must exist`).toBeDefined();
      expect(literal!, `${tbl} merge must COALESCE`).toContain(
        "COALESCE((SELECT id FROM item_categories WHERE name = 'كهرباء'), category_id)",
      );
    }
  });

  it("rewrites `suppliers.category` free text for the merged spellings", () => {
    // `suppliers.category` is NOT a FK — it stores category NAMES as free text.
    // The relation moves above never touch it, so without this the supplier list
    // (which filters on the NAME) shows no supplier under «كهرباء» while every
    // supplier still carries the old «elec». The rewrite must be a raw UPDATE on
    // `suppliers`, match case-insensitively/trimmed, and preserve other
    // categories in a comma-joined value.
    const literal = sqlLiterals(source).find(
      (b) => b.includes("UPDATE suppliers") && b.includes("string_to_array"),
    );
    expect(literal, "suppliers.category rewrite must exist").toBeDefined();
    expect(literal!).toContain("string_to_array(category, ',')");
    expect(literal!).toContain("lower(trim(elem))");
    expect(literal!).toContain("'كهرباء'");
  });

  it("consolidates the alias spelling in `supplier_categories` too", () => {
    // The supplier-category list is a SEPARATE name list: an «elec» row there
    // re-mirrors an «elec» item category on every boot and shows a duplicate
    // option in the supplier dialog. It must be folded into «كهرباء» as well.
    const deleteLiteral = sqlLiterals(source).find(
      (b) => b.includes("DELETE FROM supplier_categories") && b.includes("'كهرباء'"),
    );
    expect(deleteLiteral, "supplier_categories alias rows must be folded").toBeDefined();
    const updateLiteral = sqlLiterals(source).find(
      (b) => b.includes("UPDATE supplier_categories") && b.includes("'كهرباء'"),
    );
    expect(updateLiteral, "supplier_categories alias must be renamed").toBeDefined();
  });

  it("creates the supplier↔category LINK table and backfills it from the text", () => {
    // The link table is the source of truth. Its DDL must exist, and the
    // migration must seed it from the legacy free-text column in TWO steps:
    // reconcile missing categories, then insert the links.
    expect(source).toContain("CREATE TABLE IF NOT EXISTS supplier_category_links");
    const reconcile = sqlLiterals(source).find(
      (b) => b.includes("INSERT INTO supplier_categories") && b.includes("unnest(string_to_array"),
    );
    expect(reconcile, "missing categories must be reconciled").toBeDefined();
    const link = sqlLiterals(source).find(
      (b) =>
        b.includes("INSERT INTO supplier_category_links") &&
        b.includes("JOIN supplier_categories c ON c.name = trim(elem)"),
    );
    expect(link, "links must be backfilled from the text").toBeDefined();
    // Idempotent: a re-run must not duplicate a link.
    expect(link!).toContain("ON CONFLICT (supplier_id, category_id) DO NOTHING");
  });

  it("RECONCILES the item catalogue with the supplier catalogue (both directions)", () => {
    // The operator's rule: «تبويب تصنيفات البنود يجب ألا تزيد أو تنقص عن تصنيفات
    // الموردين». The old mirror was ONE-WAY and scoped to names already carrying a
    // seed code, so «مشروبات ومواد غذائية» existed only on /suppliers and
    // «أجهزة»/«قطع غيار» only on the item side. Both directions are now mirrored.
    // The one-way scoped mirror is GONE: it can no longer be relied on.
    const scoped = sqlLiterals(source).find(
      (b) =>
        b.includes("INSERT INTO item_categories (name, sort_order)") &&
        b.includes("FROM supplier_categories") &&
        b.includes("ic.code IS NOT NULL"),
    );
    expect(scoped, "the old scoped one-way mirror must be removed").toBeUndefined();

    // Supplier → item: every supplier category becomes a functional item domain.
    const toItem = sqlLiterals(source).find(
      (b) =>
        b.includes("INSERT INTO item_categories (name, sort_order, kind)") &&
        b.includes("FROM supplier_categories sc") &&
        b.includes("'functional'"),
    );
    expect(toItem, "supplier categories must be mirrored INTO the item catalogue").toBeDefined();

    // Item → supplier: every active functional domain becomes a supplier category.
    const toSupplier = sqlLiterals(source).find(
      (b) =>
        b.includes("INSERT INTO supplier_categories (name)") &&
        b.includes("FROM item_categories ic") &&
        b.includes("'functional'"),
    );
    expect(toSupplier, "item domains must be mirrored INTO the supplier catalogue").toBeDefined();

    // A specialisation whose live row is still functional must be demoted, so it
    // is hidden from the trade lists while its items keep the category.
    const demote = sqlLiterals(source).find(
      (b) => b.includes("SET kind = 'subcategory'") && b.includes("'قواطع'"),
    );
    expect(demote, "declared specialisations must be demoted out of the trade list").toBeDefined();

    // «إضاءة» is promoted to an independent domain (decision «أ١»: 14 suppliers
    // filter by it), and its row must NOT be demoted back to a specialisation.
    const promote = sqlLiterals(source).find(
      (b) => b.includes("SET kind = 'functional', parent_id = NULL") && b.includes("'إضاءة'"),
    );
    expect(promote, "«إضاءة» must be promoted to a functional trade domain").toBeDefined();
    const demoteLighting = sqlLiterals(source).find(
      (b) =>
        b.includes("SET kind = 'subcategory'") &&
        b.includes("child.name = 'إضاءة'") &&
        b.includes("parent.name = 'كهرباء'"),
    );
    expect(demoteLighting, "«إضاءة» must not be demoted back to a subcategory").toBeUndefined();

    // The ELEC alias ROW must stop being a trade category.
    const elec = sqlLiterals(source).find(
      (b) =>
        b.includes("UPDATE item_categories") &&
        b.includes("is_active = false") &&
        b.includes("'elec','electrical','electric'"),
    );
    expect(elec, "the ELEC alias row must be deactivated").toBeDefined();
  });

  it("deletes ORPHAN item categories ONLY when provably unused", () => {
    // The cleanup the operator asked for: junk categories (mirrored in from
    // supplier-category text) with no code and no relation at all. A category
    // with even ONE item or owner must be KEPT — its links may be correct and
    // the conflict/repair flow owns mis-classification. Every relation below is
    // a separate NOT EXISTS guard.
    const literal = sqlLiterals(source).find(
      (b) => b.includes("DELETE FROM item_categories ic") && b.includes("ic.code IS NULL"),
    );
    expect(literal, "the orphan cleanup must exist").toBeDefined();
    // Only a name that also exists as a supplier category is a mirror orphan.
    expect(literal!).toContain("FROM supplier_categories sc WHERE sc.name = ic.name");
    const requiredGuards = [
      "FROM rfq_items x WHERE x.category_id = ic.id",
      "FROM customer_rfq_items x WHERE x.category_id = ic.id",
      "FROM purchase_order_items x WHERE x.category_id = ic.id",
      "FROM customer_rfq_item_categories x WHERE x.category_id = ic.id",
      "FROM employee_categories x WHERE x.category_id = ic.id",
      "FROM customer_rfq_item_assignments x WHERE x.category_id = ic.id",
      "FROM rfq_item_assignments x WHERE x.category_id = ic.id",
      "FROM item_categories child WHERE child.parent_id = ic.id",
      "FROM item_category_aliases a WHERE a.category_id = ic.id",
      "FROM item_category_keywords k WHERE k.category_id = ic.id",
    ];
    for (const g of requiredGuards) {
      expect(literal!, `cleanup must guard: ${g}`).toContain(g);
    }
    // Single statement so no sibling failure can roll it back.
    expect(
      literal!
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean),
    ).toHaveLength(1);
  });

  it("creates the missions table in its OWN statement, before any dependent write", () => {
    // Missions excuse an absence, so the table must exist before the routes
    // read it. Its CREATE sits in its own client.query: a sibling failure in a
    // shared multi-statement block would roll it back silently.
    const source = readFileSync(new URL("../../shared/init-db.ts", import.meta.url), "utf8");
    const createIdx = source.indexOf("CREATE TABLE IF NOT EXISTS hr_missions");
    expect(createIdx).toBeGreaterThan(-1);
    expect(source).toContain(
      "CREATE INDEX IF NOT EXISTS hr_missions_emp_date_idx ON hr_missions (employee_id, mission_date)",
    );

    // The CREATE must be its own statement — no other DDL sharing the literal.
    const before = source.lastIndexOf("await client.query(", createIdx);
    const literal = source.slice(before, source.indexOf("`);", createIdx));
    expect(literal).not.toContain("CREATE TABLE IF NOT EXISTS hr_leave_requests");
    expect(literal.split(";").filter((s) => /CREATE\s+TABLE/i.test(s))).toHaveLength(1);

    // The missions table must be created before the leave-type seed that
    // follows it (ordering proof that it is not stranded after a failure).
    expect(createIdx).toBeLessThan(source.indexOf("INSERT INTO hr_leave_types"));
  });

  it("creates the attendance-exceptions table in its OWN statement", () => {
    // A per-employee exception overrides the company shift, so the table must
    // exist before /hr/attendance reads it. Own statement: a sibling failure in
    // a shared multi-statement block would roll this CREATE back silently.
    const source = readFileSync(new URL("../../shared/init-db.ts", import.meta.url), "utf8");
    const createIdx = source.indexOf("CREATE TABLE IF NOT EXISTS hr_attendance_exceptions");
    expect(createIdx).toBeGreaterThan(-1);

    const before = source.lastIndexOf("await client.query(", createIdx);
    const literal = source.slice(before, source.indexOf("`);", createIdx));
    expect(literal.split(";").filter((s) => /CREATE\s+TABLE/i.test(s))).toHaveLength(1);
    expect(literal).not.toContain("hr_missions");

    // One policy per employee: the UNIQUE constraint is what makes the
    // resolution unambiguous.
    expect(literal).toContain("employee_id INTEGER NOT NULL UNIQUE");
  });
});

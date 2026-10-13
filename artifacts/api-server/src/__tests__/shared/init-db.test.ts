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
});

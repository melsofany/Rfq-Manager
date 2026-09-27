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
});

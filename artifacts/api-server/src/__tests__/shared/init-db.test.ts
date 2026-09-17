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
});

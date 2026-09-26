/**
 * Adversarial tests for the read-only guarantee.
 *
 * The requirement from the operator is absolute: the assistant must not be able
 * to erase anything from the database or the mail. These tests try to break that
 * — every classic write/escape form is attempted and must be refused.
 *
 * They test the REAL guard (`guardReadOnly`), not a mock, and they assert the
 * reason is reported so a refusal is never silent.
 */
import { describe, expect, it } from "vitest";
import {
  guardReadOnly,
  normalizeForScan,
  stripSqlComments,
} from "../../modules/ai-assistant/query-exec";

describe("read-only SQL guard", () => {
  describe("allows genuine reads", () => {
    it("allows a plain SELECT", () => {
      expect(guardReadOnly("SELECT id, name FROM suppliers LIMIT 10").allowed).toBe(true);
    });

    it("allows a CTE that ends in SELECT", () => {
      expect(
        guardReadOnly(
          "WITH totals AS (SELECT supplier_id, SUM(qty) s FROM po_items GROUP BY 1) SELECT * FROM totals",
        ).allowed,
      ).toBe(true);
    });

    it("allows an aggregate with joins and a trailing semicolon", () => {
      expect(
        guardReadOnly(
          "SELECT c.name, COUNT(*) FROM customer_pos c JOIN customer_po_items i ON i.customer_po_id = c.id GROUP BY c.name;",
        ).allowed,
      ).toBe(true);
    });

    it("allows a keyword that only appears inside a string literal", () => {
      // A real part description reading "UPDATE KIT" must not trip the denylist —
      // otherwise the guard blocks legitimate reads, which is its own failure.
      expect(guardReadOnly("SELECT * FROM items WHERE description = 'UPDATE KIT'").allowed).toBe(
        true,
      );
      expect(guardReadOnly("SELECT * FROM suppliers WHERE name = 'Create Ltd'").allowed).toBe(true);
    });

    it("allows a column whose name merely contains a keyword", () => {
      expect(guardReadOnly("SELECT inserted_at, deleted_flag FROM audit_log").allowed).toBe(true);
    });
  });

  describe("refuses every write and escape form", () => {
    const attacks: Array<[string, string]> = [
      ["DELETE", "DELETE FROM customer_pos WHERE id = 1"],
      ["UPDATE", "UPDATE suppliers SET name = 'x'"],
      ["INSERT", "INSERT INTO suppliers (name) VALUES ('x')"],
      ["TRUNCATE", "TRUNCATE TABLE customer_pos"],
      ["DROP TABLE", "DROP TABLE suppliers"],
      ["DROP DATABASE", "DROP DATABASE cortoba"],
      ["ALTER", "ALTER TABLE suppliers DROP COLUMN name"],
      ["CREATE", "CREATE TABLE evil (id int)"],
      ["GRANT", "GRANT ALL ON suppliers TO public"],
      ["multi-statement DELETE", "SELECT 1; DELETE FROM suppliers"],
      ["multi-statement DROP", "SELECT * FROM suppliers; DROP TABLE suppliers"],
      ["CTE wrapping a write", "WITH x AS (DELETE FROM suppliers RETURNING *) SELECT * FROM x"],
      ["write hidden in a comment", "SELECT 1 -- \nDELETE FROM suppliers"],
      ["write hidden in a block comment", "SELECT 1 /* */ DELETE FROM suppliers"],
      ["case-varied DELETE", "DeLeTe FROM suppliers"],
      ["newline-split DELETE", "SELECT 1\nDEL\nETE FROM suppliers"],
      ["COPY to file", "COPY suppliers TO '/tmp/leak.csv'"],
      ["pg_read_file", "SELECT pg_read_file('/etc/passwd')"],
      ["pg_sleep DoS", "SELECT pg_sleep(600)"],
      ["SET to leave read-only", "SET TRANSACTION READ WRITE"],
      ["BEGIN", "BEGIN"],
      ["COMMIT", "COMMIT"],
      ["VACUUM", "VACUUM FULL suppliers"],
      ["ANALYZE", "ANALYZE suppliers"],
      ["dblink network escape", "SELECT * FROM dblink('host=evil', 'SELECT 1') AS t(x int)"],
      ["lo_export", "SELECT lo_export(1234, '/tmp/out')"],
      ["generate_series DoS", "SELECT * FROM generate_series(1, 100000000)"],
      ["REFRESH matview", "REFRESH MATERIALIZED VIEW mv"],
      ["DO block", "DO $$ BEGIN DELETE FROM suppliers; END $$"],
      ["empty", "   "],
    ];

    for (const [label, sql] of attacks) {
      it(`refuses ${label}`, () => {
        const verdict = guardReadOnly(sql);
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toBeTruthy();
      });
    }
  });

  describe("normalisation is not bypassable", () => {
    it("strips line comments", () => {
      expect(stripSqlComments("SELECT 1 -- DELETE")).not.toContain("DELETE");
    });

    it("strips block comments", () => {
      expect(stripSqlComments("SELECT 1 /* DROP TABLE x */")).not.toContain("DROP");
    });

    it("blanks string literals so data cannot trip the denylist", () => {
      expect(normalizeForScan("SELECT * FROM t WHERE d = 'DELETE FROM x'")).not.toContain(
        "delete from x",
      );
    });

    it("still sees a keyword outside a literal", () => {
      expect(normalizeForScan("SELECT 1 DELETE FROM t")).toContain("delete");
    });
  });
});

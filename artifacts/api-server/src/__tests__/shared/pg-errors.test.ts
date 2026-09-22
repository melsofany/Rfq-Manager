import { describe, it, expect } from "vitest";
import {
  pgError,
  isForeignKeyViolation,
  isUniqueViolation,
  constraintViolated,
} from "../../shared/pg-errors";

/**
 * Reproduces the exact error object shape produced by drizzle-orm: the message
 * carries ONLY the SQL + params, and the Postgres error (with SQLSTATE) hangs
 * off `cause`. Matching against `err.message` therefore never sees the real
 * failure text — the bug that turned expected 409s into 500s in production.
 */
function drizzleError(query: string, params: unknown[], cause: Record<string, unknown>): Error {
  const err = new Error(`Failed query: ${query}\nparams: ${params.join(",")}`) as Error & {
    query: string;
    params: unknown[];
    cause: unknown;
  };
  err.query = query;
  err.params = params;
  err.cause = cause;
  return err;
}

const fkViolation = drizzleError(
  'delete from "suppliers" where "suppliers"."id" = $1 returning "id"',
  [249],
  {
    code: "23503",
    severity: "ERROR",
    detail: 'Key (id)=(249) is still referenced from table "whatsapp_chats".',
    constraint: "whatsapp_chats_supplier_id_fkey",
    message:
      'update or delete on table "suppliers" violates foreign key constraint "whatsapp_chats_supplier_id_fkey" on table "whatsapp_chats"',
  },
);

describe("pg-errors", () => {
  it("unwraps the driver error from a Drizzle error's cause chain", () => {
    const pg = pgError(fkViolation);
    expect(pg?.code).toBe("23503");
    expect(pg?.constraint).toBe("whatsapp_chats_supplier_id_fkey");
  });

  it("detects a foreign-key violation that the wrapper message hides", () => {
    // The guard this replaces read `err.message`, which contains only SQL —
    // so it never matched and the route 500'd instead of returning 409.
    expect(fkViolation.message.includes("violates foreign key constraint")).toBe(false);
    expect(isForeignKeyViolation(fkViolation)).toBe(true);
  });

  it("detects a unique violation (e.g. duplicate invoice number)", () => {
    const dup = drizzleError('insert into "sales_invoices" ...', [], {
      code: "23505",
      constraint: "sales_invoices_invoice_no_key",
      message: 'duplicate key value violates unique constraint "sales_invoices_invoice_no_key"',
    });
    expect(isUniqueViolation(dup)).toBe(true);
    expect(isForeignKeyViolation(dup)).toBe(false);
  });

  it("returns null for ordinary errors and for unrelated SQLSTATEs", () => {
    expect(pgError(new Error("boom"))).toBeNull();
    expect(pgError(null)).toBeNull();
    expect(pgError(undefined)).toBeNull();
    expect(isForeignKeyViolation(new Error("boom"))).toBe(false);

    const syntax = drizzleError("select 1", [], {
      code: "42601",
      message: "syntax error",
    });
    expect(pgError(syntax)?.code).toBe("42601");
    expect(isForeignKeyViolation(syntax)).toBe(false);
  });

  it("walks nested causes without looping forever", () => {
    const wrapper = { cause: { cause: fkViolation } };
    expect(isForeignKeyViolation(wrapper)).toBe(true);
    const cyclic: Record<string, unknown> = {};
    cyclic.cause = cyclic;
    expect(pgError(cyclic)).toBeNull();
  });

  it("matches a constraint by name fragment", () => {
    expect(constraintViolated(fkViolation, "whatsapp_chats_supplier_id_fkey")).toBe(true);
    expect(constraintViolated(fkViolation, "supplier_id")).toBe(true);
    expect(constraintViolated(fkViolation, "offers_supplier_id_fkey")).toBe(false);
  });

  it("falls back to the cause message when the driver omits `constraint`", () => {
    const noConstraint = drizzleError("delete from x", [], {
      code: "23503",
      message: 'violates foreign key constraint "offers_supplier_id_fkey"',
    });
    expect(constraintViolated(noConstraint, "offers_supplier_id_fkey")).toBe(true);
  });
});

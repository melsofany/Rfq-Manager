/**
 * Postgres error inspection.
 *
 * Drizzle wraps driver errors in `DrizzleQueryError`, whose `message` holds
 * only the SQL text and bind params — the actual Postgres message (and its
 * SQLSTATE) live on `err.cause`. Matching against `err.message` therefore
 * never sees "violates foreign key constraint", which silently turned
 * expected 409 responses into 500s. Always unwrap via `pgError`.
 */

export interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
  column?: string;
  table?: string;
  message?: string;
}

/** Unwrap a Drizzle/driver error chain and return the underlying Postgres error. */
export function pgError(err: unknown): PgError | null {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const candidate = cur as PgError & { cause?: unknown };
    // `code` is the SQLSTATE — the reliable marker of a driver error.
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return candidate;
    }
    cur = candidate.cause;
  }
  return null;
}

/** SQLSTATE 23503 — the row is still referenced by a foreign key. */
export function isForeignKeyViolation(err: unknown): boolean {
  return pgError(err)?.code === "23503";
}

/** SQLSTATE 23505 — a unique index/constraint was violated. */
export function isUniqueViolation(err: unknown): boolean {
  return pgError(err)?.code === "23505";
}

/**
 * True when `err` violated a constraint whose name contains `fragment`.
 * Falling back to the message text keeps this working with drivers that omit
 * `constraint` (and with test doubles that only set a message).
 */
export function constraintViolated(err: unknown, fragment: string): boolean {
  const pg = pgError(err);
  if (pg?.constraint) return pg.constraint.includes(fragment);
  const msg = pg?.message ?? (err instanceof Error ? err.message : "");
  return msg.includes(fragment);
}

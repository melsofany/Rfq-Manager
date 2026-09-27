/**
 * AI Assistant — read-only query executor.
 *
 * ## The guarantee
 *
 * The assistant may READ the database. It may never write to it, and it may
 * never touch email. That guarantee is enforced HERE, in code, not in the prompt:
 * a prompt rule is not a permission boundary — a model that misreads an
 * instruction would still be free to act, and this project has already paid for
 * that lesson once (the `send_email` confirmation gate).
 *
 * ## Defence in depth
 *
 * A single check is a single bug away from being no check, so five independent
 * layers each have to fail before a write could land:
 *
 *  1. **Reject, don't sanitise.** The statement is matched against a strict
 *     allowlist. Anything that is not a plain `SELECT`/`WITH … SELECT` is
 *     refused outright. Sanitising is the wrong instinct: stripping a keyword
 *     from `DROP TABLE x` can leave something that still runs.
 *  2. **Keyword denylist over the whole text** (comments stripped first, so a
 *     keyword cannot be hidden in a comment or smuggled past a scanner).
 *  3. **No multi-statement.** A trailing `;` is removed; any other `;` is
 *     rejected, which is what stops `SELECT 1; DROP TABLE x`.
 *  4. **`SET TRANSACTION READ ONLY`** on a dedicated connection — the database
 *     itself refuses a write, whatever the parser missed. This is the layer that
 *     makes the guarantee true rather than merely likely.
 *  5. **`statement_timeout` + a row cap**, so a runaway query cannot pin a
 *     connection or flood the model's context.
 *
 * ## Why a dedicated connection
 *
 * The read-only transaction is set on a connection taken from the pool and
 * released afterwards. Running it on the shared pool connection would leak the
 * read-only mode onto other requests (and vice versa), so the transaction and
 * the `SET` are scoped to one `connect()` / `release()` pair.
 *
 * ## What this is NOT
 *
 * Not a sandbox for arbitrary code. It executes a SQL string and returns rows —
 * no shell, no filesystem, no network, no user-defined functions of the
 * assistant's choosing. The `vm`-based isolation discussed for phase 3 was
 * dropped deliberately: it added a code-execution surface without adding a
 * capability the read-only query path does not already provide, and "no new
 * attack surface" is worth more here than the flexibility.
 */
import { logger } from "../../shared/logger";

/** Statement kinds that are refused before anything else is considered. */
const FORBIDDEN_KEYWORDS = [
  // Writes
  "insert",
  "update",
  "delete",
  "truncate",
  "drop",
  "alter",
  "create",
  "replace",
  "merge",
  "upsert",
  "grant",
  "revoke",
  "comment",
  "rename",
  // Execution / server-side effects
  "execute",
  "call",
  "do",
  "copy",
  "vacuum",
  "analyze",
  "reindex",
  "cluster",
  "refresh",
  "notify",
  "listen",
  "unlisten",
  // Transaction / session control that could end the read-only mode
  "commit",
  "rollback",
  "begin",
  "start",
  "savepoint",
  "release",
  "set",
  "reset",
  "discard",
  "prepare",
  "deallocate",
  "lock",
  // Escalation / filesystem / network
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_write_file",
  "lo_import",
  "lo_export",
  "dblink",
  "postgres_fdw",
  "file_fdw",
  "pg_sleep",
  "current_setting",
  "pg_settings",
  "pg_shadow",
  "pg_authid",
  // Denial of service
  "generate_series",
];

/**
 * A leading keyword that is allowed to START a statement. `WITH` is included
 * because a CTE is the normal way to express a multi-step read, and the denylist
 * still applies to everything inside it.
 */
const ALLOWED_STARTS = ["select", "with", "table"];

/** Rows returned to the model at most — beyond this the answer is not a reading. */
export const MAX_QUERY_ROWS = 500;

/** Wall-clock ceiling for one query. Matches the pool's own 20s statement cap. */
export const QUERY_TIMEOUT_MS = 15_000;

export interface ReadOnlyQueryResult {
  ok: boolean;
  rows?: Array<Record<string, unknown>>;
  rowCount?: number;
  truncated?: boolean;
  error?: string;
}

/**
 * Remove SQL comments so a keyword cannot be hidden inside one.
 *
 * `--` to end of line and block comments both go. Done BEFORE the denylist scan,
 * because `SELECT 1 -- \n DELETE FROM x` is still a delete on some parsers and
 * the scan must not be fooled by the comment.
 */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n\r]*/g, " ");
}

/**
 * Normalise for keyword matching: comments gone, whitespace collapsed, lowercase.
 *
 * String literals are blanked first so that data containing a keyword (a part
 * description reading "UPDATE KIT", or a supplier named "Create Ltd") does not
 * trip the denylist. Getting this wrong is the difference between a guard that
 * protects and one that blocks legitimate reads.
 */
export function normalizeForScan(sql: string): string {
  const withoutComments = stripSqlComments(sql);
  const withoutStrings = withoutComments
    .replace(/'(?:[^']|'')*'/g, " '' ")
    .replace(/"(?:[^"]|"")*"/g, ' "" ')
    .replace(/\$\$[\s\S]*?\$\$/g, " $$ ");
  return withoutStrings.replace(/\s+/g, " ").trim().toLowerCase();
}

export interface GuardVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether a statement may run. Pure and synchronous, so the whole policy
 * is unit-testable without a database — which is the only way an adversarial
 * test suite can be exhaustive.
 */
export function guardReadOnly(sql: string): GuardVerdict {
  const raw = (sql ?? "").trim();
  if (!raw) return { allowed: false, reason: "الاستعلام فارغ" };

  // Layer 3: multi-statement. One trailing `;` is tolerated (people type it);
  // any other occurrence is a second statement and is refused.
  //
  // Counted on the LITERAL-BLANKED form: a semicolon inside a string is data,
  // not a statement boundary, so rejecting it would block legitimate reads
  // (`WHERE note = 'a;b'`) for no security gain.
  const withoutTrailing = raw.replace(/;\s*$/, "");
  if (normalizeForScan(withoutTrailing).includes(";")) {
    return { allowed: false, reason: "لا يُسمح بأكثر من استعلام واحد في الطلب" };
  }

  const scanned = normalizeForScan(raw);

  // Layer 1: the statement must be a read.
  const firstWord = scanned.split(" ")[0] ?? "";
  if (!ALLOWED_STARTS.includes(firstWord)) {
    return {
      allowed: false,
      reason: `يُسمح باستعلامات القراءة فقط (SELECT/WITH)، وليس «${firstWord.toUpperCase()}»`,
    };
  }

  // Layer 2: no forbidden keyword anywhere in the statement.
  //
  // The pattern tolerates whitespace BETWEEN a keyword's characters, which is what
  // closes the mid-keyword split: `DEL\nETE` collapses to `del ete` and must still
  // match. Stripping whitespace instead would NOT work — it fuses the keyword into
  // its neighbours (`select1deletefrom`), destroying the very word boundary the
  // match depends on, so the attack would slip through.
  //
  // Word boundaries are kept so an identifier like `inserted_at` is never mistaken
  // for the verb `insert`.
  for (const kw of FORBIDDEN_KEYWORDS) {
    const spaced = kw.split("").join("\\s*");
    const re = new RegExp(`(^|[^a-z0-9_])${spaced}([^a-z0-9_]|$)`);
    if (re.test(scanned)) {
      return {
        allowed: false,
        reason: `الكلمة «${kw.toUpperCase()}» غير مسموح بها — القراءة فقط`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Run a read-only query under all five layers.
 *
 * `getPool` is imported lazily so this module stays importable (and testable)
 * without a DATABASE_URL — the same pattern the rest of the assistant uses.
 */
export async function runReadOnlyQuery(sql: string): Promise<ReadOnlyQueryResult> {
  const verdict = guardReadOnly(sql);
  if (!verdict.allowed) {
    logger.warn({ reason: verdict.reason }, "AI assistant: refused a non-read-only query");
    return { ok: false, error: verdict.reason };
  }

  const { getPool } = await import("@workspace/db");
  const pool = getPool();
  const client = await pool.connect();
  try {
    // Layer 4: the database enforces read-only for this transaction, so a write
    // that slipped past the parser is still refused by Postgres.
    await client.query("BEGIN TRANSACTION READ ONLY");
    // Layer 5: bounded time and bounded rows.
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    const result = await client.query(sql.replace(/;\s*$/, ""));

    const rows = result.rows ?? [];
    const truncated = rows.length > MAX_QUERY_ROWS;
    return {
      ok: true,
      rows: truncated ? rows.slice(0, MAX_QUERY_ROWS) : rows,
      rowCount: rows.length,
      truncated,
    };
  } catch (err) {
    // A refused write surfaces here as a Postgres error. Report it plainly
    // rather than retrying: the whole point is that it must not succeed.
    logger.warn({ err: String(err).slice(0, 300) }, "AI assistant: read-only query failed");
    return { ok: false, error: String(err).slice(0, 300) };
  } finally {
    // ALWAYS end the transaction before returning the client to the pool. A
    // failed statement aborts the transaction, and a connection handed back in
    // that state answers every later query with "current transaction is aborted,
    // commands ignored until end of transaction block" — so one bad column name
    // would poison that pooled connection for every subsequent request,
    // including the assistant's own history insert. Guarded because ROLLBACK
    // itself can fail (a dead connection); the release must still happen.
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logger.warn(
        { err: String(rollbackErr).slice(0, 200) },
        "AI assistant: read-only query rollback failed",
      );
    }
    client.release();
  }
}

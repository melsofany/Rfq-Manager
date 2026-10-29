/**
 * Odoo JSON-RPC client — عميل Odoo عبر JSON-RPC
 *
 * A minimal, dependency-free client for Odoo's JSON-RPC 2.0 endpoint:
 *
 *   POST {ODOO_URL}/jsonrpc   service=common  method=authenticate   → uid
 *   POST {ODOO_URL}/jsonrpc   service=object  method=execute_kw     → result
 *
 * Credentials come ONLY from the environment (`ODOO_URL`, `ODOO_DB`,
 * `ODOO_USER`, `ODOO_API_KEY`) — never from a literal in the source. The
 * service user is a dedicated Odoo user; `ODOO_API_KEY` is its API key.
 *
 * The session uid is cached in-process (opening a session is a round-trip) and
 * re-authenticated once when a call reports an expired session.
 */

export interface OdooConfig {
  url: string;
  db: string;
  user: string;
  apiKey: string;
}

export class OdooError extends Error {
  readonly name = "OdooError";
  readonly odooName?: string;
  readonly data?: unknown;
  constructor(message: string, odooName?: string, data?: unknown) {
    super(message);
    this.odooName = odooName;
    this.data = data;
  }
}

/**
 * Read the Odoo connection settings from the environment. Returns null when the
 * bridge is not configured, so callers can degrade gracefully instead of
 * crashing the API server at import time.
 */
export function odooConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OdooConfig | null {
  const url = env.ODOO_URL?.trim();
  const db = env.ODOO_DB?.trim();
  const user = env.ODOO_USER?.trim();
  const apiKey = env.ODOO_API_KEY?.trim();
  if (!url || !db || !user || !apiKey) return null;
  return { url: url.replace(/\/+$/, ""), db, user, apiKey };
}

export function isOdooConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return odooConfigFromEnv(env) !== null;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: { name?: string; message?: string; debug?: string };
  };
}

/** Low-level JSON-RPC call. `fetchImpl` is injectable so tests need no network. */
export async function jsonRpc(
  cfg: Pick<OdooConfig, "url">,
  params: { service: string; method: string; args: unknown[] },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${cfg.url}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params, id: Date.now() }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new OdooError(`Odoo HTTP ${res.status} ${res.statusText} at ${cfg.url}/jsonrpc`);
    }
    const body = (await res.json()) as JsonRpcResponse;
    if (body.error) {
      const name = body.error.data?.name;
      const message = body.error.data?.message ?? body.error.message ?? "unknown Odoo error";
      throw new OdooError(`Odoo: ${message}`, name, body.error.data);
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Session ────────────────────────────────────────────────────────────────

let cachedUid: number | null = null;
let cachedFor: string | null = null;

function sessionKey(cfg: OdooConfig): string {
  return `${cfg.url}|${cfg.db}|${cfg.user}`;
}

/** Authenticate and return the Odoo uid. Cached per (url, db, user). */
export async function authenticate(
  cfg: OdooConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const key = sessionKey(cfg);
  if (cachedUid != null && cachedFor === key) return cachedUid;
  const uid = await jsonRpc(
    cfg,
    { service: "common", method: "authenticate", args: [cfg.db, cfg.user, cfg.apiKey, {}] },
    fetchImpl,
  );
  if (typeof uid !== "number" || uid === 0) {
    throw new OdooError(
      "Odoo authentication failed — تحقق من ODOO_URL/ODOO_DB/ODOO_USER/ODOO_API_KEY",
    );
  }
  cachedUid = uid;
  cachedFor = key;
  return uid;
}

/** Drop the cached session (used after an "expired session" fault). */
export function resetSession(): void {
  cachedUid = null;
  cachedFor = null;
}

export interface OdooClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Call a model method through `object.execute_kw`. `kwargs` carries `fields`,
 * `limit`, `context`, … exactly as Odoo expects.
 */
export async function executeKw<T = unknown>(
  cfg: OdooConfig,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
  opts: OdooClientOptions = {},
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let uid = await authenticate(cfg, fetchImpl);
  const call = () =>
    jsonRpc(
      cfg,
      {
        service: "object",
        method: "execute_kw",
        args: [cfg.db, uid, cfg.apiKey, model, method, args, kwargs],
      },
      fetchImpl,
      opts.timeoutMs,
    );
  try {
    return (await call()) as T;
  } catch (err) {
    // An expired/invalid session is the one fault worth retrying: re-auth once
    // and replay. Any other fault is the caller's problem.
    const name = err instanceof OdooError ? err.odooName : undefined;
    if (
      name === "odoo.exceptions.AccessDenied" ||
      /session/i.test(String((err as Error).message))
    ) {
      resetSession();
      uid = await authenticate(cfg, fetchImpl);
      return (await call()) as T;
    }
    throw err;
  }
}

/** `search_read` convenience — returns the matching records with `fields`. */
export async function searchRead<T = Record<string, unknown>>(
  cfg: OdooConfig,
  model: string,
  domain: unknown[],
  fields: string[],
  opts: OdooClientOptions & { limit?: number; order?: string } = {},
): Promise<T[]> {
  return executeKw<T[]>(
    cfg,
    model,
    "search_read",
    [domain],
    { fields, limit: opts.limit ?? 0, order: opts.order },
    opts,
  );
}

/** `search_count` — the number of records matching `domain`. */
export async function searchCount(
  cfg: OdooConfig,
  model: string,
  domain: unknown[],
  opts: OdooClientOptions = {},
): Promise<number> {
  return executeKw<number>(cfg, model, "search_count", [domain], {}, opts);
}

/** `create` — returns the new record id. */
export async function createRecord(
  cfg: OdooConfig,
  model: string,
  values: Record<string, unknown>,
  opts: OdooClientOptions = {},
): Promise<number> {
  return executeKw<number>(cfg, model, "create", [values], {}, opts);
}

/** `read` — returns the requested fields for the given ids. */
export async function readRecords<T = Record<string, unknown>>(
  cfg: OdooConfig,
  model: string,
  ids: number[],
  fields: string[],
  opts: OdooClientOptions = {},
): Promise<T[]> {
  return executeKw<T[]>(cfg, model, "read", [ids], { fields }, opts);
}

/**
 * `read_group` — server-side aggregation. `groupby` is a list of field names
 * (or `"field:groupby"` specs); `fields` are the aggregate specs, e.g.
 * `["debit:sum", "credit:sum", "balance:sum"]`. Rows carry the grouped fields
 * plus each aggregate under its own name.
 */
export async function readGroup<T = Record<string, unknown>>(
  cfg: OdooConfig,
  model: string,
  domain: unknown[],
  fields: string[],
  groupby: string[] = [],
  opts: OdooClientOptions & { lazy?: boolean; orderby?: string; limit?: number } = {},
): Promise<T[]> {
  return executeKw<T[]>(
    cfg,
    model,
    "read_group",
    [domain, fields, groupby],
    { lazy: opts.lazy ?? false, orderby: opts.orderby, limit: opts.limit },
    opts,
  );
}

/**
 * Find the single Odoo id matching `domain`, or null. Used to map an RFQ
 * supplier/customer onto the Odoo `res.partner` that mirrors it.
 */
export async function findOneId(
  cfg: OdooConfig,
  model: string,
  domain: unknown[],
  opts: OdooClientOptions = {},
): Promise<number | null> {
  const rows = await searchRead<{ id: number }>(cfg, model, domain, ["id"], {
    ...opts,
    limit: 1,
  });
  return rows.length ? rows[0].id : null;
}

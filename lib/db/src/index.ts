import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

let _pool: pg.Pool | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getPool(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
  }
  if (!_pool) {
    // A list page fans out (the customer-RFQ list loads its items + status
    // evidence, analytics/overview issues ~20 aggregate queries) and every one
    // of them queues behind a pool of 5. Measured against production: the same
    // 20-query fan-out took 2.2 s at max=5 and 0.6 s warm — the connections were
    // the queue, not the queries. Render's plan allows 103, and the app runs one
    // instance, so 20 leaves ample headroom for a second instance plus the
    // webhook/backup workers.
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX ?? 20),
      connectionTimeoutMillis: 10_000, // fail fast if pool exhausted
      idleTimeoutMillis: 30_000,
      statement_timeout: 20_000, // kill queries that run > 20s
    });
  }
  return _pool;
}

export function getDb() {
  if (!_db) {
    _pool = getPool();
    _db = drizzle(_pool, { schema });
  }
  return _db;
}

// Keep named exports for backwards compatibility — accessing these will throw
// if DATABASE_URL is not set, but only at the point of first use.
export const pool = new Proxy({} as pg.Pool, {
  get(_target, prop) {
    return getPool()[prop as keyof pg.Pool];
  },
});

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    return getDb()[prop as keyof ReturnType<typeof drizzle<typeof schema>>];
  },
});

export * from "./schema";

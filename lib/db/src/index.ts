import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

function getPool(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database?",
    );
  }
  return new Pool({ connectionString: process.env.DATABASE_URL });
}

let _pool: pg.Pool | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

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

/**
 * seed.mjs — create initial employee accounts.
 *
 * Safe to run once on a fresh database.
 * WILL NOT overwrite existing records — uses ON CONFLICT DO NOTHING.
 * If you need to reset a password, use the app's admin UI or a direct SQL UPDATE.
 *
 * Required env vars:
 *   DATABASE_URL         — Postgres connection string
 *   SEED_ADMIN_PASS      — password for admin@cortoba-supplies.com
 *   SEED_MANAGER_PASS    — password for khalid@cortoba-supplies.com
 *   SEED_STAFF_PASS      — password for sara@cortoba-supplies.com
 *
 * Usage:
 *   SEED_ADMIN_PASS=... SEED_MANAGER_PASS=... SEED_STAFF_PASS=... \
 *     DATABASE_URL=... node scripts/seed.mjs
 */

import bcrypt from "bcryptjs";
import pg from "pg";

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

function requirePass(envVar) {
  const val = process.env[envVar];
  if (!val) {
    throw new Error(
      `Missing required env var: ${envVar}\n` +
        `Set it before running this script (e.g. ${envVar}=YourStrongPassword123!)`,
    );
  }
  if (val.length < 8) {
    throw new Error(`${envVar} must be at least 8 characters.`);
  }
  return val;
}

const accounts = [
  {
    name: "Admin",
    email: "admin@cortoba-supplies.com",
    password: requirePass("SEED_ADMIN_PASS"),
    role: "admin",
  },
  {
    name: "Khalid Al-Manager",
    email: "khalid@cortoba-supplies.com",
    password: requirePass("SEED_MANAGER_PASS"),
    role: "manager",
  },
  {
    name: "Sara",
    email: "sara@cortoba-supplies.com",
    password: requirePass("SEED_STAFF_PASS"),
    role: "purchasing",
  },
];

for (const acc of accounts) {
  const hash = await bcrypt.hash(acc.password, 12);
  const result = await client.query(
    // ON CONFLICT DO NOTHING — existing records are NEVER overwritten.
    // Redeployment or re-running this script will NOT reset passwords.
    `INSERT INTO employees (name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (email) DO NOTHING`,
    [acc.name, acc.email, hash, acc.role],
  );
  if (result.rowCount > 0) {
    console.log(`Created: ${acc.email} (${acc.role})`);
  } else {
    console.log(`Skipped (already exists): ${acc.email}`);
  }
}

await client.end();
console.log("\nSeed complete.");
console.log("IMPORTANT: Change all default passwords immediately after first login.");

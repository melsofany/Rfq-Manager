/**
 * init-db.mjs — one-time database bootstrap script.
 *
 * Creates all tables (safe to re-run; uses IF NOT EXISTS).
 * Does NOT insert or overwrite any user records.
 * To create the initial admin account run seed.mjs with env vars set.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/init-db.mjs
 */

import pg from "pg";

const { Client } = pg;
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'purchasing',
    phone TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS suppliers (
    id SERIAL PRIMARY KEY,
    supplier_id TEXT,
    name TEXT NOT NULL,
    contact_person TEXT,
    email TEXT,
    phone TEXT,
    address TEXT,
    category TEXT NOT NULL DEFAULT 'general',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS supplier_categories (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS rfq (
    id SERIAL PRIMARY KEY,
    internal_rfq_no TEXT NOT NULL UNIQUE,
    customer_rfq_no TEXT NOT NULL,
    customer_rfq_date TEXT,
    required_response_date TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    employee_id INTEGER REFERENCES employees(id),
    notes TEXT,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS rfq_items (
    id SERIAL PRIMARY KEY,
    rfq_id INTEGER NOT NULL REFERENCES rfq(id) ON DELETE CASCADE,
    item_id TEXT,
    line_item TEXT,
    part_no TEXT,
    description TEXT NOT NULL,
    uom TEXT,
    qty NUMERIC(15,4),
    reference_price NUMERIC(15,4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS sent_log (
    id SERIAL PRIMARY KEY,
    rfq_id INTEGER NOT NULL REFERENCES rfq(id) ON DELETE CASCADE,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    employee_id INTEGER REFERENCES employees(id),
    token TEXT NOT NULL UNIQUE,
    close_date TEXT,
    link_opened BOOLEAN NOT NULL DEFAULT false,
    open_count INTEGER NOT NULL DEFAULT 0,
    first_opened_at TIMESTAMPTZ,
    last_opened_at TIMESTAMPTZ,
    offer_submitted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS offers (
    id SERIAL PRIMARY KEY,
    rfq_id INTEGER NOT NULL REFERENCES rfq(id) ON DELETE CASCADE,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    sent_log_id INTEGER REFERENCES sent_log(id),
    employee_id INTEGER REFERENCES employees(id),
    total_price NUMERIC(15,4),
    general_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS offer_items (
    id SERIAL PRIMARY KEY,
    offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    rfq_item_id INTEGER NOT NULL REFERENCES rfq_items(id),
    price NUMERIC(15,4) NOT NULL,
    tax_included BOOLEAN NOT NULL DEFAULT false,
    delivery_days INTEGER,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    employee_id INTEGER REFERENCES employees(id),
    description TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);

console.log("All tables created (no user records inserted).");
console.log("Run seed.mjs with SEED_ADMIN_PASS / SEED_MANAGER_PASS / SEED_STAFF_PASS to create initial accounts.");

await client.end();

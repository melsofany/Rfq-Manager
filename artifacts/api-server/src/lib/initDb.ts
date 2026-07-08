import { pool } from "@workspace/db";
import bcrypt from "bcryptjs";
import { logger } from "./logger";

export async function initDb(): Promise<void> {
  logger.info("initDb: connecting to database...");
  const client = await pool.connect();
  logger.info("initDb: connected successfully");
  try {
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
      CREATE TABLE IF NOT EXISTS whatsapp_chats (
        id SERIAL PRIMARY KEY,
        wa_message_id TEXT UNIQUE,
        direction TEXT NOT NULL,
        phone TEXT NOT NULL,
        supplier_id INTEGER REFERENCES suppliers(id),
        body TEXT NOT NULL,
        is_read BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS whatsapp_reactions (
        id SERIAL PRIMARY KEY,
        wa_message_id TEXT NOT NULL,
        reactor_phone TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uniq_wa_reaction UNIQUE (wa_message_id, reactor_phone)
      );
      CREATE TABLE IF NOT EXISTS whatsapp_media (
        wa_media_id TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        mime_type TEXT NOT NULL,
        filename TEXT,
        stored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Add media columns to whatsapp_chats (safe migration — skipped if already present)
      await client.query(`
        ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS media_id TEXT;
        ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS media_type TEXT;
        ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS mime_type TEXT;
        ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS filename TEXT;
      `);
      logger.info("initDb: all tables created");

    const accounts = [
      { name: "Admin", email: "admin@cortoba-supplies.com", password: "admin123", role: "admin" },
      { name: "Khalid Al-Manager", email: "khalid@cortoba-supplies.com", password: "manager123", role: "manager" },
      { name: "Sara", email: "sara@cortoba-supplies.com", password: "staff123", role: "purchasing" },
    ];
    for (const acc of accounts) {
      const hash = await bcrypt.hash(acc.password, 10);
      await client.query(
        `INSERT INTO employees (name, email, password_hash, role, is_active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (email) DO UPDATE SET role = $4`,
        [acc.name, acc.email, hash, acc.role]
      );
    }
    logger.info("initDb: seed complete");
  } catch (err) {
    logger.error({ err }, "initDb: FAILED");
    throw err;
  } finally {
    client.release();
  }
}

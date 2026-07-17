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
        status TEXT NOT NULL DEFAULT 'DRAFT',
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
      CREATE INDEX IF NOT EXISTS idx_wa_reactions_msg_id ON whatsapp_reactions (wa_message_id);
      CREATE TABLE IF NOT EXISTS whatsapp_media (
        wa_media_id TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        mime_type TEXT NOT NULL,
        filename TEXT,
        stored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id SERIAL PRIMARY KEY,
        internal_po_no TEXT NOT NULL UNIQUE,
        sheet_po_no TEXT NOT NULL,
        receiver_name TEXT,
        receiver_phone TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        employee_id INTEGER REFERENCES employees(id),
        rfq_id INTEGER REFERENCES rfq(id),
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id SERIAL PRIMARY KEY,
        po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        item_id TEXT,
        line_item TEXT,
        part_no TEXT,
        description TEXT NOT NULL,
        uom TEXT,
        qty NUMERIC(15,4),
        reference_price NUMERIC(15,4),
        tax_included BOOLEAN NOT NULL DEFAULT false,
        supplier_id INTEGER REFERENCES suppliers(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Add tax_included to purchase_order_items (safe migration — skipped if already present)
    await client.query(`
      ALTER TABLE purchase_order_items
        ADD COLUMN IF NOT EXISTS tax_included BOOLEAN NOT NULL DEFAULT false;
    `);

    // Add media columns to whatsapp_chats (safe migration — skipped if already present)
    await client.query(`
        ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS media_id TEXT;
        ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS media_type TEXT;
        ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS mime_type TEXT;
        ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS filename TEXT;
      `);
    // Migrate old RFQ status values to new unified status workflow (idempotent)
    await client.query(`
        UPDATE rfq SET status = 'DRAFT' WHERE status = 'draft';
        UPDATE rfq SET status = 'SENT' WHERE status = 'sent';
        UPDATE rfq SET status = 'QUOTED' WHERE status IN ('partial', 'completed');
        UPDATE rfq SET status = 'FAILED' WHERE status IN ('closed', 'cancelled');
        ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS rfq_id INTEGER REFERENCES rfq(id);
      `);

    // Backfill historical data: SENT RFQs that already have offers → QUOTED
    await client.query(`
        UPDATE rfq
        SET status = 'QUOTED'
        WHERE status = 'SENT'
          AND id IN (SELECT DISTINCT rfq_id FROM offers);
      `);

    // Backfill historical data: SENT/QUOTED RFQs linked to a purchase order → SUCCESS
    await client.query(`
        UPDATE rfq
        SET status = 'SUCCESS'
        WHERE status IN ('SENT', 'QUOTED')
          AND id IN (SELECT DISTINCT rfq_id FROM purchase_orders WHERE rfq_id IS NOT NULL);
      `);
    logger.info("initDb: all tables created");

    // ── ERP Integrations table ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS erp_integrations (
        id               SERIAL PRIMARY KEY,
        name             TEXT NOT NULL,
        type             TEXT NOT NULL,
        config           JSONB NOT NULL DEFAULT '{}',
        is_active        BOOLEAN NOT NULL DEFAULT true,
        last_sync_at     TIMESTAMPTZ,
        last_sync_status TEXT,
        last_sync_error  TEXT,
        last_sync_stats  JSONB,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Seed accounts — passwords read from env vars; MUST be changed after first login in production
    const accounts = [
      {
        name: "Admin",
        email: "admin@cortoba-supplies.com",
        password: process.env.SEED_ADMIN_PASS ?? "Cortoba@Admin1",
        role: "admin",
      },
      {
        name: "Khalid Al-Manager",
        email: "khalid@cortoba-supplies.com",
        password: process.env.SEED_MANAGER_PASS ?? "Cortoba@Mgr1",
        role: "manager",
      },
      {
        name: "Sara",
        email: "sara@cortoba-supplies.com",
        password: process.env.SEED_STAFF_PASS ?? "Cortoba@Staff1",
        role: "purchasing",
      },
    ];
    for (const acc of accounts) {
      const hash = await bcrypt.hash(acc.password, 10);
      await client.query(
        `INSERT INTO employees (name, email, password_hash, role, is_active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (email) DO UPDATE SET role = $4`,
        [acc.name, acc.email, hash, acc.role],
      );
    }
    // ── Seed supplier categories ──────────────────────────────────────────────
    const categories = ["الميكانيكا", "معدات البترول"];
    for (const cat of categories) {
      await client.query(
        `INSERT INTO supplier_categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
        [cat],
      );
    }

    // ── Seed suppliers ────────────────────────────────────────────────────────
    const suppliers = [
      {
        name: "DK-LOK Egypt",
        contact: "م. إبراهيم حسونة",
        email: "dklokegypt@andalos-group.com",
        phone: "01066033398",
        address: "9أ شارع رفاعة، مصر الجديدة، القاهرة",
        category: "الميكانيكا",
      },
      {
        name: "الفتح للهيدروليك",
        contact: null,
        email: "info@elfath-egypt.com",
        phone: "01091893963",
        address: "71 عمارات السعودية، السواح، حدائق القبة، القاهرة",
        category: "الميكانيكا",
      },
      {
        name: "إيتا للهندسة (ETA)",
        contact: null,
        email: "info@eta-egypt.com",
        phone: "01000829882",
        address: "7 شارع الجزائر، المعادي الجديدة، القاهرة",
        category: "الميكانيكا",
      },
      {
        name: "أدماسكو (Admasco)",
        contact: null,
        email: "admasco@admasco-eg.com",
        phone: "0227025224",
        address: "28 ش 270، الشطر الرابع، المعادي الجديدة، القاهرة",
        category: "معدات البترول",
      },
      {
        name: "بتروتك (Petrotech)",
        contact: null,
        email: "info@petrotechegypt.com",
        phone: "01001650215",
        address: "19 شارع أحمد كامل، المعادي الجديدة، القاهرة",
        category: "معدات البترول",
      },
      {
        name: "الدلتا للهيدروليك",
        contact: "م. مجدي سعيد",
        email: "info@deltahydrauliceng.net",
        phone: "01223456395",
        address: "100 شارع السبتية (فرع جسر السويس)، القاهرة",
        category: "الميكانيكا",
      },
      {
        name: "النيل للمعدات البترولية",
        contact: null,
        email: "sales1@nile-trade.com",
        phone: "01000829882",
        address: "2 أبراج أغاخان، كورنيش النيل، المظلات، القاهرة",
        category: "معدات البترول",
      },
      {
        name: "هانز هيدروليك",
        contact: null,
        email: "hans_hydraulic@yahoo.com",
        phone: "01017851376",
        address: "129 شارع السبتية، أمام سوق العصر، القاهرة",
        category: "الميكانيكا",
      },
      {
        name: "الهندسية للتوريدات",
        contact: null,
        email: "info@engineeringco-eg.com",
        phone: "01100170007",
        address: "100 شارع السبتية، وسط البلد، القاهرة",
        category: "الميكانيكا",
      },
      {
        name: "الدولية للهيدروليك",
        contact: "م. عليوة أبو غرام",
        email: "info@eldawlya-hydraulic.com",
        phone: "01016888666",
        address: "شارع فتحي مرعي، مدينة السلام، القاهرة",
        category: "الميكانيكا",
      },
    ];
    for (const s of suppliers) {
      await client.query(
        `INSERT INTO suppliers (name, contact_person, email, phone, address, category, is_active)
         SELECT $1, $2, $3, $4, $5, $6, true
         WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE name = $1)`,
        [s.name, s.contact, s.email, s.phone, s.address, s.category],
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

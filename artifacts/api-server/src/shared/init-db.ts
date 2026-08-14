import { pool } from "@workspace/db";
import bcrypt from "bcryptjs";
import { logger } from "./logger";

export async function initDb(): Promise<void> {
  logger.info("initDb: connecting to database...");
  const client = await pool.connect();
  logger.info("initDb: connected successfully");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS representatives (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
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
        customer_rfq_item_id INTEGER REFERENCES customer_rfq_items(id) ON DELETE SET NULL,
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
        is_approved BOOLEAN NOT NULL DEFAULT false,
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
      CREATE TABLE IF NOT EXISTS rfq_attachments (
        id SERIAL PRIMARY KEY,
        rfq_id INTEGER NOT NULL REFERENCES rfq(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        content TEXT NOT NULL,
        uploaded_by INTEGER REFERENCES employees(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS offer_attachments (
        id SERIAL PRIMARY KEY,
        offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      CREATE TABLE IF NOT EXISTS work_order_assignments (
        id SERIAL PRIMARY KEY,
        po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        representative_id INTEGER REFERENCES representatives(id),
        representative_name TEXT NOT NULL,
        representative_phone TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        pending_action TEXT,
        wa_message_id TEXT,
        rejection_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        customer_id TEXT,
        name TEXT NOT NULL,
        nickname TEXT,
        contact_person TEXT,
        email TEXT,
        phone TEXT,
        address TEXT,
        tax_id TEXT,
        notes TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS customer_rfqs (
        id SERIAL PRIMARY KEY,
        internal_no TEXT NOT NULL UNIQUE,
        customer_id INTEGER REFERENCES customers(id),
        customer_name TEXT NOT NULL,
        customer_rfq_no TEXT NOT NULL,
        number_auto_generated BOOLEAN NOT NULL DEFAULT false,
        entry_date TEXT,
        expiry_date TEXT,
        buyer_name TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS customer_rfq_items (
        id SERIAL PRIMARY KEY,
        customer_rfq_id INTEGER NOT NULL REFERENCES customer_rfqs(id) ON DELETE CASCADE,
        part_no TEXT,
        line_item TEXT,
        description TEXT,
        uom TEXT,
        qty NUMERIC(15,4),
        unit_price NUMERIC(15,4),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS customer_pos (
        id SERIAL PRIMARY KEY,
        internal_po_no TEXT NOT NULL UNIQUE,
        customer_po_no TEXT NOT NULL,
        customer_id INTEGER REFERENCES customers(id),
        customer_name TEXT,
        po_date TEXT,
        buyer_name TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        employee_id INTEGER REFERENCES employees(id),
        employee_name TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS customer_po_items (
        id SERIAL PRIMARY KEY,
        customer_po_id INTEGER NOT NULL REFERENCES customer_pos(id) ON DELETE CASCADE,
        customer_rfq_id INTEGER REFERENCES customer_rfqs(id),
        customer_rfq_item_id INTEGER REFERENCES customer_rfq_items(id) ON DELETE SET NULL,
        part_no TEXT,
        line_item TEXT,
        description TEXT,
        uom TEXT,
        qty NUMERIC(15,4),
        unit_price NUMERIC(15,4),
        delivery_date TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Add tax_included to purchase_order_items (safe migration — skipped if already present)
    await client.query(`
      ALTER TABLE purchase_order_items
        ADD COLUMN IF NOT EXISTS tax_included BOOLEAN NOT NULL DEFAULT false;
    `);

    // Add description to customer_rfq_items (safe migration — skipped if already present)
    await client.query(`
      ALTER TABLE customer_rfq_items ADD COLUMN IF NOT EXISTS description TEXT;
      ALTER TABLE customer_rfq_items ADD COLUMN IF NOT EXISTS unit_price NUMERIC(15,4);
    `);

    // Add owning customer to customer_pos (safe migration — skipped if already present)
    await client.query(`
      ALTER TABLE customer_pos ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id);
      ALTER TABLE customer_pos ADD COLUMN IF NOT EXISTS customer_name TEXT;
    `);

    // Add delivery_days and notes to offer_items (safe migration — skipped if already present)
    await client.query(`
      ALTER TABLE offer_items ADD COLUMN IF NOT EXISTS delivery_days INTEGER;
      ALTER TABLE offer_items ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE offer_items ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT false;
    `);

    // Link supplier RFQ items back to the originating customer RFQ item for
    // exact margin checks. Nullable for legacy/sheet-only supplier RFQs.
    await client.query(`
      ALTER TABLE rfq_items ADD COLUMN IF NOT EXISTS customer_rfq_item_id INTEGER REFERENCES customer_rfq_items(id) ON DELETE SET NULL;
    `);

    // Record the employee who entered each customer RFQ (auto from session).
    await client.query(`
      ALTER TABLE customer_rfqs ADD COLUMN IF NOT EXISTS employee_id INTEGER REFERENCES employees(id);
      ALTER TABLE customer_rfqs ADD COLUMN IF NOT EXISTS employee_name TEXT;
    `);

    // Add media columns to whatsapp_chats (safe migration — skipped if already present)
    await client.query(`
        ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS media_id TEXT;
        ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS media_type TEXT;
        ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS mime_type TEXT;
        ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS filename TEXT;
        ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS reply_to_message_id TEXT;
      `);

    // Add filename column to whatsapp_media (safe migration — skipped if already present)
    await client.query(`
        ALTER TABLE whatsapp_media ADD COLUMN IF NOT EXISTS filename TEXT;
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

    // ── Goods receipt / customer delivery tracking (line-item level) ───────
    // New columns on existing tables (safe migration — skipped if present).
    await client.query(`
      ALTER TABLE purchase_order_items
        ADD COLUMN IF NOT EXISTS customer_po_item_id INTEGER REFERENCES customer_po_items(id) ON DELETE SET NULL;
      ALTER TABLE purchase_order_items
        ADD COLUMN IF NOT EXISTS total_received_qty NUMERIC(15,4);
      ALTER TABLE purchase_order_items
        ADD COLUMN IF NOT EXISTS total_accepted_qty NUMERIC(15,4);
      ALTER TABLE purchase_order_items
        ADD COLUMN IF NOT EXISTS total_rejected_qty NUMERIC(15,4);
      ALTER TABLE purchase_order_items
        ADD COLUMN IF NOT EXISTS final_actual_cost NUMERIC(15,4);
      ALTER TABLE purchase_order_items
        ADD COLUMN IF NOT EXISTS line_status TEXT NOT NULL DEFAULT 'pending';

      ALTER TABLE customer_po_items
        ADD COLUMN IF NOT EXISTS total_delivered_qty NUMERIC(15,4);
      ALTER TABLE customer_po_items
        ADD COLUMN IF NOT EXISTS total_rejected_by_customer_qty NUMERIC(15,4);
      ALTER TABLE customer_po_items
        ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending';

      ALTER TABLE work_order_assignments
        ADD COLUMN IF NOT EXISTS po_item_id INTEGER REFERENCES purchase_order_items(id) ON DELETE SET NULL;
    `);

    // Per-line supplier PO receipt log. A purchase_order_item may have several
    // rows (partial shipments); the aggregated totals mirror onto
    // purchase_order_items, but these rows are the source of truth.
    await client.query(`
      CREATE TABLE IF NOT EXISTS po_item_receipts (
        id SERIAL PRIMARY KEY,
        po_item_id INTEGER NOT NULL REFERENCES purchase_order_items(id) ON DELETE CASCADE,
        po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        assignment_id INTEGER REFERENCES work_order_assignments(id) ON DELETE SET NULL,
        received_qty NUMERIC(15,4),
        accepted_qty NUMERIC(15,4),
        rejected_qty NUMERIC(15,4),
        rejection_reason TEXT,
        actual_cost NUMERIC(15,4),
        receipt_status TEXT NOT NULL DEFAULT 'received',
        received_by TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Per-line customer delivery log. Delivered qty is guarded in the API
    // against the accepted qty received from the supplier (via customerPoItemId).
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_po_item_deliveries (
        id SERIAL PRIMARY KEY,
        customer_po_item_id INTEGER NOT NULL REFERENCES customer_po_items(id) ON DELETE CASCADE,
        customer_po_id INTEGER NOT NULL REFERENCES customer_pos(id) ON DELETE CASCADE,
        delivered_qty NUMERIC(15,4),
        rejected_by_customer_qty NUMERIC(15,4),
        rejection_reason TEXT,
        delivery_status TEXT NOT NULL DEFAULT 'delivered',
        delivered_by TEXT,
        delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    logger.info("initDb: all tables created");

    // ── Egyptian tax-compliance settings (single row, keyed 'default') ───────
    // Defaults follow the Egyptian VAT Law (No. 67 of 2016) and the withholding
    // schedule (خصم تحت حساب المورد): 14% VAT, 3% services withholding, 1%
    // purchases withholding. Rates are editable via the /accounts settings tab
    // so the company can track future amendments without a redeploy.
    await client.query(`
      CREATE TABLE IF NOT EXISTS tax_settings (
        id                        SERIAL PRIMARY KEY,
        key                       TEXT NOT NULL UNIQUE DEFAULT 'default',
        company_name              TEXT,
        company_tax_id            TEXT,
        company_address           TEXT,
        company_phone             TEXT,
        vat_rate                  NUMERIC(6,4) NOT NULL DEFAULT 14,
        withholding_rate          NUMERIC(6,4) NOT NULL DEFAULT 3,
        withholding_rate_services NUMERIC(6,4) NOT NULL DEFAULT 5,
        withholding_rate_purchases NUMERIC(6,4) NOT NULL DEFAULT 1,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      INSERT INTO tax_settings (key)
      VALUES ('default')
      ON CONFLICT (key) DO NOTHING;
    `);

    // ── PO line-item charges (مصاريف مرتبطة ببند أمر الشراء) ───────────────
    // Charges attached to a single supplier PO line (نقل/شحن/جمارك/تحميل/…)
    // so the true cost of each line is known. Summed into the realized cost in
    // the accounts margin computation.
    await client.query(`
      CREATE TABLE IF NOT EXISTS po_item_charges (
        id          SERIAL PRIMARY KEY,
        po_item_id  INTEGER NOT NULL REFERENCES purchase_order_items(id) ON DELETE CASCADE,
        po_id       INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        charge_type TEXT NOT NULL,
        description TEXT,
        amount      NUMERIC(15,4) NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── Company operating expenses (مصروفات الشركة التشغيلية) ──────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS operating_expenses (
        id            SERIAL PRIMARY KEY,
        category      TEXT NOT NULL,
        description   TEXT,
        expense_date  TEXT NOT NULL,
        amount        NUMERIC(15,4) NOT NULL,
        notes         TEXT,
        employee_id   INTEGER REFERENCES employees(id),
        employee_name TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS expense_attachments (
        id            SERIAL PRIMARY KEY,
        expense_id    INTEGER NOT NULL REFERENCES operating_expenses(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        mime_type     TEXT NOT NULL,
        size          INTEGER NOT NULL,
        content       TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── Customer collection tracking (تحصيل مستحقات العملاء) ──────────────
    // 1:1 terms record per customer PO + a payments ledger.
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_po_collections (
        id                    SERIAL PRIMARY KEY,
        customer_po_id        INTEGER NOT NULL REFERENCES customer_pos(id) ON DELETE CASCADE,
        collection_start_date TEXT,
        collection_days       INTEGER NOT NULL DEFAULT 30,
        due_date              TEXT,
        notes                 TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS customer_po_collections_customer_po_id_uniq
        ON customer_po_collections (customer_po_id);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_po_payments (
        id              SERIAL PRIMARY KEY,
        customer_po_id  INTEGER NOT NULL REFERENCES customer_pos(id) ON DELETE CASCADE,
        payment_date    TEXT NOT NULL,
        amount          NUMERIC(15,4) NOT NULL,
        method          TEXT,
        reference       TEXT,
        notes           TEXT,
        employee_id     INTEGER REFERENCES employees(id),
        employee_name   TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

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

    // Seed initial accounts ONLY if the employees table is empty.
    // Passwords are read exclusively from env vars — no fallback defaults.
    // ON CONFLICT DO NOTHING guarantees existing records (and passwords) are
    // never overwritten on restart or redeploy.
    // ── Idempotent column additions (safe on existing DBs) ──────────────────
    await client.query(`
      ALTER TABLE rfq        ADD COLUMN IF NOT EXISTS expires_at   TIMESTAMPTZ;
      ALTER TABLE sent_log   ADD COLUMN IF NOT EXISTS close_date   TEXT;
      ALTER TABLE rfq_items  ADD COLUMN IF NOT EXISTS item_id      TEXT;
      ALTER TABLE rfq_items  ADD COLUMN IF NOT EXISTS line_item    TEXT;
      ALTER TABLE rfq_items  ADD COLUMN IF NOT EXISTS part_no      TEXT;
      ALTER TABLE rfq_items  ADD COLUMN IF NOT EXISTS uom          TEXT;
      ALTER TABLE rfq_items  ADD COLUMN IF NOT EXISTS qty          NUMERIC(15,4);
      ALTER TABLE rfq_items  ADD COLUMN IF NOT EXISTS reference_price NUMERIC(15,4);
    `);

    const existingCount = await client.query("SELECT COUNT(*) FROM employees");
    const isEmpty = parseInt(existingCount.rows[0].count, 10) === 0;
    if (isEmpty) {
      const seedAccounts = [
        {
          name: "Admin",
          email: "admin@cortoba-supplies.com",
          pass: process.env.SEED_ADMIN_PASS,
          role: "admin",
        },
        {
          name: "Khalid Al-Manager",
          email: "khalid@cortoba-supplies.com",
          pass: process.env.SEED_MANAGER_PASS,
          role: "manager",
        },
        {
          name: "Sara",
          email: "sara@cortoba-supplies.com",
          pass: process.env.SEED_STAFF_PASS,
          role: "purchasing",
        },
      ];
      for (const acc of seedAccounts) {
        if (!acc.pass) {
          logger.warn(
            { email: acc.email },
            "initDb: env var for seed password not set — skipping account",
          );
          continue;
        }
        const hash = await bcrypt.hash(acc.pass, 12);
        await client.query(
          `INSERT INTO employees (name, email, password_hash, role, is_active)
           VALUES ($1, $2, $3, $4, true)
           ON CONFLICT (email) DO NOTHING`,
          [acc.name, acc.email, hash, acc.role],
        );
        logger.info({ email: acc.email }, "initDb: seeded initial account");
      }
    } else {
      logger.info("initDb: employees table not empty — skipping user seed");
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

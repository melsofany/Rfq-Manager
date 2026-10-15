import { pool } from "@workspace/db";
import bcrypt from "bcryptjs";
import { logger } from "./logger";
import { seedKeywords } from "../modules/rfq/classification";

export async function initDb(): Promise<void> {
  logger.info("initDb: connecting to database...");
  const client = await pool.connect();
  logger.info("initDb: connected successfully");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "user_sessions" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid")
      );
      CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON "user_sessions" ("expire");
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
        commercial_register TEXT,
        tax_registration TEXT,
        bank_name TEXT,
        bank_account_holder TEXT,
        bank_account_number TEXT,
        iban TEXT,
        swift_code TEXT,
        bank_branch TEXT,
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
      CREATE TABLE IF NOT EXISTS supplier_category_links (
        id SERIAL PRIMARY KEY,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
        category_id INTEGER NOT NULL REFERENCES supplier_categories(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS supplier_category_links_unique
        ON supplier_category_links (supplier_id, category_id);
      CREATE INDEX IF NOT EXISTS idx_supplier_category_links_category
        ON supplier_category_links (category_id);
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
        category_id INTEGER,
        is_cancelled BOOLEAN NOT NULL DEFAULT false,
        attribution_first_po_at TIMESTAMPTZ,
        attribution_employee_id INTEGER,
        attribution_employee_name TEXT,
        attribution_event TEXT,
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

    // ── Responsibility tables (EARLY — must precede any data-dependent DDL) ──
    // These CREATEs are ordered BEFORE the migrations that rewrite existing rows
    // (phone canonicalization, RFQ/PO backfills). Those rewrites touch real data
    // and can fail on a conflict; because initDb() aborts at the first failing
    // statement, a later failure would skip every statement after it — which is
    // exactly how the item_categories table ended up missing in production while
    // the server kept serving. Creating these tables early makes their existence
    // independent of any data-dependent migration below.
    // ── Item categories + employee ownership + per-item assignment ───────────
    // DDL lives here (NOT drizzle-kit push). Each statement is its own
    // client.query: statements share an implicit transaction, so a sibling
    // failure would otherwise roll a CREATE back silently.
    await client.query(`
      CREATE TABLE IF NOT EXISTS item_categories (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        code TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS employee_categories (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        category_id INTEGER NOT NULL REFERENCES item_categories(id) ON DELETE CASCADE,
        is_primary BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS employee_categories_employee_category_uq
        ON employee_categories (employee_id, category_id);
    `);

    // At most ONE primary owner per category, enforced by the database. The
    // API guard on /item-categories/:id/owners only covered one write path, so
    // /employees/:id/categories could still insert a second primary — which made
    // the responsible employee non-deterministic. The index below would reject
    // existing violations, so demote every extra primary FIRST (keeping the
    // lowest id, the same tie-break `pickOwner` uses) in its own statement.
    await client.query(`
      UPDATE employee_categories ec
      SET is_primary = false
      WHERE ec.is_primary
        AND ec.id <> (
          SELECT min(ec2.id)
          FROM employee_categories ec2
          WHERE ec2.category_id = ec.category_id AND ec2.is_primary
        );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS employee_categories_one_primary_uq
        ON employee_categories (category_id)
        WHERE is_primary;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rfq_item_assignments (
        id SERIAL PRIMARY KEY,
        rfq_item_id INTEGER NOT NULL REFERENCES rfq_items(id) ON DELETE CASCADE,
        customer_rfq_item_id INTEGER REFERENCES customer_rfq_items(id) ON DELETE SET NULL,
        category_id INTEGER REFERENCES item_categories(id) ON DELETE SET NULL,
        employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        source TEXT NOT NULL DEFAULT 'auto',
        confidence NUMERIC(5,2),
        assigned_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS rfq_item_assignments_item_uq
        ON rfq_item_assignments (rfq_item_id);
      CREATE INDEX IF NOT EXISTS idx_rfq_item_assignments_employee
        ON rfq_item_assignments (employee_id);
      CREATE INDEX IF NOT EXISTS idx_rfq_item_assignments_category
        ON rfq_item_assignments (category_id);
    `);

    // ── Responsibility source of truth (customer items) ─────────────────────
    // New assignment table keyed on the CUSTOMER item. DDL in its own statement.
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_rfq_item_assignments (
        id SERIAL PRIMARY KEY,
        customer_rfq_item_id INTEGER NOT NULL REFERENCES customer_rfq_items(id) ON DELETE RESTRICT,
        category_id INTEGER REFERENCES item_categories(id) ON DELETE SET NULL,
        employee_id INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
        source TEXT NOT NULL DEFAULT 'auto',
        confidence NUMERIC(5,2),
        assigned_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        valid_from TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        valid_to TIMESTAMPTZ
      );
      -- At most ONE open period per item. Closed-period overlap is prevented by
      -- the gist EXCLUDE constraint added in the migration block below.
      CREATE UNIQUE INDEX IF NOT EXISTS customer_rfq_item_assignments_open_uq
        ON customer_rfq_item_assignments (customer_rfq_item_id) WHERE valid_to IS NULL;
      CREATE INDEX IF NOT EXISTS idx_customer_rfq_item_assignments_employee
        ON customer_rfq_item_assignments (employee_id);
      CREATE INDEX IF NOT EXISTS idx_customer_rfq_item_assignments_category
        ON customer_rfq_item_assignments (category_id);
    `);

    // Per-change audit of responsibility / category (old→new, actor, reason).
    await client.query(`
      CREATE TABLE IF NOT EXISTS item_assignment_audit (
        id SERIAL PRIMARY KEY,
        scope TEXT NOT NULL,
        customer_rfq_item_id INTEGER,
        rfq_item_id INTEGER,
        category_id_old INTEGER,
        category_id_new INTEGER,
        employee_id_old INTEGER,
        employee_id_new INTEGER,
        changed_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        reason TEXT,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_item_assignment_audit_customer_item
        ON item_assignment_audit (customer_rfq_item_id);
      CREATE INDEX IF NOT EXISTS idx_item_assignment_audit_rfq_item
        ON item_assignment_audit (rfq_item_id);
    `);

    // تصنيفات البند المتعددة — one item may belong to several categories. The
    // primary category stays on customer_rfq_items.category_id; this junction
    // records the extra ones a manager attaches. Kept in its OWN statement so a
    // sibling failure can never roll the CREATE back silently.
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_rfq_item_categories (
        id SERIAL PRIMARY KEY,
        customer_rfq_item_id INTEGER NOT NULL REFERENCES customer_rfq_items(id) ON DELETE CASCADE,
        category_id INTEGER NOT NULL REFERENCES item_categories(id) ON DELETE CASCADE,
        employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        added_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS customer_rfq_item_categories_uq
        ON customer_rfq_item_categories (customer_rfq_item_id, category_id);
      CREATE INDEX IF NOT EXISTS idx_customer_rfq_item_categories_item
        ON customer_rfq_item_categories (customer_rfq_item_id);
    `);

    // ذاكرة تصنيف هوية البند — permanent, admin-authoritative classification
    // memory. The recorded defect: the SAME item (same Line Item / Part No /
    // description) got DIFFERENT categories across RFQs. This table is the shared
    // memory that stops it. Kept in its OWN statement: statements share an
    // implicit transaction, so a sibling failure would roll this CREATE back
    // silently (the exact class of bug that left item_categories missing).
    await client.query(`
      CREATE TABLE IF NOT EXISTS item_classification_identity (
        id SERIAL PRIMARY KEY,
        identity_key TEXT NOT NULL,
        part_no TEXT,
        description_sig TEXT,
        category_id INTEGER REFERENCES item_categories(id) ON DELETE SET NULL,
        subcategory_ids TEXT,
        brand_id INTEGER,
        source TEXT NOT NULL DEFAULT 'auto',
        confidence NUMERIC(5,2),
        decided_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        times_seen INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS item_classification_identity_key_uq
        ON item_classification_identity (identity_key);
      CREATE INDEX IF NOT EXISTS idx_item_classification_identity_category
        ON item_classification_identity (category_id);
    `);

    // Add reactivated_at to suppliers — used by the auto-deactivate sweep so a
    // manual reactivation resets the no-reply counter (needs 10 MORE unanswered
    // sends to auto-deactivate again).
    await client.query(`
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS reactivated_at TIMESTAMPTZ;
    `);

    // Add invoice_has_vat to suppliers — marks suppliers that DO NOT issue VAT
    // invoices (غير مُسجَّلin VAT). Purchases from them carry no deductible
    // input VAT; the full amount becomes cost/expense, enabling the company to
    // measure the VAT deficit (عجز ض.ق.م.) caused by those deals.
    await client.query(`
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS invoice_has_vat BOOLEAN NOT NULL DEFAULT true;
    `);

    // بيانات السجل التجاري والتسجيل الضريبي والبيانات البنكية للمورد
    await client.query(`
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS commercial_register TEXT;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tax_registration TEXT;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_name TEXT;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_account_holder TEXT;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_account_number TEXT;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS iban TEXT;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS swift_code TEXT;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_branch TEXT;
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

    // Add the WhatsApp profile name column (safe migration — skipped if present)
    await client.query(`
        ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS contact_name TEXT;
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
      ALTER TABLE customer_po_items
        ADD COLUMN IF NOT EXISTS highlight_color TEXT;
      ALTER TABLE customer_po_items
        ADD COLUMN IF NOT EXISTS highlight_note TEXT;

      ALTER TABLE work_order_assignments
        ADD COLUMN IF NOT EXISTS po_item_id INTEGER REFERENCES purchase_order_items(id) ON DELETE SET NULL;
      ALTER TABLE work_order_assignments
        ADD COLUMN IF NOT EXISTS customer_po_id INTEGER REFERENCES customer_pos(id) ON DELETE CASCADE;
      ALTER TABLE work_order_assignments
        ADD COLUMN IF NOT EXISTS customer_po_item_id INTEGER REFERENCES customer_po_items(id) ON DELETE SET NULL;
      ALTER TABLE work_order_assignments
        ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'receipt';
    `);

    // Removed-from-PO items are kept as detached cancelled rows (for the items
    // sheet view), so the owning-PO link must allow NULL. Runs as its OWN
    // statement: statements inside one multi-statement client.query share an
    // implicit transaction, so a failure in any sibling rolls this back too.
    // (A stray JS-style "//" comment here previously made the whole block a
    // syntax error, silently leaving the column NOT NULL and breaking every
    // soft-cancel with a not-null violation.)
    await client.query(`
      ALTER TABLE customer_po_items
        ALTER COLUMN customer_po_id DROP NOT NULL;
    `);

    // Normalize stored representative / work-order-assignment phones to the
    // canonical digits-only international form (no "+", no leading "00",
    // Egyptian local "01…" → "201…"). The WhatsApp rep-bot lookups compare
    // canonical forms, so rows stored historically with a leading "+" would
    // otherwise never match an incoming Meta wa_id ("20…") and the rep bot
    // would not engage. Idempotent — rows already canonical are unchanged.
    //
    // COLLISION-SAFE. representatives.phone is UNIQUE, and two rows that
    // canonicalize to the same value (e.g. "+2010…" and "2010…") used to abort
    // this statement with a duplicate-key violation on representatives_phone_key.
    // Because initDb() stops at the first failing statement, that single
    // duplicate skipped every later migration — which is how item_categories
    // ended up missing in production while the server kept serving. The UPDATE
    // now canonicalizes ONLY rows whose canonical value is unique across the
    // table; colliding rows are left untouched (no data loss, no deactivation)
    // instead of crashing the whole boot.
    await client.query(`
      WITH canon AS (
        SELECT id,
               CASE WHEN phone ~ '[^0-9]'
                    THEN regexp_replace(phone, '[^0-9]', '', 'g')
                    ELSE phone END AS digits
        FROM representatives
      ),
      norm AS (
        SELECT id,
               CASE
                 WHEN digits LIKE '00%' THEN substr(digits, 3)
                 WHEN length(digits) = 11 AND digits LIKE '0%' THEN '2' || substr(digits, 2)
                 WHEN length(digits) = 10 AND digits LIKE '1%' THEN '20' || digits
                 ELSE digits
               END AS canonical
        FROM canon
      ),
      uniq AS (
        SELECT canonical FROM norm GROUP BY canonical HAVING count(*) = 1
      )
      UPDATE representatives r
         SET phone = n.canonical
        FROM norm n
        JOIN uniq u ON u.canonical = n.canonical
       WHERE r.id = n.id
         AND r.phone IS DISTINCT FROM n.canonical;
    `);

    // Work-order assignments have no UNIQUE constraint on the phone, so the
    // simple form is safe and keeps every row canonical.
    await client.query(`
      UPDATE work_order_assignments
        SET representative_phone = regexp_replace(representative_phone, '[^0-9]', '', 'g')
        WHERE representative_phone ~ '[^0-9]';
      UPDATE work_order_assignments
        SET representative_phone = substr(representative_phone, 3)
        WHERE representative_phone LIKE '00%';
      UPDATE work_order_assignments
        SET representative_phone = '2' || substr(representative_phone, 2)
        WHERE length(representative_phone) = 11 AND representative_phone LIKE '0%';
      UPDATE work_order_assignments
        SET representative_phone = '20' || representative_phone
        WHERE length(representative_phone) = 10 AND representative_phone LIKE '1%';
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
    //
    // The CREATE is kept separate from the idempotency INDEXES on purpose: this
    // table predates the idempotency columns, so on an existing database the
    // `CREATE TABLE IF NOT EXISTS` is a no-op and the columns are still absent —
    // creating `..._operation_uq ON (operation_key, ...)` in the same block then
    // failed with `column "operation_key" does not exist`, which stopped initDb
    // and silently skipped every later migration (the missing `category_id`
    // columns on `rfq_items`). The columns are added below, BEFORE the indexes.
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
        idempotency_key TEXT,
        operation_key TEXT,
        payload_hash TEXT,
        wa_message_id TEXT,
        voided BOOLEAN NOT NULL DEFAULT false,
        voided_at TIMESTAMPTZ,
        voided_by INTEGER,
        voided_by_name TEXT,
        void_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Idempotency columns on a table that may predate them. Own statement: the
    // indexes below reference these columns, so they must exist first.
    await client.query(`
      ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
      ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS operation_key TEXT;
      ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS payload_hash TEXT;
      ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS wa_message_id TEXT;
      ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS voided BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
      ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS voided_by INTEGER;
      ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS voided_by_name TEXT;
      ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS void_reason TEXT;
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS customer_po_item_deliveries_operation_uq
        ON customer_po_item_deliveries (operation_key, customer_po_item_id);
      CREATE UNIQUE INDEX IF NOT EXISTS customer_po_item_deliveries_idem_uq
        ON customer_po_item_deliveries (customer_po_item_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS customer_po_item_deliveries_wa_uq
        ON customer_po_item_deliveries (wa_message_id)
        WHERE wa_message_id IS NOT NULL;
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

      ALTER TABLE employees ADD COLUMN IF NOT EXISTS permissions JSONB;
    `);

    // ── Link repair: customer PO lines orphaned by the old save path ─────────
    // Saving a customer RFQ used to delete + re-insert its items, and
    // customer_po_items.customer_rfq_item_id is ON DELETE SET NULL — so every
    // customer-PO line pointing at a recreated RFQ item lost its link and
    // disappeared from the items sheet view. Re-attach such lines to the RFQ
    // item that carries the same part number (else the same line item) within
    // the same customer RFQ. Idempotent: only rows whose link is NULL and that
    // have an unambiguous match are touched.
    await client.query(`
      UPDATE customer_po_items cpi
         SET customer_rfq_item_id = (
               SELECT cri.id
                 FROM customer_rfq_items cri
                WHERE cri.customer_rfq_id = cpi.customer_rfq_id
                  AND (
                    (cpi.part_no IS NOT NULL AND btrim(cri.part_no) = btrim(cpi.part_no))
                    OR (cpi.line_item IS NOT NULL AND btrim(cri.line_item) = btrim(cpi.line_item))
                  )
                ORDER BY (btrim(cri.part_no) = btrim(cpi.part_no)) DESC NULLS LAST, cri.id
                LIMIT 1
             )
       WHERE cpi.customer_rfq_item_id IS NULL
         AND cpi.customer_rfq_id IS NOT NULL
         AND (cpi.part_no IS NOT NULL OR cpi.line_item IS NOT NULL)
         AND EXISTS (
               SELECT 1
                 FROM customer_rfq_items cri
                WHERE cri.customer_rfq_id = cpi.customer_rfq_id
                  AND (
                    (cpi.part_no IS NOT NULL AND btrim(cri.part_no) = btrim(cpi.part_no))
                    OR (cpi.line_item IS NOT NULL AND btrim(cri.line_item) = btrim(cpi.line_item))
                  )
             );
    `);

    // ── Link repair: supplier PO lines never linked to a customer PO line ────
    // purchase_order_items.customer_po_item_id is NULL for every line created
    // from a Google-Sheets lookup or entered free-hand — the common case. Cost,
    // receipts and delivery then cannot be attributed, and the accounts registry
    // rejected the REALIZED cost of goods already received (it fell back to a
    // «تقديري» price instead). Re-attach such lines to the customer-PO line they
    // fulfil: the supplier PO's sheet_po_no must equal a customer PO's
    // customer_po_no, and the line is matched by line_item, else part_no, else
    // description. Idempotent, and only an UNAMBIGUOUS match (exactly one
    // candidate) is written — guessing would attach a receipt to the wrong line.
    await client.query(`
      WITH sup AS (
        SELECT poi.id AS poi_id, poi.line_item, poi.part_no, poi.description,
               lower(btrim(po.sheet_po_no)) AS po_key
          FROM purchase_order_items poi
          JOIN purchase_orders po ON po.id = poi.po_id
         WHERE poi.customer_po_item_id IS NULL
           AND po.sheet_po_no IS NOT NULL
           AND btrim(po.sheet_po_no) <> ''
      ),
      cand AS (
        SELECT s.poi_id,
               cpi.id AS cpi_id,
               count(*) OVER (PARTITION BY s.poi_id) AS n,
               row_number() OVER (
                 PARTITION BY s.poi_id
                 ORDER BY (btrim(cpi.line_item) = btrim(s.line_item)) DESC NULLS LAST, cpi.id
               ) AS rn
          FROM sup s
          JOIN customer_pos cpo ON lower(btrim(cpo.customer_po_no)) = s.po_key
          JOIN customer_po_items cpi ON cpi.customer_po_id = cpo.id
         WHERE (
               (NULLIF(btrim(s.line_item), '') IS NOT NULL
                AND btrim(cpi.line_item) = btrim(s.line_item))
               OR (NULLIF(btrim(s.part_no), '') IS NOT NULL
                   AND btrim(cpi.part_no) = btrim(s.part_no))
               OR (NULLIF(btrim(s.description), '') IS NOT NULL
                   AND btrim(cpi.description) = btrim(s.description))
         )
      )
      UPDATE purchase_order_items poi
         SET customer_po_item_id = cand.cpi_id
        FROM cand
       WHERE poi.id = cand.poi_id
         AND cand.rn = 1
         AND cand.n = 1;
    `);

    // ══════════════════════════════════════════════════════════════════════
    // Accounting — القيد المزدوج ودليل الحسابات
    // ══════════════════════════════════════════════════════════════════════
    // All DDL lives here (CREATE TABLE IF NOT EXISTS) so Render picks it up
    // on next startup — the drizzle-kit prebuild push is NOT relied upon.
    await client.query(`
      CREATE TABLE IF NOT EXISTS chart_of_accounts (
        id          SERIAL PRIMARY KEY,
        code        TEXT NOT NULL UNIQUE,
        name_ar     TEXT NOT NULL,
        name_en     TEXT,
        type         TEXT NOT NULL,
        parent_id   INTEGER,
        is_control  BOOLEAN NOT NULL DEFAULT false,
        is_active   BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id                SERIAL PRIMARY KEY,
        entry_no          TEXT NOT NULL UNIQUE,
        entry_date        TEXT NOT NULL,
        description       TEXT NOT NULL,
        source            TEXT,
        source_ref_id     INTEGER,
        status            TEXT NOT NULL DEFAULT 'draft',
        total_debit       NUMERIC(18,4) NOT NULL DEFAULT 0,
        total_credit      NUMERIC(18,4) NOT NULL DEFAULT 0,
        employee_id       INTEGER REFERENCES employees(id),
        employee_name     TEXT,
        reviewed_by       INTEGER REFERENCES employees(id),
        reviewed_by_name  TEXT,
        reviewed_at       TIMESTAMPTZ,
        posted_at         TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS journal_lines (
        id            SERIAL PRIMARY KEY,
        entry_id      INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
        account_code  TEXT NOT NULL,
        line_no       INTEGER NOT NULL DEFAULT 1,
        description   TEXT,
        debit         NUMERIC(18,4) NOT NULL DEFAULT 0,
        credit        NUMERIC(18,4) NOT NULL DEFAULT 0,
        party_type    TEXT,
        party_id      INTEGER,
        party_name    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS journal_lines_entry_id_idx ON journal_lines(entry_id);
      CREATE INDEX IF NOT EXISTS journal_lines_account_code_idx ON journal_lines(account_code);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS supplier_invoices (
        id                    SERIAL PRIMARY KEY,
        invoice_no            TEXT NOT NULL UNIQUE,
        supplier_invoice_no   TEXT,
        supplier_id           INTEGER REFERENCES suppliers(id),
        supplier_name         TEXT NOT NULL,
        po_id                 INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
        po_no                 TEXT,
        invoice_date          TEXT NOT NULL,
        due_date              TEXT,
        net_amount            NUMERIC(15,4) NOT NULL DEFAULT 0,
        vat_amount            NUMERIC(15,4) NOT NULL DEFAULT 0,
        has_vat              BOOLEAN NOT NULL DEFAULT true,
        withholding_rate      NUMERIC(6,4) NOT NULL DEFAULT 0,
        withholding_amount    NUMERIC(15,4) NOT NULL DEFAULT 0,
        gross_amount          NUMERIC(15,4) NOT NULL DEFAULT 0,
        paid_amount           NUMERIC(15,4) NOT NULL DEFAULT 0,
        balance               NUMERIC(15,4) NOT NULL DEFAULT 0,
        status                TEXT NOT NULL DEFAULT 'draft',
        journal_entry_id      INTEGER,
        notes                 TEXT,
        employee_id           INTEGER REFERENCES employees(id),
        employee_name         TEXT,
        reviewed_by           INTEGER REFERENCES employees(id),
        reviewed_by_name      TEXT,
        reviewed_at           TIMESTAMPTZ,
        posted_at             TIMESTAMPTZ,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS supplier_payments (
        id                  SERIAL PRIMARY KEY,
        payment_no          TEXT NOT NULL UNIQUE,
        supplier_id         INTEGER REFERENCES suppliers(id),
        supplier_name       TEXT NOT NULL,
        po_id               INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
        po_no               TEXT,
        payment_date        TEXT NOT NULL,
        method              TEXT NOT NULL,
        reference           TEXT,
        amount              NUMERIC(15,4) NOT NULL,
        bank_charges        NUMERIC(15,4) NOT NULL DEFAULT 0,
        cash_account_code   TEXT NOT NULL DEFAULT '1001',
        status              TEXT NOT NULL DEFAULT 'posted',
        journal_entry_id    INTEGER,
        notes               TEXT,
        employee_id         INTEGER REFERENCES employees(id),
        employee_name       TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS supplier_payment_applications (
        id          SERIAL PRIMARY KEY,
        payment_id  INTEGER NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
        invoice_id  INTEGER NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
        amount      NUMERIC(15,4) NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS sales_invoices (
        id                SERIAL PRIMARY KEY,
        invoice_no        TEXT NOT NULL UNIQUE,
        customer_po_id    INTEGER REFERENCES customer_pos(id) ON DELETE SET NULL,
        customer_po_no    TEXT,
        customer_rfq_id   INTEGER REFERENCES customer_rfqs(id) ON DELETE SET NULL,
        customer_id       INTEGER REFERENCES customers(id),
        customer_name     TEXT NOT NULL,
        invoice_date      TEXT NOT NULL,
        due_date          TEXT,
        net_amount        NUMERIC(15,4) NOT NULL DEFAULT 0,
        vat_amount        NUMERIC(15,4) NOT NULL DEFAULT 0,
        gross_amount      NUMERIC(15,4) NOT NULL DEFAULT 0,
        cogs_amount       NUMERIC(15,4) NOT NULL DEFAULT 0,
        collected_amount  NUMERIC(15,4) NOT NULL DEFAULT 0,
        balance           NUMERIC(15,4) NOT NULL DEFAULT 0,
        status            TEXT NOT NULL DEFAULT 'draft',
        journal_entry_id  INTEGER,
        notes             TEXT,
        employee_id       INTEGER REFERENCES employees(id),
        employee_name     TEXT,
        reviewed_by       INTEGER REFERENCES employees(id),
        reviewed_by_name  TEXT,
        reviewed_at       TIMESTAMPTZ,
        posted_at         TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS sales_invoice_items (
        id                  SERIAL PRIMARY KEY,
        invoice_id          INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
        customer_po_item_id INTEGER,
        line_item           TEXT,
        part_no             TEXT,
        description         TEXT NOT NULL,
        uom                 TEXT,
        qty                 NUMERIC(15,4),
        unit_price          NUMERIC(15,4),
        total               NUMERIC(15,4),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Idempotent column additions for the accounting tables (safe on existing DBs).
    await client.query(`
      ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS has_vat BOOLEAN NOT NULL DEFAULT true;
    `);

    // Monthly closing lock — الإقفال الشهري (one row per YYYY-MM; journal
    // entries may not be created/posted/voided/reviewed for a locked month).
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounting_closings (
        id               SERIAL PRIMARY KEY,
        period           TEXT NOT NULL UNIQUE,
        closed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_by        INTEGER REFERENCES employees(id),
        closed_by_name   TEXT,
        notes            TEXT
      );
    `);

    // ── data_entry_sessions ──────────────────────────────────────────────
    // Tracks the time an operator spent filling a "new" form (RFQ / PO)
    // from form-open (startedAt) to successful save (endedAt), so we can
    // measure real data-entry time per employee (weekly/monthly).
    await client.query(`
      CREATE TABLE IF NOT EXISTS data_entry_sessions (
        id                  SERIAL PRIMARY KEY,
        employee_id         INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        type                TEXT NOT NULL,
        started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at            TIMESTAMPTZ,
        rfq_id              INTEGER REFERENCES rfq(id) ON DELETE SET NULL,
        purchase_order_id   INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
        customer_rfq_id     INTEGER REFERENCES customer_rfqs(id) ON DELETE SET NULL,
        customer_po_id      INTEGER REFERENCES customer_pos(id) ON DELETE SET NULL,
        abandoned           BOOLEAN NOT NULL DEFAULT FALSE,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS data_entry_sessions_employee_started_idx
       ON data_entry_sessions (employee_id, started_at)`,
    );

    // ── Seed the default Egyptian chart of accounts (idempotent) ───────────
    // Mirrors ACCOUNT_CODES in lib/db/src/schema/accounting.ts.
    const coaSeed: Array<[string, string, string, boolean]> = [
      // Assets (1xxx)
      ["1001", "النقدية بالخزينة", "asset", true],
      ["1010", "البنوك", "asset", true],
      ["1200", "ذمم العملاء (المدينون)", "asset", true],
      ["1300", "المخزون", "asset", true],
      ["1401", "ضريبة القيمة المضافة على المشتريات (المدخلات)", "asset", true],
      ["1410", "الخصم تحت حساب المورد (مسترد)", "asset", false],
      ["1500", "دفعات مقدمة للموردين", "asset", false],
      // Liabilities (2xxx)
      ["2100", "ذمم الموردين (الدائنون)", "liability", true],
      ["2401", "ضريبة القيمة المضافة على المبيعات (المخرجات)", "liability", true],
      ["2402", "الخصم تحت حساب الضريبة المستحقة للمالية", "liability", true],
      ["2500", "مصروفات مستحقة", "liability", false],
      // Equity (3xxx)
      ["3100", "رأس المال", "equity", false],
      ["3200", "أرباح مرحّلة", "equity", false],
      // Revenue (4xxx)
      ["4100", "إيرادات المبيعات", "revenue", false],
      ["4101", "مردود المبيعات", "revenue", false],
      ["4900", "إيرادات أخرى", "revenue", false],
      // Expenses (5xxx)
      ["5100", "تكلفة البضاعة المباعة", "expense", false],
      ["5110", "خصم مشتريات", "expense", false],
      ["5200", "رواتب وأجور", "expense", false],
      ["5300", "إيجارات", "expense", false],
      ["5400", "كهرباء ومياه", "expense", false],
      ["5401", "كهرباء", "expense", false],
      ["5402", "مياه", "expense", false],
      ["5410", "اتصالات", "expense", false],
      ["5412", "انترنت", "expense", false],
      ["5500", "صيانة", "expense", false],
      ["5600", "مصروفات إدارية", "expense", false],
      ["5700", "خدمات تقنية واستضافة", "expense", false],
      ["5750", "اشتراكات ودعم فني", "expense", false],
      ["5800", "مصاريف نقل وشحن", "expense", false],
      ["5805", "نقل وتنقل", "expense", false],
      ["5810", "مصاريف جمارك", "expense", false],
      ["5900", "عمولات ومصاريف بنكية", "expense", false],
      ["5990", "نثريات", "expense", false],
    ];
    for (const [code, nameAr, type, isControl] of coaSeed) {
      await client.query(
        `INSERT INTO chart_of_accounts (code, name_ar, type, is_control)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO NOTHING`,
        [code, nameAr, type, isControl],
      );
    }
    logger.info({ count: coaSeed.length }, "initDb: chart of accounts seeded");

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

    // ─── AI assistant (admin/manager WhatsApp agent) ──────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_assistant_users (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE,
        name TEXT,
        employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        role TEXT NOT NULL DEFAULT 'manager',
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ai_assistant_messages (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ai_assistant_messages_phone
        ON ai_assistant_messages (phone, created_at DESC);
      CREATE TABLE IF NOT EXISTS ai_assistant_settings (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL UNIQUE DEFAULT 'default',
        enabled BOOLEAN NOT NULL DEFAULT true,
        model TEXT NOT NULL DEFAULT 'deepseek-v4-pro',
        base_url TEXT,
        system_prompt TEXT,
        language TEXT NOT NULL DEFAULT 'ar',
        allow_email BOOLEAN NOT NULL DEFAULT true,
        allow_database BOOLEAN NOT NULL DEFAULT true,
        allow_read_only_sql BOOLEAN NOT NULL DEFAULT true,
        allow_pdf BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO ai_assistant_settings (key) VALUES ('default')
        ON CONFLICT (key) DO NOTHING;
    `);

    // Pin the seeded row to the model the code actually defaults to.
    //
    // Two things had drifted apart: `DEFAULT_MODEL` is `gemini-3.6-flash`, while
    // this DDL and the seed migration below both said `gemini-3.8-flash`. Because
    // `loadSettings()` prefers the DB value, the code default was never reached in
    // production — the deployed assistant ran the model measured as overloaded
    // (answering 1 of 5 probes with the real tool schema), spending its per-model
    // budget on 503s and starving the healthy fallbacks.
    //
    // The primary provider is now DEEPSEEK. Gemini's free tier caps every model at
    // 20 requests/day, which is what made the assistant go quiet and fail tasks
    // mid-run; the operator's own DeepSeek key has no such cap and answered tool
    // calls reliably. This migration moves the deployed row across, because
    // `loadSettings()` reads the DB value first — leaving it at a Gemini id would
    // silently pin production to the exact provider being replaced.
    //
    // The predicate is the GEMINI FAMILY (`ILIKE 'gemini%'`), not a list of
    // retired ids. The deployed row held `gemini-3.5-flash-lite`, which is a
    // perfectly live Gemini id and therefore was NOT in the earlier retired-only
    // list — so the provider switch would have been silently inert in production
    // while every unit test passed. An admin who deliberately wants Gemini can
    // re-pick it in the settings UI; the default must be the un-capped provider.
    //
    // Its own statement so a sibling failure can never roll it back.
    await client.query(`
      UPDATE ai_assistant_settings
         SET model = 'deepseek-v4-pro', updated_at = NOW()
       WHERE key = 'default'
         AND (model ILIKE 'gemini%' OR model ILIKE 'gpt-%' OR model = '');
    `);

    // Read-only-SQL flag on an EXISTING settings row. Its own statement, so a
    // sibling failure cannot roll it back into a missing column (the class of
    // silent migration loss this file has already been bitten by).
    await client.query(`
      ALTER TABLE ai_assistant_settings
        ADD COLUMN IF NOT EXISTS allow_read_only_sql BOOLEAN NOT NULL DEFAULT true;
    `);

    // ─── AI assistant long-term memory ────────────────────────────────────
    // Keep this its own statement: statements in one client.query share an
    // implicit transaction, so a failure anywhere in a combined block rolls the
    // whole thing back and the table silently never exists on Render.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_assistant_memories (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'fact',
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 50,
        source TEXT NOT NULL DEFAULT 'user',
        pinned BOOLEAN NOT NULL DEFAULT false,
        valid_from TIMESTAMPTZ,
        valid_until TIMESTAMPTZ,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_memories_scope_key
        ON ai_assistant_memories (phone, category, key);
      CREATE INDEX IF NOT EXISTS idx_ai_memories_phone
        ON ai_assistant_memories (phone, updated_at DESC);
    `);

    // Incidents: replies that failed or needed correcting. Own statement, like the
    // tables around it, so one failure cannot roll the others back.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_assistant_incidents (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        question TEXT NOT NULL,
        reply TEXT NOT NULL DEFAULT '',
        kinds JSONB NOT NULL,
        detail JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ai_incidents_created
        ON ai_assistant_incidents (created_at DESC);
    `);

    // Conversation state (one row per phone). Its own statement — see the note
    // above on implicit transactions.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_assistant_state (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE,
        last_document_type TEXT,
        last_document_number TEXT,
        last_supplier TEXT,
        last_customer TEXT,
        last_part_no TEXT,
        last_period TEXT,
        last_job_id INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Async jobs (P4/P6). Indexed by phone + created_at for the job list, and a
    // partial-ish lookup on (job_key, status) for idempotent re-issue.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_assistant_jobs (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        question TEXT,
        params JSONB,
        progress JSONB,
        result JSONB,
        error TEXT,
        job_key TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ai_jobs_phone
        ON ai_assistant_jobs (phone, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_jobs_key
        ON ai_assistant_jobs (job_key, status);
    `);

    // Existing job tables lack `attempts` (added with the quota-requeue work).
    // Own statement: statements share an implicit transaction, so a sibling
    // failure could roll this ALTER back silently and leave the requeue path
    // writing to a column that does not exist.
    await client.query(
      `ALTER TABLE ai_assistant_jobs ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`,
    );

    // Persisted scan sessions. The resumable email/item census keeps its cursor
    // and parsed rows here, so a restart resumes instead of re-reading a
    // multi-minute scan. Own statement: statements share an implicit transaction,
    // so a sibling failure could otherwise roll this CREATE back silently.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_assistant_scan_sessions (
        key TEXT PRIMARY KEY,
        session JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ai_scan_sessions_updated
        ON ai_assistant_scan_sessions (updated_at DESC);
    `);

    // Organization profiles — what the assistant learned about a counterparty
    // (aliases, mail domains, document-number formats). Own statement: statements
    // share an implicit transaction, so a sibling failure could roll this CREATE
    // back silently and the learned knowledge would never persist.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_assistant_org_profiles (
        id SERIAL PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name_ar TEXT,
        name_en TEXT,
        aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
        domains JSONB NOT NULL DEFAULT '[]'::jsonb,
        mailboxes JSONB NOT NULL DEFAULT '[]'::jsonb,
        document_formats JSONB NOT NULL DEFAULT '[]'::jsonb,
        notes TEXT,
        confidence INTEGER NOT NULL DEFAULT 0,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        sources JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ai_org_profiles_updated
        ON ai_assistant_org_profiles (updated_at DESC);
    `);

    // ── Search / document-number indexes (P12) ──────────────────────────────
    // The assistant resolves documents by number and suppliers/customers by name
    // with ILIKE '%term%'. Without indexes those become sequential scans as the
    // tables grow. pg_trgm makes a leading-wildcard ILIKE indexable; it is a
    // standard Postgres extension and may be unavailable on a restricted server,
    // so each extension/index is attempted independently and a failure is logged
    // rather than aborting the whole init (which would stop the app booting).
    for (const stmt of [
      `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
      `CREATE INDEX IF NOT EXISTS idx_po_internal_no ON purchase_orders (internal_po_no)`,
      `CREATE INDEX IF NOT EXISTS idx_po_sheet_no ON purchase_orders (sheet_po_no)`,
      `CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders (status)`,
      `CREATE INDEX IF NOT EXISTS idx_po_created ON purchase_orders (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_po_items_supplier ON purchase_order_items (supplier_id)`,
      `CREATE INDEX IF NOT EXISTS idx_po_items_line_status ON purchase_order_items (line_status)`,
      `CREATE INDEX IF NOT EXISTS idx_customer_rfq_no ON customer_rfqs (customer_rfq_no)`,
      `CREATE INDEX IF NOT EXISTS idx_supplier_invoices_no ON supplier_invoices (invoice_no)`,
      `CREATE INDEX IF NOT EXISTS idx_sales_invoices_no ON sales_invoices (invoice_no)`,
      `CREATE INDEX IF NOT EXISTS idx_suppliers_name_trgm ON suppliers USING gin (name gin_trgm_ops)`,
      `CREATE INDEX IF NOT EXISTS idx_customers_name_trgm ON customers USING gin (name gin_trgm_ops)`,
      `CREATE INDEX IF NOT EXISTS idx_po_items_description_trgm ON purchase_order_items USING gin (description gin_trgm_ops)`,
      // Part-number lookups (the assistant's item queries and the alias-aware
      // contains filter) hit these columns with a leading-wildcard ILIKE too.
      `CREATE INDEX IF NOT EXISTS idx_po_items_part_no_trgm ON purchase_order_items USING gin (part_no gin_trgm_ops)`,
      `CREATE INDEX IF NOT EXISTS idx_customer_rfq_items_part_no_trgm ON customer_rfq_items USING gin (part_no gin_trgm_ops)`,
      `CREATE INDEX IF NOT EXISTS idx_customer_rfq_items_line_item_trgm ON customer_rfq_items USING gin (line_item gin_trgm_ops)`,
      // Customer-PO numbers are matched against supplier-PO sheet numbers by
      // number, so both sides need an index for that join-ish lookup to scale.
      `CREATE INDEX IF NOT EXISTS idx_customer_pos_po_no ON customer_pos (customer_po_no)`,
      `CREATE INDEX IF NOT EXISTS idx_customer_po_items_rfq_item ON customer_po_items (customer_rfq_item_id)`,
      `CREATE INDEX IF NOT EXISTS idx_po_items_customer_po_item ON purchase_order_items (customer_po_item_id)`,
      `CREATE INDEX IF NOT EXISTS idx_offers_rfq ON offers (rfq_id)`,
      `CREATE INDEX IF NOT EXISTS idx_offer_items_offer ON offer_items (offer_id)`,
      `CREATE INDEX IF NOT EXISTS idx_offer_items_rfq_item ON offer_items (rfq_item_id)`,
    ]) {
      try {
        await client.query(stmt);
      } catch (err) {
        logger.warn({ err, stmt }, "initDb: optional index/extension skipped");
      }
    }

    // ── Idempotent migration: legacy rfq_item_assignments → customer items ──
    // Only rows whose rfq_item carries a customer_rfq_item_id are migrated. When
    // several supplier lines point at the SAME customer item (one item sent to N
    // suppliers), the deterministic winner is: manual over auto, then the
    // smallest id — so a re-run always produces the same single row. ON CONFLICT
    // DO NOTHING makes the whole statement re-runnable without duplication.
    await client.query(`
      INSERT INTO customer_rfq_item_assignments
        (customer_rfq_item_id, category_id, employee_id, source, confidence, assigned_by)
      SELECT DISTINCT ON (ri.customer_rfq_item_id)
        ri.customer_rfq_item_id,
        a.category_id,
        a.employee_id,
        'inherited',
        a.confidence,
        a.assigned_by
      FROM rfq_item_assignments a
      JOIN rfq_items ri ON ri.id = a.rfq_item_id
      WHERE ri.customer_rfq_item_id IS NOT NULL
      ORDER BY ri.customer_rfq_item_id,
        CASE a.source WHEN 'manual' THEN 0 ELSE 1 END,
        a.id
      ON CONFLICT (customer_rfq_item_id) WHERE valid_to IS NULL DO NOTHING;
    `);

    // ── category_id columns on the existing item tables ─────────────────────
    // A critical migration in its OWN statement: an ALTER in a shared literal
    // can be rolled back by a sibling failure and never applied.
    await client.query(`
      ALTER TABLE customer_rfq_items ADD COLUMN IF NOT EXISTS category_id INTEGER;
    `);
    await client.query(`
      ALTER TABLE rfq_items ADD COLUMN IF NOT EXISTS category_id INTEGER;
    `);
    await client.query(`
      ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS category_id INTEGER;
    `);

    // ── Classification model: kind / parent on item_categories ──────────────
    // A category is one of: functional (a MAIN domain that owns responsibility),
    // subcategory (a specialisation inside a domain) or brand (a manufacturer,
    // metadata only). Each ALTER is its OWN statement: statements in one
    // client.query share an implicit transaction, so a sibling failure would
    // otherwise roll a critical migration back silently.
    await client.query(`
      ALTER TABLE item_categories ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'functional';
    `);
    await client.query(`
      ALTER TABLE item_categories ADD COLUMN IF NOT EXISTS parent_id INTEGER;
    `);
    // Backfill safety: a row created before this column existed keeps
    // 'functional', which is exactly the previous behaviour.
    await client.query(`
      UPDATE item_categories SET kind = 'functional' WHERE kind IS NULL OR kind = '';
    `);

    // ── AI classification analysis on customer_rfq_items ────────────────────
    // The classifier's multi-dimensional suggestion, stored so the manager can
    // review it beside the decision. `category_id` stays the authoritative
    // PRIMARY functional domain; the rest never affect responsibility.
    await client.query(`
      ALTER TABLE customer_rfq_items ADD COLUMN IF NOT EXISTS brand_id INTEGER;
    `);
    await client.query(`
      ALTER TABLE customer_rfq_items ADD COLUMN IF NOT EXISTS subcategory_ids TEXT;
    `);
    await client.query(`
      ALTER TABLE customer_rfq_items ADD COLUMN IF NOT EXISTS technical_attributes TEXT;
    `);
    await client.query(`
      ALTER TABLE customer_rfq_items ADD COLUMN IF NOT EXISTS classify_confidence NUMERIC(5,2);
    `);
    await client.query(`
      ALTER TABLE customer_rfq_items ADD COLUMN IF NOT EXISTS classify_reason TEXT;
    `);

    // ── Category aliases (ELEC / Electrical / كهرباء → one category) ─────────
    // DDL in its OWN statement so a sibling failure cannot roll the CREATE back.
    await client.query(`
      CREATE TABLE IF NOT EXISTS item_category_aliases (
        id SERIAL PRIMARY KEY,
        category_id INTEGER NOT NULL REFERENCES item_categories(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS item_category_aliases_alias_uq
        ON item_category_aliases (alias);
      CREATE INDEX IF NOT EXISTS idx_item_category_aliases_category
        ON item_category_aliases (category_id);
    `);

    // ── Seed the official item categories (idempotent) ──────────────────────
    // `kind` distinguishes a MAIN functional domain (owns responsibility) from a
    // subcategory (a specialisation that inherits its domain's owner) and a
    // brand (metadata only). Seeding is INSERT-only (ON CONFLICT DO NOTHING) so
    // it never rewrites a category the operator has edited or re-typed.
    const itemCategories = [
      { name: "أجهزة", code: "equipment", sort: 10, kind: "functional", parent: null },
      { name: "قطع غيار", code: "spare_parts", sort: 20, kind: "functional", parent: null },
      { name: "كهرباء", code: "electrical", sort: 30, kind: "functional", parent: null },
      // قواطع is a SPECIALISATION inside كهرباء, not a domain of its own: it must
      // never create an independent responsibility, so it points at كهرباء.
      { name: "قواطع", code: "breakers", sort: 40, kind: "subcategory", parent: "كهرباء" },
      { name: "مقاومة حريق", code: "fire_resistance", sort: 50, kind: "functional", parent: null },
    ];
    for (const c of itemCategories) {
      await client.query(
        `INSERT INTO item_categories (name, code, sort_order, kind) VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO NOTHING`,
        [c.name, c.code, c.sort, c.kind],
      );
    }
    // Resolve subcategory parents (idempotent, only when unset so an operator's
    // own re-parenting is never overwritten). Kept as its OWN statement.
    await client.query(`
      UPDATE item_categories child
      SET parent_id = parent.id
      FROM item_categories parent
      WHERE child.parent_id IS NULL
        AND child.kind = 'subcategory'
        AND child.name = 'قواطع'
        AND parent.name = 'كهرباء';
    `);
    // The classifier's own subcategory vocabulary (PLC / Encoders / contactors…)
    // is seeded with its domain so the AI has a real list to choose from.
    const itemSubcategories = [
      { name: "كونتاكتورات", code: "contactors", parent: "كهرباء", sort: 41 },
      { name: "كابلات", code: "cables", parent: "كهرباء", sort: 42 },
      { name: "لوحات كهربائية", code: "panels", parent: "كهرباء", sort: 43 },
      // PLC / Encoders / Control Systems are AUTOMATION instruments, so they sit
      // under the «Automation» subcategory rather than directly under «كهرباء»
      // (nested: كهرباء ← Automation ← Encoders). Responsibility still resolves
      // to the functional domain كهرباء via the full parent chain.
      { name: "Automation", code: "automation", parent: "كهرباء", sort: 45 },
      { name: "PLC", code: "plc", parent: "Automation", sort: 44 },
      { name: "Encoders", code: "encoders", parent: "Automation", sort: 46 },
      { name: "Control Systems", code: "control_systems", parent: "Automation", sort: 47 },
      { name: "Electrical Instruments", code: "instruments", parent: "كهرباء", sort: 48 },
      // الإضاءة تخصص فرعي داخل الكهرباء وليست مجالًا وظيفيًا مستقلًا.
      { name: "إضاءة", code: "lighting", parent: "كهرباء", sort: 49 },
    ];
    for (const s of itemSubcategories) {
      await client.query(
        `INSERT INTO item_categories (name, code, sort_order, kind) VALUES ($1, $2, $3, 'subcategory')
         ON CONFLICT (name) DO NOTHING`,
        [s.name, s.code, s.sort],
      );
      await client.query(
        `UPDATE item_categories child
         SET parent_id = parent.id
         FROM item_categories parent
         WHERE child.name = $1 AND child.parent_id IS NULL AND parent.name = $2`,
        [s.name, s.parent],
      );
    }

    // ── Mirror supplier categories into item categories ─────────────────────
    // The operator's rule: the item categories must be the SAME list as the
    // supplier categories. A supplier category is copied in by NAME (idempotent,
    // ON CONFLICT DO NOTHING), so any category added on /suppliers also appears
    // as an item category — and the reverse is never deleted. Kept as its OWN
    // statement: a sibling failure must not roll the seed back.
    await client.query(`
      INSERT INTO item_categories (name, sort_order)
      SELECT name, 100 FROM supplier_categories
      ON CONFLICT (name) DO NOTHING;
    `);

    // ── Item classification keywords (admin-managed) ────────────────────────
    // The classifier terms move out of code into this table. DDL in its own
    // statement (a sibling failure must not roll the CREATE back).
    await client.query(`
      CREATE TABLE IF NOT EXISTS item_category_keywords (
        id SERIAL PRIMARY KEY,
        category_id INTEGER NOT NULL REFERENCES item_categories(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        weight INTEGER NOT NULL DEFAULT 0,
        language TEXT,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS item_category_keywords_category_keyword_uq
        ON item_category_keywords (category_id, keyword);
      CREATE INDEX IF NOT EXISTS idx_item_category_keywords_category
        ON item_category_keywords (category_id);
    `);

    // Seed the vocabulary from the classifier's own constant, so moving the
    // terms into the DB cannot silently drop one. Idempotent: an existing
    // (category, keyword) row is left untouched — an admin edit is never
    // overwritten by a re-seed.
    const seed = seedKeywords();
    if (seed.length > 0) {
      const codes = [...new Set(seed.map((s) => s.code))];
      const catRows = await client.query(
        `SELECT id, code FROM item_categories WHERE code = ANY($1::text[])`,
        [codes],
      );
      const idByCode = new Map<string, number>(
        catRows.rows.map((r: { id: number; code: string }) => [r.code, r.id]),
      );
      for (const s of seed) {
        const categoryId = idByCode.get(s.code);
        if (categoryId == null) continue;
        await client.query(
          `INSERT INTO item_category_keywords (category_id, keyword, weight)
           VALUES ($1, $2, $3)
           ON CONFLICT (category_id, keyword) DO NOTHING`,
          [categoryId, s.keyword, s.weight],
        );
      }
    }

    // ── Unify ELEC / Electrical into the one «كهرباء» domain (idempotent) ────
    // A supplier category named ELEC was mirrored in as its OWN item category,
    // so the SAME real domain existed twice (كهرباء + ELEC) and an item could be
    // filed under either. The operator's rule: ELEC is an ALIAS, not a separate
    // category. We never DELETE the duplicate (its historical audit rows must
    // survive) — every RELATION is moved to the canonical category and the
    // duplicate is left dormant, reachable only through the alias table.
    // Every statement is its OWN client.query: a sibling failure must not roll
    // one of these data migrations back silently.
    await client.query(`
      UPDATE customer_rfq_items SET category_id = COALESCE((SELECT id FROM item_categories WHERE name = 'كهرباء'), category_id)
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'كهرباء' AND lower(trim(name)) IN ('elec','electrical','electric')
      );
    `);
    await client.query(`
      UPDATE rfq_items SET category_id = COALESCE((SELECT id FROM item_categories WHERE name = 'كهرباء'), category_id)
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'كهرباء' AND lower(trim(name)) IN ('elec','electrical','electric')
      );
    `);
    await client.query(`
      UPDATE purchase_order_items SET category_id = COALESCE((SELECT id FROM item_categories WHERE name = 'كهرباء'), category_id)
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'كهرباء' AND lower(trim(name)) IN ('elec','electrical','electric')
      );
    `);
    await client.query(`
      UPDATE customer_rfq_item_assignments SET category_id = COALESCE((SELECT id FROM item_categories WHERE name = 'كهرباء'), category_id)
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'كهرباء' AND lower(trim(name)) IN ('elec','electrical','electric')
      );
    `);
    await client.query(`
      UPDATE rfq_item_assignments SET category_id = COALESCE((SELECT id FROM item_categories WHERE name = 'كهرباء'), category_id)
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'كهرباء' AND lower(trim(name)) IN ('elec','electrical','electric')
      );
    `);
    // Junction rows: add the canonical row first, then drop the duplicate.
    await client.query(`
      INSERT INTO customer_rfq_item_categories (customer_rfq_item_id, category_id, employee_id, added_by, created_at)
      SELECT customer_rfq_item_id, (SELECT id FROM item_categories WHERE name = 'كهرباء'), employee_id, added_by, created_at
      FROM customer_rfq_item_categories
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'كهرباء' AND lower(trim(name)) IN ('elec','electrical','electric')
      )
      ON CONFLICT (customer_rfq_item_id, category_id) DO NOTHING;
    `);
    await client.query(`
      DELETE FROM customer_rfq_item_categories
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'كهرباء' AND lower(trim(name)) IN ('elec','electrical','electric')
      );
    `);
    // Employee ownership: copy the owners onto the canonical category, then drop
    // the duplicate rows. Inserted as NON-primary first (the partial unique index
    // allows one primary per category); a later statement promotes one if the
    // canonical category has no primary yet — so coverage is never lost and the
    // constraint is never violated.
    await client.query(`
      INSERT INTO employee_categories (employee_id, category_id, is_primary)
      SELECT employee_id, (SELECT id FROM item_categories WHERE name = 'كهرباء'), false
      FROM employee_categories
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'كهرباء' AND lower(trim(name)) IN ('elec','electrical','electric')
      )
      ON CONFLICT (employee_id, category_id) DO NOTHING;
    `);
    await client.query(`
      UPDATE employee_categories SET is_primary = true
      WHERE category_id = (SELECT id FROM item_categories WHERE name = 'كهرباء')
        AND is_primary = false
        AND NOT EXISTS (
          SELECT 1 FROM employee_categories ec2
          WHERE ec2.category_id = (SELECT id FROM item_categories WHERE name = 'كهرباء') AND ec2.is_primary
        )
        AND employee_id = (
          SELECT min(employee_id) FROM employee_categories
          WHERE category_id = (SELECT id FROM item_categories WHERE name = 'كهرباء')
        );
    `);
    await client.query(`
      DELETE FROM employee_categories
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'كهرباء' AND lower(trim(name)) IN ('elec','electrical','electric')
      );
    `);
    // Classifier keywords: merge them onto the canonical category.
    await client.query(`
      INSERT INTO item_category_keywords (category_id, keyword, weight, language, enabled)
      SELECT (SELECT id FROM item_categories WHERE name = 'كهرباء'), keyword, weight, language, enabled
      FROM item_category_keywords
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'كهرباء' AND lower(trim(name)) IN ('elec','electrical','electric')
      )
      ON CONFLICT (category_id, keyword) DO NOTHING;
    `);
    await client.query(`
      DELETE FROM item_category_keywords
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'كهرباء' AND lower(trim(name)) IN ('elec','electrical','electric')
      );
    `);
    // Finally, register the aliases so the SAME domain is never re-created under
    // another spelling. Stored normalised (lowercase for Latin) and idempotent.
    await client.query(`
      INSERT INTO item_category_aliases (category_id, alias)
      SELECT (SELECT id FROM item_categories WHERE name = 'كهرباء'), a.alias
      FROM (VALUES ('elec'), ('electrical'), ('electric'), ('كهرباء')) AS a(alias)
      WHERE EXISTS (SELECT 1 FROM item_categories WHERE name = 'كهرباء')
      ON CONFLICT (alias) DO NOTHING;
    `);

    // ── Reparent automation instruments under «Automation» (idempotent) ──────
    // PLC / Encoders / Control Systems are AUTOMATION instruments, so they belong
    // under the Automation subcategory (nested: كهرباء ← Automation ← Encoders),
    // not directly under كهرباء. The subcategory seed above only sets a parent
    // when it is NULL, so an existing row parented to كهرباء is reparented HERE.
    // Every statement is its OWN client.query (a sibling failure must not roll it
    // back). Responsibility still resolves to the functional domain كهرباء via the
    // full parent chain, so this changes grouping only — never ownership.
    await client.query(`
      UPDATE item_categories child
      SET parent_id = parent.id
      FROM item_categories parent
      WHERE child.kind = 'subcategory'
        AND child.name IN ('PLC','Encoders','Control Systems')
        AND parent.name = 'Automation'
        AND child.parent_id IS DISTINCT FROM parent.id;
    `);

    // ── Unify «الإضاءة» into ONE subcategory of «كهرباء» (idempotent) ────────
    // The operator's rule: «الإضاءة تخصص فرعي داخل الكهرباء وليست مجالًا وظيفيًا
    // مستقلًا». A standalone «اضاءة» category created from the UI (often as a
    // functional domain) is folded onto the canonical «إضاءة» subcategory: every
    // RELATION moves, then the duplicate is left dormant (never deleted — its
    // historical audit rows must survive). Its keywords are NOT carried over,
    // because the canonical lighting vocabulary is seeded in code and carrying a
    // stray term (e.g. a generic word) could mis-classify.
    await client.query(`
      UPDATE customer_rfq_items SET category_id = COALESCE((SELECT id FROM item_categories WHERE name = 'إضاءة'), category_id)
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'إضاءة' AND lower(trim(name)) IN ('اضاءة','اضاءه','lighting','light')
      );
    `);
    await client.query(`
      UPDATE rfq_items SET category_id = COALESCE((SELECT id FROM item_categories WHERE name = 'إضاءة'), category_id)
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'إضاءة' AND lower(trim(name)) IN ('اضاءة','اضاءه','lighting','light')
      );
    `);
    await client.query(`
      UPDATE purchase_order_items SET category_id = COALESCE((SELECT id FROM item_categories WHERE name = 'إضاءة'), category_id)
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'إضاءة' AND lower(trim(name)) IN ('اضاءة','اضاءه','lighting','light')
      );
    `);
    await client.query(`
      UPDATE customer_rfq_item_assignments SET category_id = COALESCE((SELECT id FROM item_categories WHERE name = 'إضاءة'), category_id)
      WHERE category_id IN (
        SELECT id FROM item_categories
        WHERE name <> 'إضاءة' AND lower(trim(name)) IN ('اضاءة','اضاءه','lighting','light')
      );
    `);
    // Ensure the canonical «إضاءة» row is a subcategory of «كهرباء» even if it was
    // created earlier as a functional domain from the admin UI.
    await client.query(`
      UPDATE item_categories child
      SET kind = 'subcategory', parent_id = parent.id
      FROM item_categories parent
      WHERE child.name = 'إضاءة'
        AND parent.name = 'كهرباء'
        AND (child.kind IS DISTINCT FROM 'subcategory' OR child.parent_id IS DISTINCT FROM parent.id);
    `);
    // Deactivate (never delete) the folded duplicates so they stop appearing as
    // independent domains in the admin list while their history survives.
    await client.query(`
      UPDATE item_categories
      SET is_active = false
      WHERE name <> 'إضاءة' AND lower(trim(name)) IN ('اضاءة','اضاءه','lighting','light');
    `);
    // Supplier categories mirror into item categories, so a supplier «اضاءة» would
    // otherwise re-appear on the next boot. Rename it to the canonical name
    // (idempotent), matching how the ELEC alias is consolidated above.
    await client.query(`
      DELETE FROM supplier_categories sc
      WHERE lower(trim(sc.name)) IN ('اضاءة','اضاءه','lighting','light')
        AND EXISTS (SELECT 1 FROM supplier_categories WHERE name = 'إضاءة');
    `);
    await client.query(`
      UPDATE supplier_categories
      SET name = 'إضاءة'
      WHERE lower(trim(name)) IN ('اضاءة','اضاءه','lighting','light');
    `);

    // ── Consolidate the alias spelling in `supplier_categories` (idempotent) ──
    // The item-category side is folded above, but `supplier_categories` is a
    // SEPARATE name list and would keep re-mirroring an «elec» item category on
    // every boot (and show a duplicate option in the supplier dialog). ELEC is
    // an ALIAS, so when the canonical «كهرباء» exists the alias-named rows are
    // removed; otherwise ONE alias row is kept and RENAMED to the canonical (the
    // rest deleted first, so the UNIQUE name index is never violated). No
    // supplier is ever left dangling: `suppliers.category` is rewritten next.
    await client.query(`
      DELETE FROM supplier_categories sc
      WHERE lower(trim(sc.name)) IN ('elec','electrical','electric')
        AND EXISTS (SELECT 1 FROM supplier_categories WHERE name = 'كهرباء');
    `);
    await client.query(`
      DELETE FROM supplier_categories sc
      WHERE lower(trim(sc.name)) IN ('elec','electrical','electric')
        AND sc.id <> (
          SELECT min(id) FROM supplier_categories
          WHERE lower(trim(name)) IN ('elec','electrical','electric')
        );
    `);
    await client.query(`
      UPDATE supplier_categories
      SET name = 'كهرباء'
      WHERE lower(trim(name)) IN ('elec','electrical','electric');
    `);

    // ── Rewrite `suppliers.category` for the merged spellings (idempotent) ────
    // `suppliers.category` is FREE TEXT (comma-separated category NAMES), not a
    // FK — so the relation moves above never touch it, and a supplier that was
    // filed under ELEC keeps the old spelling while the category list now says
    // «كهرباء». The supplier-list filter matches on the NAME, so it then finds
    // no supplier under «كهرباء» and the ELEC-named one is invisible under the
    // new name. Rewrite the text in place, preserving any other category in a
    // comma-joined value and only for suppliers that actually carry a spelling.
    await client.query(`
      UPDATE suppliers
      SET category = (
        SELECT string_agg(
          CASE
            WHEN lower(trim(elem)) IN ('elec','electrical','electric') THEN 'كهرباء'
            ELSE elem
          END,
          ','
        )
        FROM unnest(string_to_array(category, ',')) AS elem
      )
      WHERE category IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM unnest(string_to_array(category, ',')) AS elem
          WHERE lower(trim(elem)) IN ('elec','electrical','electric')
        );
    `);

    // ── Backfill the supplier↔category LINK table (idempotent) ───────────────
    // `supplier_category_links` is now the SOURCE OF TRUTH, seeded from the
    // legacy free-text `suppliers.category`. Two steps, each its own statement:
    //  1. reconcile — any name in the text with no `supplier_categories` row is
    //     created, so no category is silently lost on migration.
    //  2. link — one row per (supplier, category) pair, matched by trimmed name.
    // A name that no longer resolves to a category is skipped (the old text may
    // carry a stale spelling) rather than inserting a dangling link.
    await client.query(`
      INSERT INTO supplier_categories (name)
      SELECT DISTINCT trim(elem)
      FROM suppliers, unnest(string_to_array(category, ',')) AS elem
      WHERE category IS NOT NULL
        AND trim(elem) <> ''
        AND trim(elem) NOT IN (SELECT name FROM supplier_categories)
      ON CONFLICT (name) DO NOTHING;
    `);
    await client.query(`
      INSERT INTO supplier_category_links (supplier_id, category_id)
      SELECT DISTINCT s.id, c.id
      FROM suppliers s
      CROSS JOIN LATERAL unnest(string_to_array(s.category, ',')) AS elem
      JOIN supplier_categories c ON c.name = trim(elem)
      WHERE s.category IS NOT NULL
        AND trim(elem) <> ''
      ON CONFLICT (supplier_id, category_id) DO NOTHING;
    `);

    // ── Procurement responsibility migration (idempotent, re-runnable) ───────
    // Periods + attribution + RESTRICT FKs + delivery idempotency. Every step
    // is guarded by a catalog check and compares the ACTUAL definition (not
    // just the name), so a partially-applied run resumes and a constraint that
    // exists with the wrong definition is corrected. No operational data is
    // ever deleted — only specific old indexes/constraints are replaced.
    await client.query(
      `ALTER TABLE customer_rfq_items ADD COLUMN IF NOT EXISTS is_cancelled BOOLEAN NOT NULL DEFAULT false`,
    );
    await client.query(
      `ALTER TABLE customer_rfq_items ADD COLUMN IF NOT EXISTS attribution_first_po_at TIMESTAMPTZ`,
    );
    await client.query(
      `ALTER TABLE customer_rfq_items ADD COLUMN IF NOT EXISTS attribution_employee_id INTEGER`,
    );
    await client.query(
      `ALTER TABLE customer_rfq_items ADD COLUMN IF NOT EXISTS attribution_employee_name TEXT`,
    );
    await client.query(
      `ALTER TABLE customer_rfq_items ADD COLUMN IF NOT EXISTS attribution_event TEXT`,
    );
    await client.query(
      `ALTER TABLE customer_rfq_item_assignments ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ`,
    );
    await client.query(
      `ALTER TABLE customer_rfq_item_assignments ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ`,
    );
    // Backfill only untouched rows — a re-run never rewrites migrated dates.
    await client.query(
      `UPDATE customer_rfq_item_assignments SET valid_from = COALESCE(assigned_at, clock_timestamp()) WHERE valid_from IS NULL`,
    );
    await client.query(
      `ALTER TABLE customer_rfq_item_assignments ALTER COLUMN valid_from SET DEFAULT clock_timestamp()`,
    );
    await client.query(
      `ALTER TABLE customer_rfq_item_assignments ALTER COLUMN valid_from SET NOT NULL`,
    );
    // Replace the absolute unique index with a partial one (open period only).
    await client.query(`DROP INDEX IF EXISTS customer_rfq_item_assignments_item_uq`);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS customer_rfq_item_assignments_open_uq
         ON customer_rfq_item_assignments (customer_rfq_item_id) WHERE valid_to IS NULL`,
    );
    // btree_gist is needed for `=` inside gist. Best-effort: if unavailable, the
    // application-level row lock is the fallback and the constraint is skipped.
    let hasBtreeGist = false;
    try {
      const avail = await client.query(
        `SELECT 1 FROM pg_available_extensions WHERE name = 'btree_gist'`,
      );
      if (avail.rows.length > 0) {
        await client.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
        hasBtreeGist = true;
      }
    } catch (err) {
      logger.warn({ err }, "initDb: btree_gist unavailable — overlap guard is app-level only");
    }
    if (hasBtreeGist) {
      const expectedExclude =
        "EXCLUDE USING gist (customer_rfq_item_id WITH =, tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamp with time zone), '[)'::text) WITH &&)";
      const excl = await client.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'customer_rfq_item_assignments_no_overlap'
            AND conrelid = 'customer_rfq_item_assignments'::regclass`,
      );
      if (excl.rows.length === 0) {
        await client.query(
          `ALTER TABLE customer_rfq_item_assignments ADD CONSTRAINT customer_rfq_item_assignments_no_overlap
             EXCLUDE USING gist (customer_rfq_item_id WITH =,
               tstzrange(valid_from, COALESCE(valid_to,'infinity'),'[)') WITH &&)`,
        );
      } else if (excl.rows[0].def !== expectedExclude) {
        await client.query(
          `ALTER TABLE customer_rfq_item_assignments DROP CONSTRAINT customer_rfq_item_assignments_no_overlap`,
        );
        await client.query(
          `ALTER TABLE customer_rfq_item_assignments ADD CONSTRAINT customer_rfq_item_assignments_no_overlap
             EXCLUDE USING gist (customer_rfq_item_id WITH =,
               tstzrange(valid_from, COALESCE(valid_to,'infinity'),'[)') WITH &&)`,
        );
      }
    }
    // FK employee_id → RESTRICT (compare referenced table + delete action).
    const empFk = await client.query(
      `SELECT c.confrelid::regclass::text AS ref, c.confdeltype AS del
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.conrelid = 'customer_rfq_item_assignments'::regclass
          AND c.contype = 'f' AND a.attname = 'employee_id'`,
    );
    const empFkOk = empFk.rows.some(
      (r: { ref: string; del: string }) => r.ref === "employees" && r.del === "r",
    );
    if (!empFkOk) {
      await client.query(
        `ALTER TABLE customer_rfq_item_assignments DROP CONSTRAINT IF EXISTS customer_rfq_item_assignments_employee_id_fkey`,
      );
      await client.query(
        `ALTER TABLE customer_rfq_item_assignments ADD CONSTRAINT customer_rfq_item_assignments_employee_id_fkey
           FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT`,
      );
    }
    // FK customer_rfq_item_id → RESTRICT (was CASCADE: deletion would erase history).
    const itemFk = await client.query(
      `SELECT c.confrelid::regclass::text AS ref, c.confdeltype AS del
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.conrelid = 'customer_rfq_item_assignments'::regclass
          AND c.contype = 'f' AND a.attname = 'customer_rfq_item_id'`,
    );
    const itemFkOk = itemFk.rows.some(
      (r: { ref: string; del: string }) => r.ref === "customer_rfq_items" && r.del === "r",
    );
    if (!itemFkOk) {
      await client.query(
        `ALTER TABLE customer_rfq_item_assignments DROP CONSTRAINT IF EXISTS customer_rfq_item_assignments_customer_rfq_item_id_fkey`,
      );
      await client.query(
        `ALTER TABLE customer_rfq_item_assignments ADD CONSTRAINT customer_rfq_item_assignments_customer_rfq_item_id_fkey
           FOREIGN KEY (customer_rfq_item_id) REFERENCES customer_rfq_items(id) ON DELETE RESTRICT`,
      );
    }
    // FK customer_po_items.customer_rfq_item_id → RESTRICT (was SET NULL).
    const poItemFk = await client.query(
      `SELECT c.confrelid::regclass::text AS ref, c.confdeltype AS del
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.conrelid = 'customer_po_items'::regclass
          AND c.contype = 'f' AND a.attname = 'customer_rfq_item_id'`,
    );
    const poItemFkOk = poItemFk.rows.some(
      (r: { ref: string; del: string }) => r.ref === "customer_rfq_items" && r.del === "r",
    );
    if (!poItemFkOk) {
      await client.query(
        `ALTER TABLE customer_po_items DROP CONSTRAINT IF EXISTS customer_po_items_customer_rfq_item_id_fkey`,
      );
      await client.query(
        `ALTER TABLE customer_po_items ADD CONSTRAINT customer_po_items_customer_rfq_item_id_fkey
           FOREIGN KEY (customer_rfq_item_id) REFERENCES customer_rfq_items(id) ON DELETE RESTRICT`,
      );
    }
    // Delivery idempotency columns + indexes.
    await client.query(
      `ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS idempotency_key TEXT`,
    );
    await client.query(
      `ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS operation_key TEXT`,
    );
    await client.query(
      `ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS payload_hash TEXT`,
    );
    await client.query(
      `ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS wa_message_id TEXT`,
    );
    await client.query(
      `ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS voided BOOLEAN NOT NULL DEFAULT false`,
    );
    await client.query(
      `ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ`,
    );
    await client.query(
      `ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS voided_by INTEGER`,
    );
    await client.query(
      `ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS voided_by_name TEXT`,
    );
    await client.query(
      `ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS void_reason TEXT`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS customer_po_item_deliveries_operation_uq
         ON customer_po_item_deliveries (operation_key, customer_po_item_id)`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS customer_po_item_deliveries_idem_uq
         ON customer_po_item_deliveries (customer_po_item_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS customer_po_item_deliveries_wa_uq
         ON customer_po_item_deliveries (wa_message_id) WHERE wa_message_id IS NOT NULL`,
    );
    logger.info("initDb: responsibility migration applied");
    // ══════════════════════════════════════════════════════════════════════
    // HR — الموظفون والحضور بالبصمة (ZKTeco ADMS)
    // ══════════════════════════════════════════════════════════════════════
    await client.query(`
      CREATE TABLE IF NOT EXISTS hr_employees (
        id SERIAL PRIMARY KEY,
        employee_no TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        job_title TEXT,
        department TEXT,
        hire_date DATE,
        status TEXT NOT NULL DEFAULT 'active',
        biometric_pin TEXT UNIQUE,
        phone TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS hr_attendance_devices (
        sn TEXT PRIMARY KEY,
        name TEXT,
        location TEXT,
        is_active BOOLEAN NOT NULL DEFAULT false,
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS hr_attendance_punches (
        id SERIAL PRIMARY KEY,
        device_sn TEXT NOT NULL,
        pin TEXT NOT NULL,
        punched_at TIMESTAMP NOT NULL,
        status TEXT,
        verify TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (device_sn, pin, punched_at)
      )
    `);
    logger.info("initDb: HR attendance tables ensured");
    await client.query(`
      CREATE TABLE IF NOT EXISTS hr_leave_types (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name_ar TEXT NOT NULL,
        name_en TEXT NOT NULL,
        annual_days INTEGER NOT NULL DEFAULT 0,
        paid BOOLEAN NOT NULL DEFAULT true,
        requires_certificate BOOLEAN NOT NULL DEFAULT false,
        is_active BOOLEAN NOT NULL DEFAULT true
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS hr_leave_requests (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL,
        leave_type_id INTEGER NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        days NUMERIC(6,1) NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        reason TEXT,
        certificate_note TEXT,
        decided_by INTEGER,
        decided_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS hr_leave_requests_emp_idx ON hr_leave_requests (employee_id, start_date)`,
    );
    // Seed default leave types once (ON CONFLICT keeps any values the HR team edited).
    await client.query(`
      INSERT INTO hr_leave_types (code, name_ar, name_en, annual_days, paid, requires_certificate) VALUES
        ('annual',  'إجازة سنوية',  'Annual leave',  21, true,  false),
        ('casual',  'إجازة عارضة',  'Casual leave',   6, true,  false),
        ('sick',    'إجازة مرضية',  'Sick leave',     0, true,  true),
        ('unpaid',  'إجازة بدون أجر', 'Unpaid leave', 0, false, false)
      ON CONFLICT (code) DO NOTHING
    `);

    logger.info("initDb: seed complete");
  } catch (err) {
    logger.error({ err }, "initDb: FAILED");
    throw err;
  } finally {
    client.release();
  }
}

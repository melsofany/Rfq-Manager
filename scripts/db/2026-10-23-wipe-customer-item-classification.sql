-- ============================================================================
-- Wipe customer-RFQ item classification so classification restarts clean.
-- Scope (decided 2026-10-23 by the operator):
--   * clear category + AI/keyword analysis on customer_rfq_items
--   * delete every customer_rfq_item_assignments row (open and historical)
--   * clear frozen attribution (incl. the 46 items frozen after a first PO)
--   * delete ALL item_classification_identity memory (auto + manual)
-- Kept on purpose:
--   * customer_rfq_items rows themselves (items, quantities, POs, deliveries)
--   * customer_po_items / customer_pos / deliveries (real business records)
--   * item_category_keywords (the admin's vocabulary, not a decision)
--   * item_assignment_audit (audit trail is never wiped)
--   * supplier-side rfq_items / rfq_item_assignments (separate scope; see note)
--
-- Run in ONE transaction. Read the BEFORE and AFTER counts, then COMMIT or ROLLBACK.
-- NOT idempotent in its effect: running it twice wipes new classifications too.
-- ============================================================================
BEGIN;

-- BEFORE counts
SELECT 'before_items_with_category' AS check, count(*) FROM customer_rfq_items WHERE category_id IS NOT NULL;
SELECT 'before_assignments' AS check, count(*) FROM customer_rfq_item_assignments;
SELECT 'before_frozen_items' AS check, count(*) FROM customer_rfq_items WHERE attribution_first_po_at IS NOT NULL;
SELECT 'before_identities' AS check, count(*) FROM item_classification_identity;

-- 1) Extra categories (multi-category links). Currently 0 rows; cleared for safety.
DELETE FROM customer_rfq_item_categories;

-- 2) Assignments: all rows, open and historical.
DELETE FROM customer_rfq_item_assignments;

-- 3) Item-level classification + frozen attribution. Items are NOT deleted.
UPDATE customer_rfq_items
   SET category_id          = NULL,
       classify_confidence  = NULL,
       classify_reason      = NULL,
       attribution_first_po_at  = NULL,
       attribution_employee_id  = NULL,
       attribution_employee_name = NULL,
       attribution_event        = NULL;

-- 4) Identity memory: every learned or manual identity decision.
DELETE FROM item_classification_identity;

-- AFTER counts (expect 0, 0, 0, 0)
SELECT 'after_items_with_category' AS check, count(*) FROM customer_rfq_items WHERE category_id IS NOT NULL;
SELECT 'after_assignments' AS check, count(*) FROM customer_rfq_item_assignments;
SELECT 'after_frozen_items' AS check, count(*) FROM customer_rfq_items WHERE attribution_first_po_at IS NOT NULL;
SELECT 'after_identities' AS check, count(*) FROM item_classification_identity;

-- COMMIT;   -- uncomment only after reviewing the counts above
-- ROLLBACK; -- default if you are unsure

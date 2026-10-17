-- ============================================================================
-- Fix: classification vocabulary and identity memory polluted by a manager's
-- corrections (2026-10-15/16).
--   «genral»  = ERP line-item label (5730.021.GENRAL.0702), not product text
--   «diameter» = a size word, not a domain term
-- Effect: 918+16 items were classified by the «genral» rule, 22 by «diameter»,
-- and ~31 identities (incl. pn:440F) were locked to the wrong category.
--
-- Safe to re-run: every statement is idempotent.
-- Does NOT delete items, assignments, or attribution history (frozen
-- attributions after a first customer PO are left untouched).
-- Run inside a transaction; review the verification counts before COMMIT.
-- ============================================================================
BEGIN;

-- 1) Remove the polluted keywords (ids verified 2026-10-17).
DELETE FROM item_category_keywords
 WHERE id IN (1323, 1331, 5451)
   AND lower(keyword) IN ('diameter', 'genral');

-- 2) Pin pn:440F (silver solder rod) to «اسطوانات غاز وادوات لحام» (id 34).
UPDATE item_classification_identity
   SET category_id = 34,
       confidence  = 100,
       source      = 'manual',
       description_sig = description_sig,
       updated_at  = now()
 WHERE identity_key = 'pn:440f';

-- 3) Drop auto-learned identities whose signature came from a polluted term.
--    They are re-derived on the next classification run with clean vocabulary.
DELETE FROM item_classification_identity
 WHERE source = 'auto'
   AND identity_key <> 'pn:440f'
   AND description_sig ~ '(genral|diameter)';

-- 4) Re-open classification for items that were classified ONLY by the bad
--    rules and have no customer PO yet. Close their open assignment periods
--    (history kept: valid_to is set, rows are not deleted).
UPDATE customer_rfq_item_assignments a
   SET valid_to = now()
  FROM customer_rfq_items i
 WHERE a.customer_rfq_item_id = i.id
   AND a.valid_to IS NULL
   AND i.attribution_first_po_at IS NULL
   AND i.classify_reason IN ('keyword: genral', 'keyword: diameter');

UPDATE customer_rfq_items
   SET category_id = NULL,
       classify_confidence = NULL,
       classify_reason = NULL
 WHERE classify_reason IN ('keyword: genral', 'keyword: diameter')
   AND attribution_first_po_at IS NULL;

-- Verification (review before COMMIT):
SELECT 'keywords_left' AS check, count(*) FROM item_category_keywords
 WHERE lower(keyword) IN ('diameter', 'genral');
SELECT 'identities_poisoned_left' AS check, count(*) FROM item_classification_identity
 WHERE description_sig ~ '(genral|diameter)' AND source = 'auto';
SELECT 'pn_440f' AS check, category_id, source FROM item_classification_identity
 WHERE identity_key = 'pn:440f';

COMMIT;

-- Read-only check after running the fix. Expect all zeros for the first two rows.
SELECT 'keywords_genral_diameter' AS check, count(*) FROM item_category_keywords WHERE lower(keyword) IN ('diameter','genral');
SELECT 'items_by_genral_or_diameter' AS check, count(*) FROM customer_rfq_items WHERE classify_reason IN ('keyword: genral','keyword: diameter');
SELECT 'identities_poisoned' AS check, count(*) FROM item_classification_identity WHERE description_sig ~ '(genral|diameter)' AND source='auto';

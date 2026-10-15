import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Rename a category NAME inside `suppliers.category`.
 *
 * `suppliers.category` is FREE TEXT holding one or more comma-separated
 * category NAMES — it is NOT a foreign key. So renaming a category in either
 * editor (the supplier-category dialog or the item-category editor) leaves every
 * supplier row still spelling the OLD name, and the supplier list filter — which
 * matches on the NAME (`eq(suppliers.category, name)`) — then finds nothing.
 *
 * This rewrites the text in place: case-insensitive and trimmed on both sides,
 * other categories in a comma-joined value preserved in order. A no-op when the
 * names are equal (case-insensitively).
 */
export async function rewriteSupplierCategoryName(
  oldName: string,
  newName: string,
  handle: { execute: (q: unknown) => Promise<unknown> } = db as unknown as {
    execute: (q: unknown) => Promise<unknown>;
  },
): Promise<void> {
  const from = oldName.trim();
  const to = newName.trim();
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return;
  await handle.execute(sql`
    UPDATE suppliers
    SET category = (
      SELECT string_agg(
        CASE WHEN lower(trim(elem)) = lower(${from}) THEN ${to} ELSE elem END,
        ','
      )
      FROM unnest(string_to_array(category, ',')) AS elem
    )
    WHERE category IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM unnest(string_to_array(category, ',')) AS elem
        WHERE lower(trim(elem)) = lower(${from})
      );
  `);
}

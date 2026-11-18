/**
 * Category de-duplication — ONE rule for both catalogues.
 *
 * The live defect: a category name is the UNIQUE key, so a stray space creates a
 * SECOND row for the same trade. «معدات  فندقيه» (double space) sat beside
 * «معدات فندقيه» in `supplier_categories` AND in `item_categories`, and the
 * supplier mirror then copied every variant across. Measured live: 8 duplicate
 * groups in each table, every pair differing ONLY by whitespace — so this is a
 * formatting repair, never the name-similarity merge the operator reserved for
 * explicit confirmation.
 *
 * Why the previous repair never worked: it renamed the spaced row only when the
 * collapsed name was FREE (`NOT EXISTS (… other.name = collapsed)`). In every
 * real duplicate the collapsed name was already taken, so the guard skipped the
 * row and the duplicate survived every deploy. A duplicate must be RESOLVED, not
 * skipped: move the references onto one survivor, then retire the others.
 *
 * ONE algorithm, not two. The survivor is chosen by `planCategoryDedupe` — the
 * tested, pure ranking — and the SQL is GENERATED from that plan. An earlier cut
 * let the SQL re-derive the survivor with `min(id)`, which DISAGREED with the
 * planner: it consolidated every supplier link onto the retired row and the
 * trade disappeared from `/suppliers`. Two implementations of one rule drift
 * apart silently; there is now only one.
 *
 * Two halves, and both are required:
 *   • PREVENTION — `categoryUniqueKey` is enforced by a functional UNIQUE index,
 *     so a spaced variant can no longer be inserted at all.
 *   • REPAIR — the SQL below folds the duplicates that already exist.
 */
import { canonicalCategoryName } from "./category-tree";

/** The uniqueness key: trimmed, single-spaced, lower-cased. */
export function categoryUniqueKey(name: string): string {
  return canonicalCategoryName(name).toLowerCase();
}

/** The SQL expression that must match `categoryUniqueKey` exactly. */
export const CATEGORY_UNIQUE_EXPR = `lower(btrim(regexp_replace(name, '\\s+', ' ', 'g')))`;

export interface CategoryRow {
  id: number;
  name: string;
  isActive?: boolean | null;
  /** How many rows reference this category (summed across every relation). */
  refCount?: number;
}

export interface DuplicateGroup {
  key: string;
  survivorId: number;
  loserIds: number[];
}

/**
 * Group rows that share a uniqueness key and choose one SURVIVOR per group.
 *
 * Ranking, in order:
 *   1. an ACTIVE row before a retired one — consolidating onto a retired row
 *      would make the whole trade vanish from `/suppliers`, which is the
 *      opposite of the repair;
 *   2. the row everything already points at (most references) — this is what
 *      makes the repair non-destructive, because the spaced variant created by
 *      the bug is always the EMPTY one (measured live: every `item_categories`
 *      spaced copy had zero references);
 *   3. the lowest id, so the choice is deterministic.
 */
export function planCategoryDedupe(rows: CategoryRow[]): DuplicateGroup[] {
  const groups = new Map<string, CategoryRow[]>();
  for (const row of rows) {
    const key = categoryUniqueKey(row.name);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const out: DuplicateGroup[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const ranked = [...list].sort((a, b) => {
      const active = Number(b.isActive ?? true) - Number(a.isActive ?? true);
      if (active !== 0) return active;
      const refs = (b.refCount ?? 0) - (a.refCount ?? 0);
      if (refs !== 0) return refs;
      return a.id - b.id;
    });
    out.push({
      key,
      survivorId: ranked[0].id,
      loserIds: ranked.slice(1).map((r) => r.id),
    });
  }
  return out;
}

/** Every column that references a category id, per catalogue. */
export const CATEGORY_REFERENCES: Record<"supplier" | "item", Array<[string, string]>> = {
  supplier: [["supplier_category_links", "category_id"]],
  item: [
    ["rfq_items", "category_id"],
    ["customer_rfq_items", "category_id"],
    ["customer_rfq_items", "suggested_category_id"],
    ["purchase_order_items", "category_id"],
    ["customer_rfq_item_categories", "category_id"],
    ["employee_categories", "category_id"],
    ["customer_rfq_item_assignments", "category_id"],
    ["rfq_item_assignments", "category_id"],
    ["item_category_keywords", "category_id"],
    ["item_category_aliases", "category_id"],
    ["item_classification_identity", "category_id"],
    ["supplier_item_category_links", "category_id"],
  ],
};

/** Junction tables whose unique index forbids a duplicate pair after a move. */
const UNIQUE_PAIRS: Record<string, [string, string]> = {
  supplier_category_links: ["supplier_id", "category_id"],
  customer_rfq_item_categories: ["customer_rfq_item_id", "category_id"],
  employee_categories: ["employee_id", "category_id"],
  item_category_keywords: ["category_id", "keyword"],
  supplier_item_category_links: ["supplier_id", "category_id"],
};

/** Relations that hold one row per category — the loser's row is dropped. */
const UNIQUE_BY_CATEGORY = new Set(["item_category_aliases", "item_classification_identity"]);

/** `(VALUES (loser, survivor), …)` — the plan, expressed as SQL. */
function groupsValues(groups: DuplicateGroup[]): string {
  return groups.flatMap((g) => g.loserIds.map((loser) => `(${loser}, ${g.survivorId})`)).join(", ");
}

/**
 * The SQL that applies a computed plan, in order.
 *
 * Every statement is independent (the repo's rule: statements in one
 * `client.query` share an implicit transaction, so a sibling failure would roll
 * the others back silently). Each is idempotent — after the first run the groups
 * are empty and nothing is emitted.
 */
export function categoryDedupeSql(
  table: string,
  references: Array<[string, string]>,
  groups: DuplicateGroup[],
  options: { parentColumn?: boolean } = {},
): string[] {
  if (groups.length === 0) return [];
  const pairs = `(VALUES ${groupsValues(groups)}) AS g(loser, survivor)`;
  const losers = groups.flatMap((g) => g.loserIds).join(", ");
  const out: string[] = [];

  // 1) Move references onto the survivor.
  //
  //    A junction row CANNOT be moved with an UPDATE: the survivor may already
  //    hold that pair, so the update would violate the unique index. Measured on
  //    a real Postgres — `duplicate key value violates unique constraint
  //    supplier_category_links_supplier_id_category_id_key`. So a junction is
  //    COPIED onto the survivor (`ON CONFLICT DO NOTHING`) and the loser's rows
  //    are then deleted. A per-category relation keeps the survivor's own row
  //    and drops the loser's. Only a plain column can be moved by an UPDATE.
  for (const [t, c] of references) {
    const pair = UNIQUE_PAIRS[t];
    if (pair && pair[1] === c) {
      const other = pair[0];
      out.push(`INSERT INTO ${t} (${other}, ${c})
        SELECT r.${other}, g.survivor FROM ${t} r JOIN ${pairs} ON g.loser = r.${c}
        ON CONFLICT DO NOTHING`);
      out.push(`DELETE FROM ${t} r USING ${pairs} WHERE r.${c} = g.loser`);
      continue;
    }
    if (UNIQUE_BY_CATEGORY.has(t)) {
      // One row per category: the survivor keeps its own, the loser's is dropped.
      out.push(`DELETE FROM ${t} r USING ${pairs} WHERE r.${c} = g.loser`);
      continue;
    }
    out.push(`UPDATE ${t} r SET ${c} = g.survivor FROM ${pairs} WHERE r.${c} = g.loser`);
  }

  // 2) Children follow their parent onto the survivor.
  if (options.parentColumn) {
    out.push(
      `UPDATE ${table} c SET parent_id = g.survivor FROM ${pairs} WHERE c.parent_id = g.loser`,
    );
  }

  // 3) Retire the losers. Soft delete: the row and its history survive.
  out.push(`UPDATE ${table} SET is_active = false, deleted_at = NOW() WHERE id IN (${losers})`);

  // 4) Normalise every row that STAYS — the survivors and the untouched ones —
  //    so the stored spelling matches the uniqueness key. Losers keep their
  //    spaced name: they are retired, and renaming one would collide with the
  //    survivor under the new unique index.
  out.push(`UPDATE ${table} SET name = btrim(regexp_replace(name, '\\s+', ' ', 'g'))
    WHERE name <> btrim(regexp_replace(name, '\\s+', ' ', 'g'))
      AND id NOT IN (${losers})`);

  return out;
}

/** The reference-count expression used to rank rows, summed across relations. */
export function refCountExpr(
  table: string,
  references: Array<[string, string]>,
  alias = "cat",
): string {
  return references
    .map(([t, c]) => `(SELECT count(*) FROM ${t} r WHERE r.${c} = ${alias}.id)`)
    .join(" + ");
}

/**
 * The ACTIVE row that already owns `name`'s uniqueness key, other than `excludeId`.
 *
 * The uniqueness index is on the normalised name, so a write that would create a
 * second active row with the same key is refused BY THE DATABASE. A route that
 * does not check first therefore surfaces an opaque 500 for what is really a
 * user-visible conflict — restoring a retired duplicate whose twin is still
 * active. Callers use this to answer with the reason and the way forward.
 */
export async function findActiveTwin<T extends { id: unknown; name: unknown }>(
  table: T,
  name: string,
  excludeId: number,
): Promise<{ id: number; name: string } | null> {
  const { db } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");
  const key = categoryUniqueKey(name);
  const result = (await db.execute(sql`
    SELECT id, name FROM ${table}
    WHERE lower(btrim(regexp_replace(name, '\\s+', ' ', 'g'))) = ${key}
      AND deleted_at IS NULL
      AND id <> ${excludeId}
    LIMIT 1
  `)) as unknown as { rows?: Array<{ id: number; name: string }> };
  const row = result?.rows?.[0];
  return row ? { id: Number(row.id), name: String(row.name) } : null;
}

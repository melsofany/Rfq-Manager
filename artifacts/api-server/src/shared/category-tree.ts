/**
 * Category tree helpers — ONE source of truth for the category hierarchy.
 *
 * The catalogue is a tree stored as an adjacency list (`parent_id`), which is
 * what Postgres models naturally and what the UI edits. The problems this
 * module removes, each recorded from the live data:
 *
 *  • A parent filter only matched its DIRECT children, so filtering on
 *    «كهرباء» missed an item filed under «كهرباء ← Automation ← Encoders».
 *    `descendantIds` walks the WHOLE subtree (Odoo's `child_of`).
 *  • Name matching was exact, so «كهرباء» and « كهرباء » (a stray space) were
 *    two different categories. `categoryKey` folds case, whitespace, Arabic
 *    spelling variants and punctuation, and is used for equality everywhere.
 *  • A cycle (A → B → A) would make a tree walk loop forever. `wouldCycle`
 *    rejects a re-parent that closes a loop (Frappe's `validate_loop`).
 *
 * Deliberately pure: no database, no HTTP. Every caller — the routes, the
 * migration and the tests — must agree on these rules, and two copies of a
 * tree rule drift apart silently.
 */

export interface CategoryNode {
  id: number;
  name: string;
  parentId?: number | null;
}

/** Arabic spelling folds: hamza/alef, taa marbuta, yaa, harakat, tatweel. */
const ARABIC_FOLD: Array<[RegExp, string]> = [
  [/[\u0622\u0623\u0625\u0671]/g, "\u0627"], // آ أ إ ٱ → ا
  [/\u0629/g, "\u0647"], // ة → ه
  [/\u0649/g, "\u064a"], // ى → ي
  [/[\u064b-\u0652\u0670\u0640]/g, ""], // harakat + tatweel
];

/**
 * The canonical comparison key for a category name. Two names with the same
 * key are THE SAME category, so the migration merges them and the UI shows one
 * row. Folding is aggressive on purpose: the live catalogue holds
 * «معدات  فندقيه» (double space) beside «معدات فندقيه», which are one trade.
 */
export function categoryKey(name: string | null | undefined): string {
  if (name == null) return "";
  let s = String(name).toLowerCase().trim();
  for (const [re, to] of ARABIC_FOLD) s = s.replace(re, to);
  return s
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * The row that already has this name, comparing by `categoryKey` so spelling
 * variants and stray spaces count as the same name. `exceptId` skips the row
 * being renamed, so a category can keep its own name.
 */
export function findCategoryClash<T extends { id: number; name: string; parentId?: number | null }>(
  rows: T[],
  candidate: string,
  exceptId?: number,
  parentId?: number | null,
): T | undefined {
  const key = categoryKey(candidate);
  const parent = parentId ?? null;
  return rows.find(
    (r) => r.id !== exceptId && (r.parentId ?? null) === parent && categoryKey(r.name) === key,
  );
}

/** Collapse a display name to its canonical single-spaced, trimmed form. */
export function canonicalCategoryName(name: string): string {
  return String(name ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Children of `id`, optionally including the whole subtree, resolved from a
 * flat list. `descendantIds` is the inclusive set: the node itself plus every
 * node below it, at any depth.
 */
export function descendantIds(nodes: CategoryNode[], rootId: number): Set<number> {
  const childrenOf = new Map<number, number[]>();
  for (const n of nodes) {
    if (n.parentId == null) continue;
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n.id);
    childrenOf.set(n.parentId, list);
  }
  const out = new Set<number>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    for (const child of childrenOf.get(current) ?? []) {
      if (out.has(child)) continue; // defensive: a stray cycle cannot loop
      out.add(child);
      stack.push(child);
    }
  }
  return out;
}

/**
 * True when re-parenting `id` under `newParentId` would create a cycle — the
 * new parent is the node itself or one of its descendants. Frappe's
 * `validate_loop`, as a pure predicate so both the route and the migration can
 * reject the same move.
 */
export function wouldCycle(nodes: CategoryNode[], id: number, newParentId: number | null): boolean {
  if (newParentId == null) return false;
  if (newParentId === id) return true;
  return descendantIds(nodes, id).has(newParentId);
}

/**
 * Order a flat list as a depth-first tree: a root, then its subtree, then the
 * next root. `depth` is the real depth (0 for a root) so a picker can indent
 * any number of levels. A node whose parent is missing from the list is shown
 * as a root rather than dropped, and input order is preserved among siblings
 * (the caller sorts).
 */
export function flattenTree<T extends CategoryNode>(nodes: T[]): Array<T & { depth: number }> {
  const ids = new Set(nodes.map((n) => n.id));
  const childrenOf = new Map<number, T[]>();
  const roots: T[] = [];
  for (const n of nodes) {
    if (n.parentId == null || !ids.has(n.parentId)) {
      roots.push(n);
      continue;
    }
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n);
    childrenOf.set(n.parentId, list);
  }
  const out: Array<T & { depth: number }> = [];
  const visited = new Set<number>();
  const walk = (node: T, depth: number) => {
    if (visited.has(node.id)) return; // defensive: a stray cycle cannot loop
    visited.add(node.id);
    out.push({ ...node, depth });
    for (const child of childrenOf.get(node.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // A node unreachable from any root (all its ancestors were missing but it
  // still had a parentId) must not vanish.
  for (const n of nodes) if (!visited.has(n.id)) walk(n, 0);
  return out;
}

/**
 * The full path of a node as display names, e.g. `كهرباء / Automation / PLC`.
 * Returns `[name]` for a root or an unresolvable parent.
 */
export function categoryPath(nodes: CategoryNode[], id: number): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  let current = byId.get(id);
  const guard = new Set<number>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    out.unshift(current.name);
    current = current.parentId != null ? byId.get(current.parentId) : undefined;
  }
  return out;
}

/**
 * True when a category has NO live child — the only kind a supplier may be
 * filed under.
 *
 * ERPNext enforces this with `is_group` plus «Only leaf nodes are allowed in
 * transaction»; a supplier tagged with a parent is counted by every subtree
 * query AND by the parent's own count, so one relationship appears twice and
 * the totals cannot be trusted. Measured live before the rule: 127 links sat on
 * three parents (كهرباء 79, الصحة والسلامة ومقاومة الحريق 42, أدوات النظافة 6).
 *
 * `liveIds` restricts the check to rows that still exist: a RETIRED child must
 * not make its parent unusable, or a soft-deleted leaf would permanently block
 * filing a supplier under the parent it left behind.
 */
export function isLeaf(nodes: CategoryNode[], id: number, liveIds?: Set<number>): boolean {
  return !nodes.some(
    (n) => n.parentId === id && (liveIds == null || (liveIds.has(n.id) && n.id !== id)),
  );
}

/**
 * The ids of every LEAF in the forest — the categories a supplier may be filed
 * under. A node whose parent is missing from the list is still evaluated on its
 * own children, so a detached subtree is never silently treated as a leaf.
 */
export function leafCategoryIds(nodes: CategoryNode[], liveIds?: Set<number>): Set<number> {
  const hasChild = new Set<number>();
  for (const n of nodes) {
    if (n.parentId == null) continue;
    if (liveIds != null && !liveIds.has(n.id)) continue;
    hasChild.add(n.parentId);
  }
  const out = new Set<number>();
  for (const n of nodes) {
    if (liveIds != null && !liveIds.has(n.id)) continue;
    if (!hasChild.has(n.id)) out.add(n.id);
  }
  return out;
}

/**
 * The categories that must be FIXED before a leaf-only rule can hold: a
 * non-leaf that currently holds something. Returned as a report, never applied
 * — the operator reviews the list and re-files the relationships by hand, so no
 * assignment is moved or removed automatically.
 */
export function nonLeafHolders<T extends { id: number; name: string }>(
  nodes: CategoryNode[],
  holders: Map<number, T[]>,
  liveIds?: Set<number>,
): Array<{ id: number; name: string; children: number; holderCount: number; holders: T[] }> {
  const out: Array<{
    id: number;
    name: string;
    children: number;
    holderCount: number;
    holders: T[];
  }> = [];
  for (const node of nodes) {
    if (liveIds != null && !liveIds.has(node.id)) continue;
    if (isLeaf(nodes, node.id, liveIds)) continue;
    const held = holders.get(node.id) ?? [];
    if (held.length === 0) continue;
    const children = nodes.filter((n) => n.parentId === node.id).length;
    out.push({
      id: node.id,
      name: node.name,
      children,
      holderCount: held.length,
      holders: held,
    });
  }
  return out.sort((a, b) => b.holderCount - a.holderCount);
}

/**
 * The supplier→category links that are REDUNDANT because the supplier is also
 * filed under a DESCENDANT of that same category.
 *
 * A supplier may not be filed under a grouping category (only a leaf). Where he
 * is BOTH on the parent and on a child, the parent link adds nothing: filtering
 * the tree already reaches him through the subtree, so dropping it loses no
 * information and stops him being counted twice.
 *
 * Deliberately returns ONLY the provable case. A supplier filed under the parent
 * ALONE is never returned — nobody knows which leaf his trade belongs to, and
 * guessing would file him under a trade he may not have.
 */
export function redundantParentLinks(
  nodes: CategoryNode[],
  links: Array<{ supplierId: number; categoryId: number }>,
): Array<{ supplierId: number; categoryId: number }> {
  const bySupplier = new Map<number, Set<number>>();
  for (const l of links) {
    const set = bySupplier.get(l.supplierId) ?? new Set<number>();
    set.add(l.categoryId);
    bySupplier.set(l.supplierId, set);
  }
  const subtreeOf = new Map<number, Set<number>>();
  const subtree = (id: number): Set<number> => {
    const cached = subtreeOf.get(id);
    if (cached) return cached;
    const s = descendantIds(nodes, id);
    subtreeOf.set(id, s);
    return s;
  };

  const out: Array<{ supplierId: number; categoryId: number }> = [];
  for (const l of links) {
    const own = bySupplier.get(l.supplierId);
    if (!own) continue;
    const sub = subtree(l.categoryId);
    // A descendant of the category (excluding the category itself) the supplier
    // is also filed under ⇒ the parent link is redundant.
    const coveredByChild = [...own].some((cid) => cid !== l.categoryId && sub.has(cid));
    if (coveredByChild) out.push(l);
  }
  return out;
}

/**
 * Supplier-category tree helpers.
 *
 * Categories form a tree of ANY depth: «قطع غيار» → «قطع غيار Dewalt», and
 * «كهرباء» → «كابلات متخصصة». The API returns a flat list with `parentId`;
 * these helpers order it depth-first so every picker renders the hierarchy
 * without re-implementing it.
 *
 * The previous version assumed a FIXED two-level tree (`depth: 0 | 1`): it
 * emitted a root and only its DIRECT children, so a grandchild such as
 * «قطع غيار Dewalt» was silently dropped from every picker and filter. The
 * depth is now unbounded and the type reflects it.
 */

export interface CategoryNode {
  id: number;
  name: string;
  parentId?: number | null;
}

export type OrderedCategory<T extends CategoryNode> = T & { depth: number };

/**
 * Order categories depth-first: a root, then its whole subtree, then the next
 * root. `depth` is the real depth (0 for a root) so a picker can indent any
 * number of levels. A child whose parent is missing from the list is shown as a
 * root rather than dropped, and input order is preserved among siblings.
 */
export function orderCategoryTree<T extends CategoryNode>(cats: T[]): OrderedCategory<T>[] {
  const ids = new Set(cats.map((c) => c.id));
  const childrenOf = new Map<number, T[]>();
  const roots: T[] = [];
  for (const c of cats) {
    if (c.parentId == null || !ids.has(c.parentId)) {
      roots.push(c);
      continue;
    }
    const list = childrenOf.get(c.parentId) ?? [];
    list.push(c);
    childrenOf.set(c.parentId, list);
  }

  const out: OrderedCategory<T>[] = [];
  const visited = new Set<number>();
  const walk = (node: T, depth: number) => {
    if (visited.has(node.id)) return; // defensive: a stray cycle cannot loop
    visited.add(node.id);
    out.push({ ...node, depth });
    for (const child of childrenOf.get(node.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // A node unreachable from any root must not vanish.
  for (const c of cats) if (!visited.has(c.id)) walk(c, 0);
  return out;
}

/**
 * The full path of a category as display names, e.g. `كهرباء / كابلات`. Returns
 * `[name]` for a root or an unresolvable parent. Used to disambiguate a leaf
 * whose name repeats in another branch.
 */
export function categoryPathLabel(cats: CategoryNode[], id: number): string {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const parts: string[] = [];
  let current = byId.get(id);
  const guard = new Set<number>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    parts.unshift(current.name);
    current = current.parentId != null ? byId.get(current.parentId) : undefined;
  }
  return parts.join(" / ");
}

/**
 * Ids of every LEAF — the categories a supplier may be filed under. A category
 * with children is a grouping only; filing a supplier under it would make him
 * count once for the parent AND once for each subtree filter.
 */
export function leafCategoryIds(cats: CategoryNode[]): Set<number> {
  const hasChild = new Set<number>();
  for (const c of cats) if (c.parentId != null) hasChild.add(c.parentId);
  const out = new Set<number>();
  for (const c of cats) if (!hasChild.has(c.id)) out.add(c.id);
  return out;
}

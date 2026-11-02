/**
 * Supplier-category tree helpers.
 *
 * Categories are a two-level tree: a general category (e.g. «كهرباء») can have
 * subcategories (e.g. «كابلات», «شنايدر»). The API returns a flat list with
 * `parentId`; these helpers order it so each parent is followed by its children,
 * which lets every picker render the hierarchy without re-implementing it.
 */

export interface CategoryNode {
  id: number;
  name: string;
  parentId?: number | null;
}

export type OrderedCategory<T extends CategoryNode> = T & { depth: 0 | 1 };

/**
 * Order categories as: root, its children (depth 1), next root, ...
 * Roots keep the input order (the API sorts by name). A child whose parent is
 * missing from the list is shown as a root so it is never silently dropped.
 */
export function orderCategoryTree<T extends CategoryNode>(cats: T[]): OrderedCategory<T>[] {
  const ids = new Set(cats.map((c) => c.id));
  const isRoot = (c: T) => !c.parentId || !ids.has(c.parentId);

  const out: OrderedCategory<T>[] = [];
  for (const root of cats.filter(isRoot)) {
    out.push({ ...root, depth: 0 });
    for (const child of cats.filter((c) => c.parentId === root.id)) {
      out.push({ ...child, depth: 1 });
    }
  }
  return out;
}

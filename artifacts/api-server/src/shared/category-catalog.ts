/**
 * Category catalogue reconciliation — تصنيفات البنود = تصنيفات الموردين
 *
 * The operator's rule: the «تصنيفات البنود» tab on `/items` must list EXACTLY the
 * categories that `/suppliers` lists — no more, no fewer. Historically the two
 * lists drifted because the mirror between them was one-directional and scoped:
 *
 *   • a supplier category with no canonical code was never mirrored in, so
 *     «مشروبات ومواد غذائية» / «كاوتش معدات ثقيلة» existed only on `/suppliers`;
 *   • a functional item category that no supplier category declared
 *     («أجهزة» / «قطع غيار» / «مقاومة حريق») existed only on the item side;
 *   • a merged alias («ELEC» → «كهرباء») kept its own active row and stayed
 *     offered as a trade category.
 *
 * The rule that makes the two lists comparable: a category is a TRADE category
 * when it is ACTIVE and its kind is `functional` (a legacy row with no kind
 * counts as functional). A `subcategory` refines a domain — it inherits its
 * domain's owner and is NOT a trade category — and a `brand` is metadata. Trade
 * categories are exactly what both screens show.
 *
 * This module is PURE: it computes the reconciliation PLAN from a snapshot. The
 * SQL that applies it lives in `init-db.ts`, and the projection below is what
 * the tests use to prove the plan actually yields two identical lists.
 */

/** The minimum a category must expose for the reconciliation to reason about it. */
export interface CatalogCategory {
  id: number;
  name: string;
  /** functional | subcategory | brand | null (legacy row) */
  kind: string | null;
  code: string | null;
  isActive: boolean;
}

export interface ReconcileInput {
  supplierCategories: Array<{ id: number; name: string; linkCount?: number }>;
  itemCategories: CatalogCategory[];
  /**
   * Specialisations DECLARED by the seed (`قواطع` is a `كهرباء` specialisation,
   * not a domain of its own). Passed in rather than hardcoded here so the seed
   * stays the single declaration and this module stays pure.
   */
  declaredSubcategories: Array<{ name: string; parent: string }>;
  /**
   * Alias spellings that must be folded into a canonical category
   * (`elec`/`electrical`/`electric` → «كهرباء», `اضاءة` → «إضاءة»).
   */
  declaredAliases: Array<{ alias: string; canonical: string }>;
  /**
   * Names the operator declared FUNCTIONAL even though the seed once listed them
   * as specialisations. «إضاءة» is one: 14 suppliers filter by it, so it must
   * appear on both screens as an independent trade category (decision «أ١»).
   */
  declaredFunctional: string[];
}

export interface ReconcilePlan {
  /** Names to INSERT into `supplier_categories`. */
  addToSupplier: string[];
  /** Names to INSERT into `item_categories` as functional trade domains. */
  addToItem: string[];
  /** Item-category names whose kind must become `functional` (parent cleared). */
  promoteToFunctional: string[];
  /** Item-category names that must become `subcategory` of `parent`. */
  demoteToSubcategory: Array<{ name: string; parent: string }>;
  /**
   * Supplier-category rows to DELETE: a declared specialisation that no supplier
   * actually links to. An earlier deploy mirrored every active functional item
   * category into `supplier_categories`, so `قواطع` was added there even though
   * it is a specialisation; leaving it makes `/suppliers` list one more category
   * than the item side. A row with even ONE supplier link is KEPT — it is a real
   * trade the operator uses.
   */
  dropFromSupplier: string[];
  /** Alias spellings folded into a canonical name; their own row is deactivated. */
  merges: Array<{ alias: string; canonical: string }>;
}

/** Normalised key so «إضاءة» and « اضاءة » are compared the same way. */
function key(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * True when a category is a TRADE category — the only kind that appears on both
 * `/suppliers` and the «تصنيفات البنود» tab. A subcategory refines a domain and a
 * brand is metadata; an inactive row is retired. A legacy row with no kind is
 * treated as functional, which preserves the pre-`kind` behaviour.
 */
export function isTradeCategory(cat: CatalogCategory): boolean {
  if (!cat.isActive) return false;
  const kind = cat.kind ?? "functional";
  return kind === "functional";
}

/**
 * Compute the reconciliation plan that makes the two category lists identical.
 *
 * Order matters: merges and promotions are resolved FIRST, because they decide
 * which names are trade categories at all; only then is a missing name added to
 * the other side. A name that is a merge target is never re-added, and a name
 * that is demoted to a specialisation is never added to `/suppliers`.
 */
export function reconcileCatalog(input: ReconcileInput): ReconcilePlan {
  const supplierByName = new Map(input.supplierCategories.map((s) => [key(s.name), s.name]));
  const itemByName = new Map(input.itemCategories.map((c) => [key(c.name), c]));
  const aliasKeys = new Set(input.declaredAliases.map((a) => key(a.alias)));
  const functionalKeys = new Set(input.declaredFunctional.map(key));

  // ── Merges ────────────────────────────────────────────────────────────────
  // An alias is folded only when BOTH sides exist as item categories; otherwise
  // there is nothing to move and the alias would be deactivated for no reason.
  const merges = input.declaredAliases
    .filter((a) => itemByName.has(key(a.alias)) && itemByName.has(key(a.canonical)))
    .map((a) => ({
      alias: itemByName.get(key(a.alias))!.name,
      canonical: itemByName.get(key(a.canonical))!.name,
    }));

  // ── Promotions ────────────────────────────────────────────────────────────
  // A name the operator declared functional AND that a supplier already filters
  // by must be a trade category on both sides. «إضاءة» was a subcategory while
  // 14 suppliers used it as a trade filter — the drift this fixes.
  const promoteToFunctional = input.declaredFunctional
    .filter((name) => supplierByName.has(key(name)) && itemByName.has(key(name)))
    .filter((name) => !isTradeCategory(itemByName.get(key(name))!))
    .map((name) => itemByName.get(key(name))!.name);

  // ── Specialisation rows that must leave the supplier catalogue ────────────
  // A declared specialisation has no business on `/suppliers`, and an earlier
  // deploy mirrored one there (`قواطع`). This runs BEFORE the demotion because
  // the demotion consults `supplierByName`: while the leaked row is still present
  // the demotion sees `قواطع` as supplier-declared and refuses to hide it — the
  // ordering bug found live. Only an UNUSED row is dropped; one supplier link
  // means the operator really filters by it and it must never vanish.
  const dropFromSupplier = input.declaredSubcategories
    .filter((d) => !functionalKeys.has(key(d.name)))
    .filter((d) => {
      const s = input.supplierCategories.find((x) => key(x.name) === key(d.name));
      return s != null && (s.linkCount ?? 0) === 0;
    })
    .map((d) => d.name);
  const droppedKeys = new Set(dropFromSupplier.map(key));
  // The supplier side as it will be AFTER the drop — what the demotion must see.
  const effectiveSupplierKeys = new Set(
    [...supplierByName.keys()].filter((k) => !droppedKeys.has(k)),
  );

  // ── Demotions ─────────────────────────────────────────────────────────────
  // A declared specialisation that NO supplier category declares is not a trade
  // category: it stays in the catalogue (its items keep their category and its
  // owner resolves to the domain) but is hidden from the trade lists.
  const demoteToSubcategory = input.declaredSubcategories
    .filter((d) => itemByName.has(key(d.name)) && !effectiveSupplierKeys.has(key(d.name)))
    .filter((d) => !functionalKeys.has(key(d.name)))
    .filter((d) => {
      const cat = itemByName.get(key(d.name))!;
      return cat.kind !== "subcategory";
    })
    .map((d) => ({ name: itemByName.get(key(d.name))!.name, parent: d.parent }));

  const demotedKeys = new Set(demoteToSubcategory.map((d) => key(d.name)));
  const mergedKeys = new Set(merges.map((m) => key(m.alias)));

  // ── Additions ─────────────────────────────────────────────────────────────
  // Every supplier category belongs in the item catalogue (mirror all — an
  // unused supplier category still shows on `/suppliers`, so skipping it is
  // exactly how the lists drifted). Junk spellings are prevented at CREATION
  // time, which is where they originate, not by leaving the lists inconsistent.
  // A specialisation row that is being dropped is excluded: it is about to leave
  // `/suppliers`, so mirroring it in would re-add the very name being removed.
  const addToItem = input.supplierCategories
    .filter((s) => !itemByName.has(key(s.name)))
    .filter((s) => !droppedKeys.has(key(s.name)))
    .map((s) => s.name);

  // Every trade item category belongs on `/suppliers`. A demoted specialisation
  // and a folded alias are excluded — neither is a trade category.
  const addToSupplier = input.itemCategories
    .filter(isTradeCategory)
    .filter((c) => !mergedKeys.has(key(c.name)))
    .filter((c) => !demotedKeys.has(key(c.name)))
    .filter((c) => !supplierByName.has(key(c.name)))
    .map((c) => c.name);

  return {
    addToSupplier: [...new Set(addToSupplier)],
    addToItem: [...new Set(addToItem)],
    promoteToFunctional: [...new Set(promoteToFunctional)],
    demoteToSubcategory,
    dropFromSupplier: [...new Set(dropFromSupplier)],
    merges,
  };
}

/**
 * Apply a plan to the snapshot IN MEMORY and return the two visible lists.
 *
 * This is the proof the plan works: `reconcileCatalog` produces a plan, this
 * projects the result, and the two lists must be equal. `init-db.ts` implements
 * the same plan in SQL, so the fields are named for a 1:1 translation.
 */
export function projectCatalog(
  input: ReconcileInput,
  plan: ReconcilePlan,
): { supplierNames: string[]; itemTradeNames: string[] } {
  const items = new Map(
    input.itemCategories.map((c) => [key(c.name), { ...c, parentId: null as number | null }]),
  );
  const suppliers = new Set(input.supplierCategories.map((s) => s.name));

  for (const m of plan.merges) {
    items.delete(key(m.alias));
    suppliers.delete(m.alias);
  }
  for (const name of plan.dropFromSupplier) suppliers.delete(name);
  for (const name of plan.promoteToFunctional) {
    const c = items.get(key(name));
    if (c) {
      c.kind = "functional";
      c.parentId = null;
      c.isActive = true;
    }
  }
  for (const d of plan.demoteToSubcategory) {
    const c = items.get(key(d.name));
    if (c) {
      c.kind = "subcategory";
      c.parentId = items.get(key(d.parent))?.id ?? null;
    }
  }
  for (const name of plan.addToItem) {
    items.set(key(name), {
      id: -1,
      name,
      kind: "functional",
      code: null,
      isActive: true,
      parentId: null,
    });
  }
  for (const name of plan.addToSupplier) suppliers.add(name);

  const itemTradeNames = [...items.values()].filter(isTradeCategory).map((c) => c.name);
  return {
    supplierNames: [...suppliers].sort(),
    itemTradeNames: [...itemTradeNames].sort(),
  };
}

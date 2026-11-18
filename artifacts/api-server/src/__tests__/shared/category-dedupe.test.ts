import { describe, it, expect } from "vitest";
import {
  categoryUniqueKey,
  categoryUniqueKeyWithParent,
  planCategoryDedupe,
  categoryDedupeSql,
  CATEGORY_REFERENCES,
  CATEGORY_UNIQUE_EXPR,
} from "../../shared/category-dedupe";

describe("categoryUniqueKey — the uniqueness rule that prevents duplicates", () => {
  it("folds a stray space, padding and case into ONE key", () => {
    // The live defect: a name is the UNIQUE key, so these were four rows.
    const variants = ["معدات فندقيه", "معدات  فندقيه", "  معدات فندقيه  ", "معدات\tفندقيه"];
    const keys = new Set(variants.map(categoryUniqueKey));
    expect(keys.size).toBe(1);
  });

  it("keeps genuinely different names distinct", () => {
    expect(categoryUniqueKey("معدات فندقيه")).not.toBe(categoryUniqueKey("معدات فندقيه اخرى"));
    expect(categoryUniqueKey("CABLE 50 MM")).not.toBe(categoryUniqueKey("CABLE 70 MM"));
  });

  it("matches the SQL expression the unique index enforces", () => {
    // The index is on `CATEGORY_UNIQUE_EXPR`; the TS key must agree, or a write
    // the app believes is unique would be rejected by the database.
    expect(CATEGORY_UNIQUE_EXPR).toBe("lower(btrim(regexp_replace(name, '\\s+', ' ', 'g')))");
  });
});

describe("planCategoryDedupe — keep the row the data points at", () => {
  it("keeps the referenced row and retires the empty spaced copy", () => {
    // The measured shape: the spaced copy has ZERO references, the canonical
    // row holds every item. Retiring the referenced one would destroy data.
    const plan = planCategoryDedupe([
      { id: 27, name: "معدات فندقيه", isActive: true, refCount: 20 },
      { id: 5218, name: "معدات  فندقيه", isActive: true, refCount: 0 },
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0].survivorId).toBe(27);
    expect(plan[0].loserIds).toEqual([5218]);
  });

  it("prefers an ACTIVE row over a RETIRED one, even when the retired row is referenced", () => {
    // Measured production shape (id 17 retired, 2338 active). Consolidating onto
    // a RETIRED row would make the whole trade vanish from `/suppliers` — the
    // opposite of the repair. This ordering was a real bug: the SQL used to
    // re-derive the survivor as `min(id)` and picked the retired row.
    const plan = planCategoryDedupe([
      { id: 17, name: "3m schotch", isActive: true, refCount: 3 },
      { id: 2338, name: "3m   schotch", isActive: true, refCount: 4 },
    ]);
    expect(plan[0].survivorId).toBe(2338);
    expect(plan[0].loserIds).toEqual([17]);

    const retiredFirst = planCategoryDedupe([
      { id: 2, name: "معدات فندقيه", isActive: false, refCount: 14 },
      { id: 2332, name: "معدات  فندقيه", isActive: true, refCount: 14 },
    ]);
    expect(retiredFirst[0].survivorId).toBe(2332);
  });

  it("prefers the referenced row, then the lowest id as a deterministic tie-break", () => {
    // The referenced row survives: the spaced copy created by the bug is always
    // the empty one, so keeping the referenced row loses nothing.
    const referenced = planCategoryDedupe([
      { id: 9, name: "3m schotch", isActive: true, refCount: 3 },
      { id: 4, name: "3m   schotch", isActive: true, refCount: 0 },
    ]);
    expect(referenced[0].survivorId).toBe(9);

    const tie = planCategoryDedupe([
      { id: 9, name: "3m schotch", isActive: true, refCount: 0 },
      { id: 4, name: "3m   schotch", isActive: true, refCount: 0 },
    ]);
    expect(tie[0].survivorId).toBe(4);
  });

  it("reports nothing for a catalogue with no duplicates", () => {
    const plan = planCategoryDedupe([
      { id: 1, name: "كهرباء" },
      { id: 2, name: "سباكة" },
      { id: 3, name: "3m schotch" },
    ]);
    expect(plan).toEqual([]);
  });

  it("handles a group of three and keeps only one", () => {
    const plan = planCategoryDedupe([
      { id: 1, name: "كابلات" },
      { id: 2, name: " كابلات " },
      { id: 3, name: "كابلات  ", refCount: 5 },
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0].survivorId).toBe(3);
    expect(plan[0].loserIds.sort()).toEqual([1, 2]);
  });
});

describe("categoryDedupeSql — generated from the tested plan", () => {
  const supplierPlan = planCategoryDedupe([
    { id: 2, name: "معدات فندقيه", isActive: false, refCount: 14 },
    { id: 2332, name: "معدات  فندقيه", isActive: true, refCount: 14 },
  ]);

  it("never re-derives the survivor — the SQL uses the plan's choice", () => {
    // The guard that matters: a second implementation of the ranking (`min(id)`)
    // silently consolidated every supplier link onto a RETIRED row. The SQL must
    // carry the plan's survivor and must not contain its own ranking expression.
    const sql = categoryDedupeSql(
      "supplier_categories",
      CATEGORY_REFERENCES.supplier,
      supplierPlan,
    );
    const joined = sql.join("\n");
    expect(joined).toContain("(2, 2332)"); // (loser, survivor) — the plan's choice
    expect(joined).not.toMatch(/min\(id\)/);
  });

  it("moves every reference the catalogue actually has", () => {
    // A relation forgotten here is a reference silently lost when its duplicate
    // is retired — the whole point of the repair.
    const sql = categoryDedupeSql("item_categories", CATEGORY_REFERENCES.item, supplierPlan, {
      parentColumn: true,
    }).join("\n");
    for (const [table, column] of CATEGORY_REFERENCES.item) {
      expect(sql).toMatch(new RegExp(`(UPDATE|DELETE FROM|INSERT INTO) ${table}\\b`));
      if (column === "suggested_category_id") expect(sql).toContain("suggested_category_id");
    }
  });

  it("retires the losers with a SOFT delete, never a hard one", () => {
    const joined = categoryDedupeSql(
      "supplier_categories",
      CATEGORY_REFERENCES.supplier,
      supplierPlan,
    ).join("\n");
    expect(joined).toContain("SET is_active = false, deleted_at = NOW()");
    expect(joined).not.toMatch(/DELETE FROM supplier_categories\b/);
  });

  it("copies a junction pair instead of updating it into a unique-index clash", () => {
    // Measured on a real Postgres: an UPDATE collides with a pair the survivor
    // already holds. Copy with ON CONFLICT, then delete the loser's rows.
    const joined = categoryDedupeSql(
      "item_categories",
      CATEGORY_REFERENCES.item,
      supplierPlan,
    ).join("\n");
    expect(joined).toContain("INSERT INTO employee_categories");
    expect(joined).toContain("ON CONFLICT DO NOTHING");
    expect(joined).toMatch(/DELETE FROM employee_categories r USING/);
  });

  it("normalises the surviving spelling and leaves the retired rows alone", () => {
    const joined = categoryDedupeSql(
      "item_categories",
      CATEGORY_REFERENCES.item,
      supplierPlan,
    ).join("\n");
    expect(joined).toContain("SET name = btrim(regexp_replace(name");
    expect(joined).toContain("AND id NOT IN (2)");
    // The guard that made the OLD repair a no-op must be gone: a duplicate is
    // resolved, never skipped because the collapsed name is taken.
    expect(joined).not.toContain("other.name = btrim");
  });

  it("emits NOTHING when there is no duplicate", () => {
    // Idempotence by construction: the second run plans an empty set and runs no
    // statement at all, so it cannot touch a row.
    const clean = planCategoryDedupe([
      { id: 1, name: "كهرباء", isActive: true },
      { id: 2, name: "سباكة", isActive: true },
    ]);
    expect(categoryDedupeSql("item_categories", CATEGORY_REFERENCES.item, clean)).toEqual([]);
  });

  it("emits one statement per reference so a sibling failure cannot roll it back", () => {
    const sql = categoryDedupeSql("item_categories", CATEGORY_REFERENCES.item, supplierPlan, {
      parentColumn: true,
    });
    expect(sql.length).toBeGreaterThanOrEqual(CATEGORY_REFERENCES.item.length + 3);
  });
});

describe("categoryUniqueKeyWithParent — uniqueness is scoped to the branch", () => {
  it("gives the SAME name under two parents two DIFFERENT keys", () => {
    const a = categoryUniqueKeyWithParent("يحتاج للمراجعة", 1);
    const b = categoryUniqueKeyWithParent("يحتاج للمراجعة", 3);
    expect(a).not.toBe(b);
  });

  it("gives the same name under the SAME parent one key, spelling-tolerant", () => {
    expect(categoryUniqueKeyWithParent("معدات  فندقيه", 1)).toBe(
      categoryUniqueKeyWithParent("معدات فندقيه", 1),
    );
  });

  it("treats a root category as parent 0, distinct from a child of id 0", () => {
    expect(categoryUniqueKeyWithParent("x", null)).toBe("root::x");
    expect(categoryUniqueKeyWithParent("x", 0)).toBe("0::x");
  });
});

describe("planCategoryDedupe — per-parent grouping", () => {
  it("does NOT group two same-named categories under DIFFERENT parents", () => {
    const plan = planCategoryDedupe([
      { id: 10, name: "يحتاج للمراجعة", parentId: 1 },
      { id: 11, name: "يحتاج للمراجعة", parentId: 3 },
    ]);
    expect(plan).toEqual([]);
  });

  it("DOES group two same-named categories under the SAME parent", () => {
    const plan = planCategoryDedupe([
      { id: 10, name: "يحتاج للمراجعة", parentId: 1 },
      { id: 11, name: "يحتاج للمراجعة ", parentId: 1 },
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0].loserIds).toEqual([11]);
  });
});

describe("categoryDedupeSql — a child collision keeps EXACTLY one row", () => {
  const plan = [{ key: "k", survivorId: 1, loserIds: [2] }];
  const sql = categoryDedupeSql("supplier_categories", [], plan, { parentColumn: true });

  it("retires the colliding child with a STRICT id test, not a symmetric one", () => {
    const retire = sql.find((s) => s.includes("EXISTS"));
    expect(retire).toBeTruthy();
    // `k.id < c.id` keeps one row; `k.id <> c.id` would retire BOTH, because
    // each row sees the other as the duplicate (measured on a real Postgres).
    expect(retire).toContain("k.id < c.id");
    expect(retire).not.toContain("k.id <> c.id");
  });

  it("scopes the collision test to the SAME parent", () => {
    const retire = sql.find((s) => s.includes("EXISTS"));
    expect(retire).toContain("k.parent_id = c.parent_id");
  });
});

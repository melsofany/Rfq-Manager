import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory stores the mock db mutates ────────────────────────────────────
const store = {
  categories: [] as { id: number; name: string }[],
  links: [] as { id: number; supplierId: number; categoryId: number }[],
  seq: { cat: 1, link: 1 },
};
function resetStore() {
  store.categories = [];
  store.links = [];
  store.seq = { cat: 1, link: 1 };
}

// drizzle-orm: eq/inArray record their operands so the mock can filter.
vi.mock("drizzle-orm", () => ({
  eq: (col: any, val: any) => ({ __eq: [col, val] }),
  inArray: (col: any, val: any) => ({ __in: [col, val] }),
}));

function applyCond(row: any, cond: any): boolean {
  if (!cond) return true;
  if (cond.__eq) return row[cond.__eq[0]] === cond.__eq[1];
  if (cond.__in) return cond.__in[1].includes(row[cond.__in[0]]);
  return true;
}

vi.mock("@workspace/db", () => {
  const supplierCategoriesTable = { _: "cat", id: "id", name: "name" };
  const supplierCategoryLinksTable = {
    _: "link",
    id: "id",
    supplierId: "supplierId",
    categoryId: "categoryId",
  };

  const db = {
    insert: (table: any) => ({
      values: (v: any) => ({
        onConflictDoNothing: () => {
          const rows = Array.isArray(v) ? v : [v];
          if (table._ === "cat") {
            for (const r of rows)
              if (!store.categories.some((c) => c.name === r.name))
                store.categories.push({ id: store.seq.cat++, name: r.name });
          } else if (table._ === "link") {
            for (const r of rows)
              if (
                !store.links.some(
                  (l) => l.supplierId === r.supplierId && l.categoryId === r.categoryId,
                )
              )
                store.links.push({
                  id: store.seq.link++,
                  supplierId: r.supplierId,
                  categoryId: r.categoryId,
                });
          }
          return Promise.resolve();
        },
      }),
    }),
    select: () => ({
      from: (table: any) => {
        let joinTable: any = null;
        const b: any = {
          innerJoin: (t2: any) => {
            joinTable = t2;
            return b;
          },
          where: (cond: any) => {
            let rows: any[] = [];
            if (table._ === "cat") {
              rows = store.categories.filter((c) => applyCond(c, cond));
            } else if (table._ === "link") {
              rows = store.links.filter((l) => applyCond(l, cond));
              if (joinTable && joinTable._ === "cat") {
                rows = rows
                  .map((l) => {
                    const c = store.categories.find((x) => x.id === l.categoryId);
                    return c ? { supplierId: l.supplierId, id: c.id, name: c.name } : null;
                  })
                  .filter(Boolean) as any[];
              }
            }
            return Promise.resolve(rows);
          },
        };
        return b;
      },
    }),
    delete: (table: any) => ({
      where: (cond: any) => {
        if (table._ === "link") store.links = store.links.filter((l) => !applyCond(l, cond));
        return Promise.resolve();
      },
    }),
  };

  return { db, supplierCategoriesTable, supplierCategoryLinksTable };
});

import {
  normalizeCategoryNames,
  saveSupplierCategoryLinks,
  loadSupplierCategoryMap,
} from "../../shared/supplier-category-links";

beforeEach(resetStore);

describe("supplier-category-links — the relationship is by id, not text", () => {
  it("creates the category rows a supplier names, then links them", async () => {
    const refs = await saveSupplierCategoryLinks(7, ["كهرباء", "قواطع"]);
    expect(refs.map((r) => r.name).sort()).toEqual(["قواطع", "كهرباء"].sort());
    expect(store.categories).toHaveLength(2);
    expect(store.links.filter((l) => l.supplierId === 7)).toHaveLength(2);
  });

  it("reconciles: re-saving a smaller set removes the dropped link", async () => {
    await saveSupplierCategoryLinks(7, ["كهرباء", "قواطع"]);
    await saveSupplierCategoryLinks(7, ["كهرباء"]);
    const map = await loadSupplierCategoryMap([7]);
    expect(map.get(7)!.map((c) => c.name)).toEqual(["كهرباء"]);
  });

  it("is idempotent — re-saving the same set changes nothing", async () => {
    await saveSupplierCategoryLinks(7, ["كهرباء"]);
    await saveSupplierCategoryLinks(7, ["كهرباء"]);
    expect(store.links.filter((l) => l.supplierId === 7)).toHaveLength(1);
  });

  it("normalises: trims, drops empties and de-duplicates case-insensitively", () => {
    expect(normalizeCategoryNames(["  كهرباء ", "كهرباء", "", "ELEC", "elec"])).toEqual([
      "كهرباء",
      "ELEC",
    ]);
  });

  it("reuses an existing category rather than creating a duplicate", async () => {
    store.categories.push({ id: 99, name: "كهرباء" });
    await saveSupplierCategoryLinks(7, ["كهرباء"]);
    expect(store.categories.filter((c) => c.name === "كهرباء")).toHaveLength(1);
    expect(store.links[0].categoryId).toBe(99);
  });

  it("loadSupplierCategoryMap batches several suppliers in one call", async () => {
    await saveSupplierCategoryLinks(1, ["كهرباء"]);
    await saveSupplierCategoryLinks(2, ["قواطع"]);
    const map = await loadSupplierCategoryMap([1, 2]);
    expect(map.get(1)!.map((c) => c.name)).toEqual(["كهرباء"]);
    expect(map.get(2)!.map((c) => c.name)).toEqual(["قواطع"]);
  });

  it("a supplier with no links is absent from the map (caller falls back to text)", async () => {
    const map = await loadSupplierCategoryMap([42]);
    expect(map.has(42)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  mergeItemCategoryEvidence,
  evidenceRank,
  hasAnyEvidence,
  type SupplierItemCategoryEvidence,
} from "../../shared/supplier-item-category-history";

const manual = (pairs: Array<[number, number, string]>) => {
  const m = new Map<number, Array<{ id: number; name: string }>>();
  for (const [supplierId, id, name] of pairs) {
    const arr = m.get(supplierId) ?? [];
    arr.push({ id, name });
    m.set(supplierId, arr);
  }
  return m;
};

const names = (list: SupplierItemCategoryEvidence[]) => list.map((c) => c.name).join(",");

describe("supplier item-category evidence — «المورد ده بيورّد إيه» from history", () => {
  it("learns a category from a QUOTED price alone", () => {
    const map = mergeItemCategoryEvidence(
      [{ supplierId: 5, categoryId: 3, name: "كهرباء" }],
      [],
      manual([]),
    );
    const cats = map.get(5)!;
    expect(cats).toHaveLength(1);
    expect(cats[0]).toMatchObject({ categoryId: 3, name: "كهرباء", quoted: true, ordered: false });
  });

  it("learns a category from an ISSUED purchase order alone", () => {
    const map = mergeItemCategoryEvidence(
      [],
      [{ supplierId: 5, categoryId: 405, name: "كابلات" }],
      manual([]),
    );
    expect(map.get(5)![0]).toMatchObject({ name: "كابلات", ordered: true, quoted: false });
  });

  it("merges quote + order + manual for the SAME pair into one row with all three flags", () => {
    const map = mergeItemCategoryEvidence(
      [{ supplierId: 5, categoryId: 3, name: "كهرباء" }],
      [{ supplierId: 5, categoryId: 3, name: "كهرباء" }],
      manual([[5, 3, "كهرباء"]]),
    );
    const cats = map.get(5)!;
    // One row, not three — the sources reinforce, they do not duplicate.
    expect(cats).toHaveLength(1);
    expect(cats[0]).toMatchObject({ quoted: true, ordered: true, manual: true });
  });

  it("keeps a MANUAL category that has no history at all", () => {
    const map = mergeItemCategoryEvidence([], [], manual([[5, 27, "معدات فندقيه"]]));
    expect(map.get(5)![0]).toMatchObject({ name: "معدات فندقيه", manual: true, quoted: false });
  });

  it("ranks an issued ORDER above a quote, and a quote above a manual tag", () => {
    const map = mergeItemCategoryEvidence(
      [{ supplierId: 5, categoryId: 1, name: "quoted-only" }],
      [{ supplierId: 5, categoryId: 2, name: "ordered" }],
      manual([[5, 3, "manual-only"]]),
    );
    expect(names(map.get(5)!)).toBe("ordered,quoted-only,manual-only");
  });

  it("ranks ordered > quoted even when the same row carries both flags", () => {
    const ordered: SupplierItemCategoryEvidence = {
      categoryId: 2,
      name: "b",
      quoted: true,
      ordered: true,
      manual: false,
    };
    const quotedOnly: SupplierItemCategoryEvidence = {
      categoryId: 1,
      name: "a",
      quoted: true,
      ordered: false,
      manual: false,
    };
    expect(evidenceRank(ordered)).toBeLessThan(evidenceRank(quotedOnly));
  });

  it("separates two suppliers — one supplier's history never leaks into another", () => {
    const map = mergeItemCategoryEvidence(
      [{ supplierId: 5, categoryId: 3, name: "كهرباء" }],
      [{ supplierId: 9, categoryId: 27, name: "معدات فندقيه" }],
      manual([]),
    );
    expect(map.get(5)!.map((c) => c.name)).toEqual(["كهرباء"]);
    expect(map.get(9)!.map((c) => c.name)).toEqual(["معدات فندقيه"]);
  });

  it("ignores a NULL category id (an unclassified line teaches nothing)", () => {
    const map = mergeItemCategoryEvidence(
      [{ supplierId: 5, categoryId: null, name: null }],
      [{ supplierId: 5, categoryId: null, name: null }],
      manual([]),
    );
    expect(map.get(5)).toBeUndefined();
  });

  it("returns no entry for a supplier with no evidence from any source", () => {
    const map = mergeItemCategoryEvidence([], [], manual([]));
    expect(map.size).toBe(0);
    expect(hasAnyEvidence(map.get(5) ?? [])).toBe(false);
  });

  it("keeps a category whose name is only known from history (manual has none)", () => {
    const map = mergeItemCategoryEvidence(
      [{ supplierId: 5, categoryId: 405, name: "كابلات" }],
      [],
      manual([]),
    );
    expect(map.get(5)![0].name).toBe("كابلات");
  });
});

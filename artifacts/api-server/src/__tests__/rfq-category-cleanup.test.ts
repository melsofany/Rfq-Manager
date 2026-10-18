import { describe, it, expect } from "vitest";
import { planReclassification, supplierCategorySets } from "../modules/rfq/category-cleanup";

const cats = [
  { id: 2, code: "spare", name: "قطع غيار", kind: "functional", parentId: null },
  { id: 3, code: "elec", name: "كهرباء", kind: "functional", parentId: null },
  { id: 5, code: "pumps", name: "مضخات", kind: "functional", parentId: null },
  { id: 6, code: "mech", name: "ميكانيكا", kind: "functional", parentId: null },
];
const vocab = { elec: ["breaker", "cable"], pumps: ["pump"] } as Record<string, string[]>;
const item = (id: number, description: string) => ({
  id,
  customerRfqId: 9,
  description,
  partNo: null,
  lineItem: null,
});

describe("supplierCategorySets", () => {
  it("maps supplier trade names to functional category ids, skipping the retired one", () => {
    const sets = supplierCategorySets(
      new Map([[1, [10, 11]]]),
      new Map([
        [10, ["كهرباء"]],
        [11, ["قطع غيار", "مضخات"]],
      ]),
      cats,
      2,
    );
    expect(sets.get(1)).toEqual([[3], [5]]);
  });
});

describe("planReclassification", () => {
  it("moves an item when every supplier that speaks for it agrees on one category", () => {
    const sets = new Map([[1, [[3], [3, 6]]]]);
    const [row] = planReclassification([item(1, "XYZ 123")], cats, vocab, 2, sets);
    expect(row.toCategoryId).toBe(3);
    expect(row.source).toBe("supplier");
  });

  it("leaves an item for review when the suppliers disagree", () => {
    const sets = new Map([[1, [[3], [5]]]]);
    const [row] = planReclassification([item(1, "WATER PUMP 1 HP")], cats, vocab, 2, sets);
    expect(row.toCategoryId).toBeNull();
    expect(row.source).toBe("review");
  });

  it("never moves an item on a keyword match alone, but suggests the keyword category", () => {
    const [row] = planReclassification(
      [item(1, "WATER PUMP 1 HP")],
      cats,
      vocab,
      2,
      new Map(),
    );
    expect(row.toCategoryId).toBeNull();
    expect(row.suggestedCategoryId).toBe(5);
  });

  it("never targets the retired category itself", () => {
    const [row] = planReclassification(
      [item(1, "spare parts for something")],
      cats,
      vocab,
      2,
      new Map([[1, [[2]]]]),
    );
    expect(row.toCategoryId).not.toBe(2);
    expect(row.suggestedCategoryId).not.toBe(2);
  });

  it("leaves an item with no supplier and no keyword evidence without any suggestion", () => {
    const [row] = planReclassification([item(1, "XYZ 123")], cats, vocab, 2, new Map());
    expect(row.toCategoryId).toBeNull();
    expect(row.suggestedCategoryId).toBeNull();
  });
});

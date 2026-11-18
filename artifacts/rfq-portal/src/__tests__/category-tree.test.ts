import { describe, it, expect } from "vitest";
import { orderCategoryTree, categoryPathLabel, leafCategoryIds } from "@/lib/category-tree";

const cats = [
  { id: 1, name: "كهرباء", parentId: null },
  { id: 2, name: "كابلات متخصصة", parentId: 1 },
  { id: 3, name: "قطع غيار", parentId: null },
  { id: 4, name: "قطع غيار Dewalt", parentId: 3 },
  { id: 5, name: "قطع غيار lowara", parentId: 3 },
  { id: 6, name: "بطاريات UPS", parentId: 1 },
  // a genuine THIRD level: قطع غيار → Dewalt → مقاسات
  { id: 8, name: "مقاسات Dewalt", parentId: 4 },
];

describe("orderCategoryTree", () => {
  it("keeps a GRANDCHILD (depth 2) — the old two-level version dropped it", () => {
    const ids = orderCategoryTree(cats).map((c) => c.id);
    expect(ids).toContain(4);
    expect(ids).toContain(5);
    expect(ids).toContain(8); // depth 2 — the old version dropped this one
  });

  it("reports the real depth for every level", () => {
    const by = new Map(orderCategoryTree(cats).map((c) => [c.id, c.depth]));
    expect(by.get(1)).toBe(0);
    expect(by.get(2)).toBe(1);
    expect(by.get(3)).toBe(0);
    expect(by.get(4)).toBe(1);
    expect(by.get(8)).toBe(2);
  });

  it("shows a subtree before the next root (depth-first)", () => {
    const ids = orderCategoryTree(cats).map((c) => c.id);
    expect(ids.indexOf(2)).toBeLessThan(ids.indexOf(3));
  });

  it("keeps a child whose parent is missing, as a root", () => {
    expect(orderCategoryTree([{ id: 9, name: "يتيم", parentId: 999 }]).map((c) => c.id)).toEqual([
      9,
    ]);
  });

  it("does not loop on a cycle", () => {
    const cyc = [
      { id: 1, name: "a", parentId: 2 },
      { id: 2, name: "b", parentId: 1 },
    ];
    expect(orderCategoryTree(cyc).length).toBeLessThanOrEqual(2);
  });
});

describe("categoryPathLabel", () => {
  it("joins the full path", () => {
    expect(categoryPathLabel(cats, 4)).toBe("قطع غيار / قطع غيار Dewalt");
    expect(categoryPathLabel(cats, 8)).toBe("قطع غيار / قطع غيار Dewalt / مقاسات Dewalt");
  });
  it("returns the bare name for a root", () => {
    expect(categoryPathLabel(cats, 1)).toBe("كهرباء");
  });
});

describe("leafCategoryIds", () => {
  it("excludes every category that has a child", () => {
    const leaves = leafCategoryIds(cats);
    expect(leaves.has(1)).toBe(false);
    expect(leaves.has(3)).toBe(false);
    expect(leaves.has(4)).toBe(false); // now has child 8
    expect(leaves.has(5)).toBe(true);
    expect(leaves.has(6)).toBe(true);
    expect(leaves.has(8)).toBe(true);
  });
});

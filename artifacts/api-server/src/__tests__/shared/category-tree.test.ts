import { describe, it, expect } from "vitest";
import {
  categoryKey,
  canonicalCategoryName,
  descendantIds,
  wouldCycle,
  flattenTree,
  categoryPath,
  type CategoryNode,
} from "../../shared/category-tree";

/**
 * The tree rules the whole catalogue depends on. Each guard reproduces a live
 * defect: a stray space that created a duplicate category, a parent filter that
 * missed a grandchild, and a re-parent that could close a loop.
 */
describe("categoryKey — the ONE comparison key", () => {
  it("folds doubled and stray whitespace so «معدات  فندقيه» == «معدات فندقيه»", () => {
    // The live catalogue held «معدات  فندقيه» (two spaces) beside the same name
    // with one space — two categories for one trade.
    expect(categoryKey("معدات  فندقيه")).toBe(categoryKey("معدات فندقيه"));
    expect(categoryKey("  مضخات مياه   ومعالجه مياة ")).toBe(
      categoryKey("مضخات مياه ومعالجه مياة"),
    );
  });

  it("folds Arabic spelling variants (hamza / taa marbuta / yaa)", () => {
    expect(categoryKey("إضاءة")).toBe(categoryKey("اضاءه"));
    expect(categoryKey("مقاومة")).toBe(categoryKey("مقاومه"));
  });

  it("folds Latin case and punctuation", () => {
    expect(categoryKey("ELEC")).toBe(categoryKey("elec"));
    expect(categoryKey("3M   Schotch")).toBe(categoryKey("3m schotch"));
  });

  it("keeps genuinely different names apart", () => {
    expect(categoryKey("كابلات")).not.toBe(categoryKey("كونتاكتورات"));
    expect(categoryKey("CABLE 50 MM")).not.toBe(categoryKey("CABLE 70 MM"));
  });

  it("returns an empty key for null/empty input", () => {
    expect(categoryKey(null)).toBe("");
    expect(categoryKey("   ")).toBe("");
  });
});

describe("canonicalCategoryName — the display form persisted on write", () => {
  it("trims and collapses whitespace runs to one space", () => {
    expect(canonicalCategoryName("  معدات   فندقيه  ")).toBe("معدات فندقيه");
  });
});

describe("descendantIds — the whole subtree, not just the direct children", () => {
  const nodes: CategoryNode[] = [
    { id: 1, name: "كهرباء", parentId: null },
    { id: 2, name: "Automation", parentId: 1 },
    { id: 3, name: "Encoders", parentId: 2 },
    { id: 4, name: "كابلات", parentId: 1 },
    { id: 5, name: "أجهزة", parentId: null },
  ];

  it("includes the node AND every node below it at any depth", () => {
    // The live defect: filtering on «كهرباء» missed «Encoders» (a grandchild).
    expect([...descendantIds(nodes, 1)].sort()).toEqual([1, 2, 3, 4]);
  });

  it("returns only the node itself for a leaf", () => {
    expect([...descendantIds(nodes, 3)]).toEqual([3]);
  });

  it("does not leak across trees", () => {
    expect([...descendantIds(nodes, 5)]).toEqual([5]);
  });

  it("cannot loop on a stray cycle", () => {
    const cyclic: CategoryNode[] = [
      { id: 1, name: "a", parentId: 2 },
      { id: 2, name: "b", parentId: 1 },
    ];
    expect([...descendantIds(cyclic, 1)].sort()).toEqual([1, 2]);
  });
});

describe("wouldCycle — a re-parent must not close a loop", () => {
  const nodes: CategoryNode[] = [
    { id: 1, name: "كهرباء", parentId: null },
    { id: 2, name: "Automation", parentId: 1 },
    { id: 3, name: "Encoders", parentId: 2 },
  ];

  it("refuses a node as its own parent", () => {
    expect(wouldCycle(nodes, 1, 1)).toBe(true);
  });

  it("refuses moving a node under one of its own descendants", () => {
    expect(wouldCycle(nodes, 1, 3)).toBe(true);
  });

  it("allows a genuine move to a different branch or to root", () => {
    expect(wouldCycle(nodes, 3, 1)).toBe(false);
    expect(wouldCycle(nodes, 2, null)).toBe(false);
  });
});

describe("flattenTree — depth-first order with a real depth", () => {
  it("emits a root then its whole subtree, with the correct depth", () => {
    const nodes: CategoryNode[] = [
      { id: 1, name: "كهرباء", parentId: null },
      { id: 2, name: "Automation", parentId: 1 },
      { id: 3, name: "Encoders", parentId: 2 },
      { id: 4, name: "أجهزة", parentId: null },
    ];
    expect(flattenTree(nodes).map((n) => [n.id, n.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 0],
    ]);
  });

  it("shows an orphan (missing parent) as a root instead of dropping it", () => {
    const nodes: CategoryNode[] = [{ id: 7, name: "x", parentId: 999 }];
    expect(flattenTree(nodes).map((n) => n.id)).toEqual([7]);
  });
});

describe("categoryPath — the full display path", () => {
  it("renders the whole ancestor chain", () => {
    const nodes: CategoryNode[] = [
      { id: 1, name: "كهرباء", parentId: null },
      { id: 2, name: "Automation", parentId: 1 },
      { id: 3, name: "Encoders", parentId: 2 },
    ];
    expect(categoryPath(nodes, 3)).toEqual(["كهرباء", "Automation", "Encoders"]);
  });

  it("returns just the name for a root", () => {
    const nodes: CategoryNode[] = [{ id: 1, name: "كهرباء", parentId: null }];
    expect(categoryPath(nodes, 1)).toEqual(["كهرباء"]);
  });
});

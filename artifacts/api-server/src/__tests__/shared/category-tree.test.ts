import { describe, it, expect } from "vitest";
import {
  categoryPath,
  descendantIds,
  flattenTree,
  isLeaf,
  leafCategoryIds,
  nonLeafHolders,
  redundantParentLinks,
} from "../../shared/category-tree";

/**
 * The live shape measured on production: three parents hold suppliers directly
 * (كهرباء 79, الصحة والسلامة ومقاومة الحريق 42, أدوات النظافة 6), and
 * «قطع غيار» has grandchildren. These fixtures mirror it.
 */
const nodes = [
  { id: 1, name: "كهرباء", parentId: null },
  { id: 13, name: "بطاريات UPS", parentId: 1 },
  { id: 14, name: "إضاءة", parentId: 1 },
  { id: 1311, name: "قطع غيار", parentId: null },
  { id: 29, name: "قطع غيار Dewalt", parentId: 1311 },
  { id: 433, name: "قطع غيار lowara", parentId: 1311 },
  { id: 3, name: "الصحة والسلامة", parentId: null },
  { id: 1312, name: "مقاومة حريق", parentId: 3 },
];

describe("isLeaf — the only kind a supplier may be filed under", () => {
  it("a parent with children is NOT a leaf", () => {
    expect(isLeaf(nodes, 1)).toBe(false);
    expect(isLeaf(nodes, 1311)).toBe(false);
  });

  it("a childless category IS a leaf", () => {
    expect(isLeaf(nodes, 13)).toBe(true);
    expect(isLeaf(nodes, 433)).toBe(true);
  });

  it("a RETIRED child does not make its parent unusable", () => {
    // 1312 is the only child of 3; retiring it must make 3 a leaf again,
    // otherwise a soft-deleted leaf permanently blocks filing under the parent.
    const liveIds = new Set([1, 13, 14, 1311, 29, 433, 3]);
    expect(isLeaf(nodes, 3)).toBe(false);
    expect(isLeaf(nodes, 3, liveIds)).toBe(true);
  });
});

describe("leafCategoryIds", () => {
  it("excludes every category that has a child", () => {
    const leaves = leafCategoryIds(nodes);
    expect([...leaves].sort((a, b) => a - b)).toEqual([13, 14, 29, 433, 1312]);
  });

  it("honours the live filter", () => {
    const leaves = leafCategoryIds(nodes, new Set([1, 13, 14, 1311, 29, 433, 3]));
    expect(leaves.has(3)).toBe(true);
  });
});

describe("nonLeafHolders — the review list, never applied", () => {
  it("reports only the non-leaf categories that actually hold something", () => {
    const holders = new Map([
      [
        1,
        [
          { id: 10, name: "أ" },
          { id: 11, name: "ب" },
        ],
      ],
      [13, [{ id: 12, name: "ج" }]], // a LEAF — not reported
    ]);
    const groups = nonLeafHolders(nodes, holders);
    expect(groups.map((g) => g.id)).toEqual([1]);
    expect(groups[0].holderCount).toBe(2);
    expect(groups[0].children).toBe(2);
    expect(groups[0].holders.map((h) => h.name)).toEqual(["أ", "ب"]);
  });

  it("sorts the busiest parent first", () => {
    const holders = new Map([
      [1, [{ id: 1, name: "x" }]],
      [
        1311,
        [
          { id: 2, name: "y" },
          { id: 3, name: "z" },
        ],
      ],
    ]);
    expect(nonLeafHolders(nodes, holders).map((g) => g.id)).toEqual([1311, 1]);
  });

  it("returns nothing when every holder is a leaf", () => {
    const holders = new Map([[13, [{ id: 1, name: "x" }]]]);
    expect(nonLeafHolders(nodes, holders)).toEqual([]);
  });
});

describe("existing tree helpers still hold", () => {
  it("descendantIds walks the whole subtree", () => {
    expect([...descendantIds(nodes, 1311)].sort((a, b) => a - b)).toEqual([29, 433, 1311]);
  });
  it("categoryPath resolves the full chain", () => {
    expect(categoryPath(nodes, 29)).toEqual(["قطع غيار", "قطع غيار Dewalt"]);
  });
  it("flattenTree keeps a grandchild", () => {
    const flat = flattenTree(nodes);
    expect(flat.find((n) => n.id === 29)?.depth).toBe(1);
  });
});

describe("redundantParentLinks — only the provable case", () => {
  it("flags a parent link when the supplier is ALSO on a child", () => {
    const links = [
      { supplierId: 1, categoryId: 1 }, // كهرباء (parent)
      { supplierId: 1, categoryId: 13 }, // بطاريات UPS (child)
    ];
    expect(redundantParentLinks(nodes, links)).toEqual([{ supplierId: 1, categoryId: 1 }]);
  });

  it("flags a GRANDchild too — any descendant makes the parent link redundant", () => {
    const links = [
      { supplierId: 2, categoryId: 1311 }, // قطع غيار
      { supplierId: 2, categoryId: 29 }, // قطع غيار Dewalt (child)
    ];
    expect(redundantParentLinks(nodes, links)).toEqual([{ supplierId: 2, categoryId: 1311 }]);
  });

  it("does NOT flag a supplier who is on the parent ALONE (nobody knows his leaf)", () => {
    const links = [{ supplierId: 3, categoryId: 1 }];
    expect(redundantParentLinks(nodes, links)).toEqual([]);
  });

  it("does NOT flag a leaf link — a leaf has no descendants", () => {
    const links = [{ supplierId: 4, categoryId: 13 }];
    expect(redundantParentLinks(nodes, links)).toEqual([]);
  });

  it("flags only the parent of an unrelated pair, leaving both leaves alone", () => {
    const links = [
      { supplierId: 5, categoryId: 1 },
      { supplierId: 5, categoryId: 13 },
      { supplierId: 5, categoryId: 1311 },
      { supplierId: 5, categoryId: 29 },
    ];
    expect(redundantParentLinks(nodes, links)).toEqual([
      { supplierId: 5, categoryId: 1 },
      { supplierId: 5, categoryId: 1311 },
    ]);
  });

  it("returns nothing when every link is a leaf", () => {
    expect(
      redundantParentLinks(nodes, [
        { supplierId: 6, categoryId: 13 },
        { supplierId: 6, categoryId: 14 },
      ]),
    ).toEqual([]);
  });
});

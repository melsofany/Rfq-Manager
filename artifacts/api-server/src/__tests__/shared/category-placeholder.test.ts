import { describe, it, expect } from "vitest";
import {
  REVIEW_PLACEHOLDER_NAME,
  emptyReviewPlaceholderIds,
  isReviewPlaceholder,
} from "../../shared/category-placeholder";

const nodes = [
  { id: 1, name: "كهرباء", parentId: null },
  { id: 2, name: REVIEW_PLACEHOLDER_NAME, parentId: 1 },
  { id: 3, name: "الصحة والسلامة", parentId: null },
  { id: 4, name: REVIEW_PLACEHOLDER_NAME, parentId: 3 },
  { id: 5, name: "شنايدر", parentId: 1 },
];

describe("isReviewPlaceholder — spelling-tolerant", () => {
  it("recognises the exact name and its Arabic spelling variants", () => {
    expect(isReviewPlaceholder("يحتاج للمراجعة")).toBe(true);
    expect(isReviewPlaceholder("يحتاج  للمراجعه")).toBe(true);
    expect(isReviewPlaceholder(" شنايدر ")).toBe(false);
  });
});

describe("emptyReviewPlaceholderIds — the auto-delete rule", () => {
  it("returns a placeholder that holds NO supplier", () => {
    expect(emptyReviewPlaceholderIds(nodes, []).sort()).toEqual([2, 4]);
  });

  it("keeps a placeholder that still holds a supplier", () => {
    const links = [{ supplierId: 10, categoryId: 2 }];
    expect(emptyReviewPlaceholderIds(nodes, links)).toEqual([4]);
  });

  it("never returns a real category, even an empty one", () => {
    // 5 «شنايدر» is empty but is NOT a placeholder — it must survive.
    expect(emptyReviewPlaceholderIds(nodes, []).includes(5)).toBe(false);
  });

  it("returns nothing when every placeholder still holds suppliers", () => {
    const links = [
      { supplierId: 10, categoryId: 2 },
      { supplierId: 11, categoryId: 4 },
    ];
    expect(emptyReviewPlaceholderIds(nodes, links)).toEqual([]);
  });
});

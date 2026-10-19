import { describe, it, expect } from "vitest";
import { buildReviewGroups, reviewGroupKey } from "../modules/rfq/review-groups";

describe("reviewGroupKey", () => {
  it("treats the same text with different spacing and case as one group", () => {
    expect(reviewGroupKey("P/N 1", "FREON  22 25 LB")).toBe(
      reviewGroupKey("p/n 1", "freon 22 25 lb"),
    );
  });
});

describe("buildReviewGroups", () => {
  const names = new Map([
    [3, "كهرباء"],
    [5, "أجهزة"],
  ]);
  it("groups identical texts, biggest first, with the most common suggestion", () => {
    const groups = buildReviewGroups(
      [
        { id: 1, partNo: null, description: "FREON 22", suggestedCategoryId: 5 },
        { id: 2, partNo: null, description: "freon 22", suggestedCategoryId: 5 },
        { id: 3, partNo: null, description: "freon 22", suggestedCategoryId: null },
        { id: 4, partNo: "X1", description: "BREAKER", suggestedCategoryId: 3 },
      ],
      names,
    );
    expect(groups[0].count).toBe(3);
    expect(groups[0].itemIds).toEqual([1, 2, 3]);
    expect(groups[0].suggestedCategoryId).toBe(5);
    expect(groups[0].suggestedName).toBe("أجهزة");
    expect(groups[1].count).toBe(1);
  });

  it("leaves a group without any suggestion when no item carries one", () => {
    const [g] = buildReviewGroups(
      [{ id: 9, partNo: null, description: "GASKET", suggestedCategoryId: null }],
      names,
    );
    expect(g.suggestedCategoryId).toBeNull();
    expect(g.suggestedName).toBeNull();
  });
});

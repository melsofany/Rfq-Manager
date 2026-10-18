import { describe, it, expect } from "vitest";
import { planReclassification } from "../modules/rfq/category-cleanup";

const cats = [
  { id: 2, code: "spare", name: "قطع غيار", kind: "functional", parentId: null },
  { id: 3, code: "elec", name: "كهرباء", kind: "functional", parentId: null },
  { id: 5, code: "pumps", name: "مضخات", kind: "functional", parentId: null },
];
const vocab = { elec: ["breaker", "cable"], pumps: ["pump"] } as Record<string, string[]>;

describe("planReclassification", () => {
  it("never targets the retired category itself", () => {
    const rows = planReclassification(
      [
        {
          id: 1,
          customerRfqId: 9,
          description: "spare parts for something",
          partNo: null,
          lineItem: null,
        },
      ],
      cats,
      vocab,
      2,
    );
    expect(rows[0].toCategoryId).not.toBe(2);
  });

  it("moves a clearly matching item to its category", () => {
    const rows = planReclassification(
      [{ id: 1, customerRfqId: 9, description: "WATER PUMP 1 HP", partNo: null, lineItem: null }],
      cats,
      vocab,
      2,
    );
    expect(rows[0].toCategoryId).toBe(5);
    expect(rows[0].toName).toBe("مضخات");
  });

  it("leaves an item with no confident match unclassified", () => {
    const rows = planReclassification(
      [{ id: 1, customerRfqId: null, description: "XYZ 123", partNo: null, lineItem: null }],
      cats,
      vocab,
      2,
    );
    expect(rows[0].toCategoryId).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  consolidatePickupLines,
  groupKeyFor,
  customerPoNosOf,
  hasOutstandingQty,
  supplierPoCount,
  type PickupLine,
} from "../../modules/field-ops/consolidation";

function line(over: Partial<PickupLine> = {}): PickupLine {
  return {
    poItemId: 1,
    poId: 1,
    poNo: "SPO-001",
    supplierId: 1,
    itemId: null,
    lineItem: null,
    partNo: null,
    description: "كونتاكتور شنايدر LC1D32M7",
    uom: "قطعة",
    qty: 2,
    acceptedQty: 0,
    remainingQty: 2,
    lineStatus: "pending",
    customerPoNos: ["P26E001"],
    customerPoItemIds: [11],
    ...over,
  };
}

describe("groupKeyFor", () => {
  it("groups by Item ID first", () => {
    const r = groupKeyFor(line({ itemId: "IT-77", partNo: "PN-1" }));
    expect(r.basis).toBe("itemId");
    expect(r.key).toBe("item:IT-77");
  });

  it("falls back to Part Number when there is no Item ID", () => {
    const r = groupKeyFor(line({ partNo: "LC1D32M7" }));
    expect(r.basis).toBe("partNo");
  });

  it("falls back to the description signature when there is no code", () => {
    const r = groupKeyFor(line({ description: "CABLE 3X2.5 MM COPPER FLEXIBLE" }));
    expect(r.basis).toBe("description");
  });

  it("gives an identity-less line its own unique key", () => {
    const r = groupKeyFor(line({ description: "قطعة" }));
    expect(r.basis).toBe("unique");
    expect(r.key).toBe("poitem:1");
  });
});

describe("consolidatePickupLines", () => {
  it("consolidates the same part number across three supplier POs (the required example)", () => {
    const groups = consolidatePickupLines([
      line({
        poItemId: 1,
        poId: 1,
        poNo: "SPO-001",
        partNo: "LC1D32M7",
        qty: 2,
        remainingQty: 2,
        customerPoNos: ["P26E001"],
      }),
      line({
        poItemId: 2,
        poId: 5,
        poNo: "SPO-005",
        partNo: "LC1D32M7",
        qty: 3,
        remainingQty: 3,
        customerPoNos: ["P26E014"],
      }),
      line({
        poItemId: 3,
        poId: 9,
        poNo: "SPO-009",
        partNo: "LC1D32M7",
        qty: 1,
        remainingQty: 1,
        customerPoNos: ["P26E021"],
      }),
    ]);

    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.totalRequiredQty).toBe(6);
    expect(g.totalRemainingQty).toBe(6);
    expect(supplierPoCount(g)).toBe(3);
    expect(customerPoNosOf(g)).toEqual(["P26E001", "P26E014", "P26E021"]);
    // Traceability preserved: every original PO line survives with its own qty.
    expect(g.allocations.map((a) => [a.poNo, a.qty])).toEqual([
      ["SPO-001", 2],
      ["SPO-005", 3],
      ["SPO-009", 1],
    ]);
  });

  it("does not merge two different part numbers", () => {
    const groups = consolidatePickupLines([
      line({ poItemId: 1, partNo: "LC1D32M7" }),
      line({ poItemId: 2, partNo: "LC1D40M7", poNo: "SPO-002" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("does not merge items that merely read alike but carry no identity", () => {
    const groups = consolidatePickupLines([
      line({ poItemId: 1, description: "قطعة", poNo: "SPO-001" }),
      line({ poItemId: 2, description: "قطعة", poNo: "SPO-002" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("sums accepted and remaining across the group", () => {
    const groups = consolidatePickupLines([
      line({ poItemId: 1, partNo: "X1", qty: 5, acceptedQty: 5, remainingQty: 0 }),
      line({ poItemId: 2, partNo: "X1", poNo: "SPO-002", qty: 4, acceptedQty: 1, remainingQty: 3 }),
    ]);
    expect(groups[0].totalRequiredQty).toBe(9);
    expect(groups[0].totalAcceptedQty).toBe(6);
    expect(groups[0].totalRemainingQty).toBe(3);
  });

  it("keeps decimals free of float dust", () => {
    const groups = consolidatePickupLines([
      line({ poItemId: 1, partNo: "X1", qty: 0.1, remainingQty: 0.1 }),
      line({ poItemId: 2, partNo: "X1", qty: 0.2, remainingQty: 0.2 }),
    ]);
    expect(groups[0].totalRequiredQty).toBe(0.3);
  });

  it("returns an empty list for no lines", () => {
    expect(consolidatePickupLines([])).toEqual([]);
  });
});

/**
 * The rule that decides both whether a task stays on the mobile list and
 * whether a receipt closes it or leaves it partially received. One function so
 * the two can never drift apart — the reported defect was a task that had been
 * fully received yet still showed as outstanding.
 */
describe("hasOutstandingQty", () => {
  it("is true while accepted is below ordered", () => {
    expect(hasOutstandingQty(6, 4)).toBe(true);
    expect(hasOutstandingQty(6, 0)).toBe(true);
  });

  it("is false once accepted reaches ordered", () => {
    expect(hasOutstandingQty(6, 6)).toBe(false);
    expect(hasOutstandingQty(6, 7)).toBe(false);
  });

  it("tolerates float dust so a full receipt is not seen as short", () => {
    // 0.1 + 0.2 stored as decimals can land a hair below the ordered value.
    expect(hasOutstandingQty(0.3, 0.1 + 0.2)).toBe(false);
  });

  it("treats a line with no ordered quantity as complete", () => {
    expect(hasOutstandingQty(null, 0)).toBe(false);
  });
});

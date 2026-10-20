/**
 * Pure rules for linking supplier PO lines to RFQ lines and for quantities.
 * These pin the agreed behaviour: exact keys link automatically, descriptions
 * only suggest, units must agree, and quantity problems warn without blocking.
 */
import { describe, it, expect } from "vitest";
import {
  matchRfqItem,
  computeQuantityBreakdown,
  isActivePoLine,
  normKey,
  type RfqItemForLink,
  type PoLineForLink,
} from "../../shared/rfq-links";

const base = (over: Partial<RfqItemForLink> = {}): RfqItemForLink => ({
  id: 1,
  itemId: null,
  lineItem: null,
  partNo: null,
  description: "Silver solder rod",
  uom: "pcs",
  qty: 10,
  remainingQty: 10,
  ...over,
});

const line = (over: Partial<PoLineForLink> = {}): PoLineForLink => ({
  itemId: null,
  lineItem: null,
  partNo: null,
  description: "Silver solder rod",
  uom: "pcs",
  qty: 5,
  ...over,
});

describe("normKey", () => {
  it("trims, lowercases and collapses whitespace", () => {
    expect(normKey("  5730.021  GENRAL ")).toBe("5730.021 genral");
    expect(normKey(null)).toBe("");
  });
});

describe("matchRfqItem: automatic links", () => {
  it("links automatically on an exact line_item with matching unit", () => {
    const r = matchRfqItem(line({ lineItem: "A-1" }), [base({ id: 7, lineItem: " a-1 " })]);
    expect(r.status).toBe("auto");
    expect(r.rfqItemId).toBe(7);
    expect(r.basis).toBe("lineItem");
    expect(r.warnings).toEqual([]);
  });

  it("falls back to part_no when line_item is absent", () => {
    const r = matchRfqItem(line({ partNo: "440F" }), [base({ id: 3, partNo: "440f" })]);
    expect(r.status).toBe("auto");
    expect(r.basis).toBe("partNo");
  });

  it("treats a missing unit on one side as compatible", () => {
    const r = matchRfqItem(line({ lineItem: "X", uom: null }), [
      base({ id: 2, lineItem: "X", uom: "kg" }),
    ]);
    expect(r.status).toBe("auto");
  });
});

describe("matchRfqItem: never link on text similarity alone", () => {
  it("a description-only match is a suggestion, not a link", () => {
    const r = matchRfqItem(line(), [base({ id: 9 })]);
    expect(r.status).toBe("suggested");
    expect(r.rfqItemId).toBeNull();
    expect(r.basis).toBe("description");
    expect(r.candidates[0].rfqItemId).toBe(9);
  });

  it("a different line_item does not fall back to description", () => {
    const r = matchRfqItem(line({ lineItem: "B-2" }), [base({ lineItem: "A-1" })]);
    expect(r.status).toBe("none");
    expect(r.warnings).toContain("no_match");
  });

  it("several equal matches are ambiguous and need confirmation", () => {
    const r = matchRfqItem(line({ lineItem: "A-1" }), [
      base({ id: 1, lineItem: "A-1" }),
      base({ id: 2, lineItem: "A-1" }),
    ]);
    expect(r.status).toBe("suggested");
    expect(r.rfqItemId).toBeNull();
    expect(r.warnings).toContain("ambiguous");
    expect(r.candidates).toHaveLength(2);
  });
});

describe("matchRfqItem: units and quantities", () => {
  it("a unit mismatch turns an exact key match into a suggestion", () => {
    const r = matchRfqItem(line({ lineItem: "A-1", uom: "kg" }), [
      base({ lineItem: "A-1", uom: "pcs" }),
    ]);
    expect(r.status).toBe("suggested");
    expect(r.warnings).toContain("uom_mismatch");
    expect(r.candidates[0].uomMatch).toBe(false);
  });

  it("quantity above the remaining RFQ quantity warns but still links", () => {
    const r = matchRfqItem(line({ lineItem: "A-1", qty: 20 }), [
      base({ lineItem: "A-1", remainingQty: 8 }),
    ]);
    expect(r.status).toBe("auto");
    expect(r.warnings).toContain("qty_exceeds_remaining");
  });
});

describe("isActivePoLine", () => {
  it("cancelled PO or cancelled line does not count", () => {
    expect(isActivePoLine({ status: "cancelled" }, { lineStatus: "pending" })).toBe(false);
    expect(isActivePoLine({ status: "draft" }, { lineStatus: "cancelled" })).toBe(false);
    expect(isActivePoLine({ status: "sent" }, { lineStatus: "pending" })).toBe(true);
  });
});

describe("computeQuantityBreakdown", () => {
  it("splits one customer line across batches and suppliers", () => {
    const b = computeQuantityBreakdown({
      requestedQty: 100,
      allocations: [
        { qty: 40, active: true },
        { qty: 35, active: true },
      ],
      receivedQty: 40,
      deliveredQty: 0,
    });
    expect(b.purchased).toBe(75);
    expect(b.remainingToPurchase).toBe(25);
    expect(b.received).toBe(40);
    expect(b.warnings).toEqual(["under_purchased"]);
  });

  it("cancelled allocations free their quantity", () => {
    const b = computeQuantityBreakdown({
      requestedQty: 50,
      allocations: [
        { qty: 30, active: false },
        { qty: 50, active: true },
      ],
    });
    expect(b.purchased).toBe(50);
    expect(b.remainingToPurchase).toBe(0);
    expect(b.warnings).toEqual([]);
  });

  it("buying more than requested warns over_purchased", () => {
    const b = computeQuantityBreakdown({
      requestedQty: 10,
      allocations: [{ qty: 12, active: true }],
    });
    expect(b.remainingToPurchase).toBe(-2);
    expect(b.warnings).toContain("over_purchased");
  });
});

import { describe, it, expect } from "vitest";
import {
  normalizeRfqNumber,
  isOpenRfqStatus,
  isClosedRfqStatus,
  rankExistingRfqs,
  pickExistingRfq,
  isWithinCloseDate,
  reuseUpdate,
  itemKey,
  newItemsOnly,
  planReuseItems,
} from "../../shared/rfq-identity";

describe("normalizeRfqNumber", () => {
  it("folds the cosmetic variants that hide real duplicates", () => {
    // Measured on production: 5 rows differ by padding, 18 by letter case.
    // Comparing raw strings would miss exactly the duplicates this prevents.
    expect(normalizeRfqNumber(" Almaza0005 ")).toBe("almaza0005");
    expect(normalizeRfqNumber("Almaza0005")).toBe("almaza0005");
    expect(normalizeRfqNumber(" Mohamed Alaa Soliman")).toBe(
      normalizeRfqNumber("Mohamed Alaa Soliman"),
    );
    expect(normalizeRfqNumber("26R007225")).toBe(normalizeRfqNumber("26r007225"));
  });

  it("collapses inner whitespace without joining words", () => {
    // Collapsing, not removing: an inner space is part of the number as the
    // customer wrote it, and joining could merge two different names.
    expect(normalizeRfqNumber("AB   CD")).toBe("ab cd");
    expect(normalizeRfqNumber("ABCD")).not.toBe(normalizeRfqNumber("AB CD"));
  });

  it("returns an empty string for null and undefined", () => {
    expect(normalizeRfqNumber(null)).toBe("");
    expect(normalizeRfqNumber(undefined)).toBe("");
  });
});

describe("status classification", () => {
  it("treats DRAFT/SENT/QUOTED as open and terminal states as closed", () => {
    expect(isOpenRfqStatus("DRAFT")).toBe(true);
    expect(isOpenRfqStatus("sent")).toBe(true);
    expect(isOpenRfqStatus("QUOTED")).toBe(true);
    expect(isOpenRfqStatus("FAILED")).toBe(false);
    expect(isClosedRfqStatus("FAILED")).toBe(true);
    expect(isClosedRfqStatus("SUCCESS")).toBe(true);
    expect(isClosedRfqStatus("QUOTED")).toBe(false);
  });
});

describe("rankExistingRfqs / pickExistingRfq", () => {
  it("prefers an open RFQ over a terminal one", () => {
    // Continuing a FAILED row would resurrect a request the expiry sweep
    // already closed, while a sibling is still live.
    const failed = { id: 1, customerRfqNo: "X", status: "FAILED", itemCount: 9 };
    const quoted = { id: 2, customerRfqNo: "X", status: "QUOTED", itemCount: 3 };
    expect(pickExistingRfq([failed, quoted])?.id).toBe(2);
  });

  it("prefers the row carrying more items among equal status", () => {
    const few = { id: 1, customerRfqNo: "X", status: "SENT", itemCount: 2 };
    const many = { id: 2, customerRfqNo: "X", status: "SENT", itemCount: 7 };
    expect(pickExistingRfq([few, many])?.id).toBe(2);
  });

  it("prefers the row that already holds the OFFERS over a newer sibling", () => {
    // Measured production case 26R007225: rows 121 (2 offers) and 142 (1
    // offer), both QUOTED with 3 items. Picking the newer 142 would move the
    // new send away from the row holding most of the comparison — the very
    // scatter this fix exists to stop.
    const holder = {
      id: 121,
      customerRfqNo: "26R007225",
      status: "QUOTED",
      itemCount: 3,
      offerCount: 2,
      createdAt: "2026-06-01",
    };
    const newer = {
      id: 142,
      customerRfqNo: "26R007225",
      status: "QUOTED",
      itemCount: 3,
      offerCount: 1,
      createdAt: "2026-07-01",
    };
    expect(pickExistingRfq([holder, newer])?.id).toBe(121);
    expect(pickExistingRfq([newer, holder])?.id).toBe(121);
  });

  it("breaks ties on the newest row, deterministically", () => {
    const older = {
      id: 5,
      customerRfqNo: "X",
      status: "SENT",
      itemCount: 3,
      createdAt: "2026-01-01",
    };
    const newer = {
      id: 9,
      customerRfqNo: "X",
      status: "SENT",
      itemCount: 3,
      createdAt: "2026-06-01",
    };
    expect(pickExistingRfq([older, newer])?.id).toBe(9);
    // Input order must not change the answer.
    expect(pickExistingRfq([newer, older])?.id).toBe(9);
  });

  it("returns null when there is nothing to reuse", () => {
    expect(pickExistingRfq([])).toBeNull();
  });
});

describe("isWithinCloseDate", () => {
  it("treats a missing close date as not expired", () => {
    // An RFQ with no deadline must not look lapsed, or every reuse would be
    // mistaken for a new request.
    expect(isWithinCloseDate({ expiresAt: null })).toBe(true);
    expect(isWithinCloseDate({})).toBe(true);
  });

  it("compares against the supplied clock", () => {
    const past = { expiresAt: "2026-01-01T00:00:00Z" };
    const future = { expiresAt: "2026-12-01T00:00:00Z" };
    const now = new Date("2026-06-01T00:00:00Z");
    expect(isWithinCloseDate(past, now)).toBe(false);
    expect(isWithinCloseDate(future, now)).toBe(true);
  });
});

describe("reuseUpdate", () => {
  it("extends a lapsed closing date — the operator's exact case", () => {
    // The old request's date has passed and they want a LONGER window.
    const patch = reuseUpdate(
      { id: 1, customerRfqNo: "X", status: "FAILED", expiresAt: "2026-06-04T00:00:00Z" },
      { expiresAt: "2026-12-31T23:59:59Z" },
    );
    expect(patch.expiresAt?.toISOString()).toBe("2026-12-31T23:59:59.000Z");
    expect(patch.status).toBe("SENT");
  });

  it("never SHORTENS a live closing date", () => {
    // Shortening would cut a request the operator did not ask to cut.
    const patch = reuseUpdate(
      { id: 1, customerRfqNo: "X", status: "SENT", expiresAt: "2026-12-31T00:00:00Z" },
      { expiresAt: "2026-06-01T00:00:00Z" },
    );
    expect(patch.expiresAt).toBeUndefined();
  });

  it("leaves an open status alone and revives a terminal one", () => {
    expect(reuseUpdate({ id: 1, customerRfqNo: "X", status: "QUOTED" }, {}).status).toBeUndefined();
    expect(reuseUpdate({ id: 1, customerRfqNo: "X", status: "SUCCESS" }, {}).status).toBe("SENT");
  });
});

describe("itemKey / newItemsOnly", () => {
  it("identifies an item by part number, then line item, then description", () => {
    expect(itemKey({ partNo: "CB 640A" })).toBe("p:cb640a");
    expect(itemKey({ lineItem: "5720.011" })).toBe("l:5720.011");
    expect(itemKey({ description: "CIRCUIT BREAKER" })).toBe("d:circuitbreaker");
    expect(itemKey({})).toBeNull();
  });

  it("adds only the lines the existing RFQ does not already carry", () => {
    // A re-send is usually the SAME items; appending blindly would duplicate
    // every line and double every quantity in the analysis.
    const existing = [{ partNo: "CB640A" }, { lineItem: "L1" }];
    const incoming = [
      { partNo: "CB640A" }, // duplicate — dropped
      { lineItem: "L1" }, // duplicate — dropped
      { partNo: "NEW-1" }, // new — kept
      { partNo: "NEW-2" }, // new — kept
    ];
    const added = newItemsOnly(existing, incoming);
    expect(added.map((a) => a.partNo ?? a.lineItem)).toEqual(["NEW-1", "NEW-2"]);
  });

  it("skips a row with no identity instead of guessing", () => {
    const added = newItemsOnly([], [{ description: "  " }, { partNo: "A" }]);
    expect(added).toHaveLength(1);
    expect(added[0]).toEqual({ partNo: "A" });
  });

  it("does not add the same incoming line twice", () => {
    const added = newItemsOnly([], [{ partNo: "A" }, { partNo: "A" }]);
    expect(added).toHaveLength(1);
  });
});

describe("planReuseItems", () => {
  it("keeps the caller's row objects so the insert carries every field", () => {
    // The route inserts `toInsert` directly, so it must be the CALLER's rows —
    // a trimmed copy would silently drop fields like customerRfqItemId.
    const incoming = [
      { partNo: "CB640A", description: "  BREAKER  ", qty: "5", customerRfqItemId: 42 },
      { partNo: "NEW-1", description: "MOTOR", qty: "1", customerRfqItemId: 43 },
    ];
    const { toInsert, addedCount, existingCount } = planReuseItems(
      [{ partNo: "CB640A" }],
      incoming,
    );
    expect(addedCount).toBe(1);
    expect(existingCount).toBe(1);
    expect(toInsert).toHaveLength(1);
    expect(toInsert[0].customerRfqItemId).toBe(43);
    expect(toInsert[0].qty).toBe("1");
  });

  it("plans nothing to insert when every line is already present", () => {
    // The operator's common case: re-sending the SAME request to a missed
    // supplier must add no lines at all, or the analysis doubles.
    const rows = [{ partNo: "A" }, { partNo: "B" }];
    const plan = planReuseItems(rows, rows);
    expect(plan.addedCount).toBe(0);
    expect(plan.toInsert).toHaveLength(0);
    expect(plan.existingCount).toBe(2);
  });
});

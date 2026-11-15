/**
 * Guards for the «الطلبات المفتوحة» rules.
 *
 * A wrong verdict here is not cosmetic: a request judged CLOSED vanishes from
 * the operator's queue, and a countdown off by a day makes the most urgent row
 * look calm. The date cases are pinned against a FIXED `now` so the assertions
 * cannot drift with the machine clock, and they cover the timezone trap
 * (`new Date("2026-11-15")` is UTC midnight, i.e. the 14th west of Greenwich).
 */
import { describe, it, expect } from "vitest";
import {
  daysUntil,
  isOpenRequest,
  remainingLabel,
  urgencyOf,
  OPEN_SOON_DAYS,
} from "../../modules/customer-rfq/open-requests";

const NOON = new Date(2026, 10, 15, 12, 0, 0); // 15 Nov 2026, local

describe("isOpenRequest", () => {
  it("keeps every in-progress stage open", () => {
    for (const stage of ["received", "supplier_priced", "customer_priced", "po_issued"] as const) {
      expect(isOpenRequest(stage, null)).toBe(true);
    }
  });

  it("closes only the terminal stages", () => {
    expect(isOpenRequest("failed", 0)).toBe(false);
    expect(isOpenRequest("expired", null)).toBe(false);
  });

  it("closes a request only when every PO'd item was delivered", () => {
    expect(isOpenRequest("delivered", 100)).toBe(false);
    // The customer is still owed goods — the request is not finished.
    expect(isOpenRequest("delivered", 40)).toBe(true);
    // A missing share must never be read as «complete».
    expect(isOpenRequest("delivered", null)).toBe(true);
  });

  it("keeps a fully-delivered request open while it still has un-ordered items", () => {
    // Live defect this guards: `deliveredPct` is computed over the PO'd items
    // ONLY, so CRFQ-2026-004391 (37 live items, 4 on a PO) reads «نجح بالكامل»
    // the moment its 4 ordered items land — hiding 33 items of outstanding work
    // from the queue with no trace.
    expect(isOpenRequest("delivered", 100, 33)).toBe(true);
    // Same request once every item has been ordered and delivered.
    expect(isOpenRequest("delivered", 100, 0)).toBe(false);
  });

  it("defaults the un-ordered count to zero so callers that have not counted still work", () => {
    expect(isOpenRequest("delivered", 100)).toBe(false);
    expect(isOpenRequest("po_issued", null)).toBe(true);
  });

  it("does not resurrect a request the rules already judged terminal", () => {
    // A `failed`/`expired` request is over however many items it left un-ordered;
    // `unresolvedItems` must not override a terminal verdict.
    expect(isOpenRequest("failed", 0, 5)).toBe(false);
    expect(isOpenRequest("expired", null, 5)).toBe(false);
  });

  it("treats an unknown or absent stage as not open rather than guessing", () => {
    expect(isOpenRequest(null, null)).toBe(false);
    expect(isOpenRequest(undefined, null)).toBe(false);
  });
});

describe("daysUntil", () => {
  it("counts calendar days, today being zero", () => {
    expect(daysUntil("2026-11-15", NOON)).toBe(0);
    expect(daysUntil("2026-11-16", NOON)).toBe(1);
    expect(daysUntil("2026-11-22", NOON)).toBe(OPEN_SOON_DAYS);
    expect(daysUntil("2026-12-15", NOON)).toBe(30);
  });

  it("counts backwards for a passed close date", () => {
    expect(daysUntil("2026-11-14", NOON)).toBe(-1);
    expect(daysUntil("2026-10-16", NOON)).toBe(-30);
  });

  it("does not drift a day on the UTC boundary", () => {
    // Midnight local on the close day is still «today».
    expect(daysUntil("2026-11-15", new Date(2026, 10, 15, 0, 0, 1))).toBe(0);
    expect(daysUntil("2026-11-15", new Date(2026, 10, 15, 23, 59, 59))).toBe(0);
  });

  it("accepts a timestamp and single-digit month/day", () => {
    expect(daysUntil("2026-11-16T09:30:00.000Z", NOON)).toBe(1);
    expect(daysUntil("2027-1-16", NOON)).toBe(62);
  });

  it("returns null for an absent or unparseable value", () => {
    expect(daysUntil(null, NOON)).toBeNull();
    expect(daysUntil(undefined, NOON)).toBeNull();
    expect(daysUntil("", NOON)).toBeNull();
    expect(daysUntil("   ", NOON)).toBeNull();
    expect(daysUntil("not-a-date", NOON)).toBeNull();
  });
});

describe("urgencyOf", () => {
  it("buckets the countdown", () => {
    expect(urgencyOf(-1)).toBe("overdue");
    expect(urgencyOf(0)).toBe("today");
    expect(urgencyOf(1)).toBe("soon");
    expect(urgencyOf(OPEN_SOON_DAYS)).toBe("soon");
    expect(urgencyOf(OPEN_SOON_DAYS + 1)).toBe("normal");
    expect(urgencyOf(null)).toBe("none");
  });

  it("honours a caller-supplied window", () => {
    expect(urgencyOf(3, 2)).toBe("normal");
    expect(urgencyOf(2, 2)).toBe("soon");
  });
});

describe("remainingLabel", () => {
  it("labels today and the near future", () => {
    expect(remainingLabel(0)).toBe("ينتهي اليوم");
    expect(remainingLabel(1)).toBe("متبقي يوم");
    expect(remainingLabel(2)).toBe("متبقي 2 يومان");
    expect(remainingLabel(3)).toBe("متبقي 3 أيام");
    expect(remainingLabel(15)).toBe("متبقي 15 يومًا");
  });

  it("labels a passed close date", () => {
    expect(remainingLabel(-1)).toBe("متأخر يوم");
    expect(remainingLabel(-2)).toBe("متأخر 2 يومان");
    expect(remainingLabel(-5)).toBe("متأخر 5 أيام");
  });

  it("labels a missing close date", () => {
    expect(remainingLabel(null)).toBe("بدون تاريخ إغلاق");
  });
});

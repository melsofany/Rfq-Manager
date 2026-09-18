/**
 * Tests for the reporting conventions shared by the income statement, the
 * balance sheet and the analytics overview.
 *
 * The rule under test: a balance is signed in its own normal direction, so a
 * contra account (مردود المبيعات typed revenue but debit-natured, خصم مشتريات
 * typed expense but credit-natured) comes out negative and nets against its
 * section instead of inflating it.
 */
import { describe, it, expect } from "vitest";
import {
  normalSide,
  signedBalance,
  signedFromRaw,
  currentPeriodResult,
  agingBucket,
  daysBetween,
  emptyBuckets,
  AGING_BUCKETS,
} from "../../modules/accounts/reporting";

describe("normalSide", () => {
  it("treats assets and expenses as debit-natured", () => {
    expect(normalSide("asset")).toBe("debit");
    expect(normalSide("expense")).toBe("debit");
  });

  it("treats liabilities, equity and revenue as credit-natured", () => {
    expect(normalSide("liability")).toBe("credit");
    expect(normalSide("equity")).toBe("credit");
    expect(normalSide("revenue")).toBe("credit");
  });
});

describe("signedBalance", () => {
  it("returns debit minus credit for debit-natured accounts", () => {
    expect(signedBalance("asset", 1000, 0)).toBe(1000);
    expect(signedBalance("expense", 0, 200)).toBe(-200);
  });

  it("returns credit minus debit for credit-natured accounts", () => {
    expect(signedBalance("revenue", 0, 1000)).toBe(1000);
    // مردود المبيعات — typed revenue, running a debit balance → negative.
    expect(signedBalance("revenue", 100, 0)).toBe(-100);
  });
});

describe("signedFromRaw", () => {
  it("keeps a raw debit balance positive on a debit-natured account", () => {
    expect(signedFromRaw("asset", 1200)).toBe(1200);
  });

  it("flips a raw debit balance negative on a credit-natured account", () => {
    expect(signedFromRaw("revenue", 100)).toBe(-100);
    expect(signedFromRaw("liability", 50)).toBe(-50);
  });

  it("keeps a raw credit balance positive on a credit-natured account", () => {
    expect(signedFromRaw("revenue", -1000)).toBe(1000);
  });
});

describe("currentPeriodResult", () => {
  it("is revenue minus expenses", () => {
    expect(currentPeriodResult(500, 300)).toBe(200);
    expect(currentPeriodResult(300, 500)).toBe(-200);
    expect(currentPeriodResult(0, 0)).toBe(0);
  });
});

describe("daysBetween", () => {
  it("counts whole days between two dates", () => {
    expect(daysBetween("2026-08-01", "2026-08-25")).toBe(24);
    expect(daysBetween("2026-06-15", "2026-08-25")).toBe(71);
    expect(daysBetween("2026-08-25", "2026-08-25")).toBe(0);
  });

  it("returns 0 for unparseable input instead of NaN", () => {
    expect(daysBetween("", "2026-08-25")).toBe(0);
    expect(daysBetween("not-a-date", "2026-08-25")).toBe(0);
  });
});

describe("agingBucket", () => {
  const asOf = "2026-08-25";

  it("treats a missing due date as current", () => {
    expect(agingBucket(null, asOf)).toBe("current");
    expect(agingBucket("", asOf)).toBe("current");
  });

  it("treats a due date today or later as current", () => {
    expect(agingBucket("2026-08-25", asOf)).toBe("current");
    expect(agingBucket("2026-09-10", asOf)).toBe("current");
  });

  it("buckets overdue amounts into 30-day bands", () => {
    expect(agingBucket("2026-08-24", asOf)).toBe("d1_30");
    expect(agingBucket("2026-07-26", asOf)).toBe("d1_30"); // 30 days
    expect(agingBucket("2026-07-25", asOf)).toBe("d31_60"); // 31 days
    expect(agingBucket("2026-06-26", asOf)).toBe("d31_60"); // 60 days
    expect(agingBucket("2026-06-25", asOf)).toBe("d61_90"); // 61 days
    expect(agingBucket("2026-05-27", asOf)).toBe("d61_90"); // 90 days
    expect(agingBucket("2026-05-26", asOf)).toBe("d90_plus"); // 91 days
  });
});

describe("emptyBuckets", () => {
  it("returns a zero for every bucket", () => {
    const buckets = emptyBuckets();
    expect(Object.keys(buckets).sort()).toEqual([...AGING_BUCKETS].sort());
    for (const b of AGING_BUCKETS) expect(buckets[b]).toBe(0);
  });
});

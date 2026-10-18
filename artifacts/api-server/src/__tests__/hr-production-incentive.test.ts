import { describe, it, expect } from "vitest";
import {
  cairoPeriod,
  monthDue,
  monthlyItemCounts,
  buildProductionLines,
  type AssignmentInput,
  type DeliveryInput,
} from "../modules/hr/production-incentive";

const at = (iso: string) => new Date(iso);
const NOW = at("2026-12-31T00:00:00Z");

describe("cairoPeriod", () => {
  it("uses Cairo time, so 22:30 UTC on the last day counts as the next month", () => {
    expect(cairoPeriod(at("2026-01-31T22:30:00Z"))).toBe("2026-02");
  });
  it("keeps the same month when Cairo and UTC agree", () => {
    expect(cairoPeriod(at("2026-03-15T10:00:00Z"))).toBe("2026-03");
  });
});

describe("monthDue", () => {
  it("pays the ratio of the base: 90 accepted out of 100 assigned gives 90%", () => {
    expect(monthDue(1000, 100, 90, 0)).toBe(900);
  });
  it("pays nothing when no items were assigned", () => {
    expect(monthDue(1000, 0, 0, 0)).toBe(0);
  });
  it("pays only the difference from what was already credited", () => {
    // January: 8 of 10 accepted → 800 paid. March: 10 of 10 → 200 more.
    expect(monthDue(1000, 10, 10, 800)).toBe(200);
  });
  it("claws back when an earlier delivery is voided", () => {
    expect(monthDue(1000, 10, 7, 800)).toBe(-100);
  });
  it("claws back the whole credit when the items are no longer held", () => {
    expect(monthDue(1000, 0, 0, 800)).toBe(-800);
  });
  it("rounds to piasters without drift", () => {
    // 1000 × 1/3 = 333.33
    expect(monthDue(1000, 3, 1, 0)).toBe(333.33);
  });
});

describe("monthlyItemCounts", () => {
  const a = (
    id: number,
    item: number,
    emp: number,
    iso: string,
    cancelled = false,
  ): AssignmentInput => ({
    id,
    customerRfqItemId: item,
    employeeId: emp,
    assignedAt: at(iso),
    cancelled,
  });
  const d = (item: number, iso: string, acceptedQty: number): DeliveryInput => ({
    customerRfqItemId: item,
    deliveredAt: at(iso),
    acceptedQty,
  });

  it("counts an item for the employee holding its latest assignment, in the assignment month", () => {
    const assignments = [a(1, 10, 5, "2026-01-10T08:00:00Z"), a(2, 10, 6, "2026-03-02T08:00:00Z")];
    const deliveries = [d(10, "2026-03-20T08:00:00Z", 1)];
    expect(monthlyItemCounts(assignments, deliveries, 5, NOW)).toEqual([]);
    expect(monthlyItemCounts(assignments, deliveries, 6, NOW)).toEqual([
      { period: "2026-03", assigned: 1, delivered: 1 },
    ]);
  });

  it("matches the 100 / 95 / 91 / 90 example: 90 accepted out of 100 assigned", () => {
    const assignments = Array.from({ length: 100 }, (_, i) =>
      a(i + 1, i + 1, 5, "2026-02-05T08:00:00Z"),
    );
    const deliveries = Array.from({ length: 90 }, (_, i) => d(i + 1, "2026-02-25T08:00:00Z", 2));
    const [m] = monthlyItemCounts(assignments, deliveries, 5, NOW);
    expect(m).toEqual({ period: "2026-02", assigned: 100, delivered: 90 });
    expect(monthDue(1000, m.assigned, m.delivered, 0)).toBe(900);
  });

  it("does not count a delivery where the customer rejected everything", () => {
    const assignments = [a(1, 10, 5, "2026-02-05T08:00:00Z")];
    expect(monthlyItemCounts(assignments, [d(10, "2026-02-20T08:00:00Z", 0)], 5, NOW)).toEqual([
      { period: "2026-02", assigned: 1, delivered: 0 },
    ]);
  });

  it("ignores deliveries after the calculation time", () => {
    const assignments = [a(1, 10, 5, "2026-02-05T08:00:00Z")];
    expect(monthlyItemCounts(assignments, [d(10, "2027-01-05T08:00:00Z", 1)], 5, NOW)).toEqual([
      { period: "2026-02", assigned: 1, delivered: 0 },
    ]);
  });

  it("excludes cancelled items from the denominator", () => {
    const assignments = [
      a(1, 10, 5, "2026-02-05T08:00:00Z", true),
      a(2, 11, 5, "2026-02-05T08:00:00Z"),
    ];
    expect(monthlyItemCounts(assignments, [], 5, NOW)).toEqual([
      { period: "2026-02", assigned: 1, delivered: 0 },
    ]);
  });
});

describe("buildProductionLines — retroactive settlement", () => {
  it("pays January's 80% in January, then the difference to 100% in March", () => {
    // January: 10 assigned, 8 accepted by the time of the January run.
    const jan = buildProductionLines(
      [{ period: "2026-01", assigned: 10, delivered: 8 }],
      [],
      "2026-01",
      1000,
    );
    expect(jan.total).toBe(800);
    // March run: the same January items are now all accepted.
    const mar = buildProductionLines(
      [{ period: "2026-01", assigned: 10, delivered: 10 }],
      [{ basisPeriod: "2026-01", baseAmount: 1000, creditedAmount: 800 }],
      "2026-03",
      1500, // a later contract change does not rewrite January's base
    );
    expect(mar.total).toBe(200);
    expect(mar.months[0].base).toBe(1000);
  });

  it("does not include basis months after the payroll month", () => {
    const r = buildProductionLines(
      [
        { period: "2026-01", assigned: 10, delivered: 10 },
        { period: "2026-04", assigned: 10, delivered: 10 },
      ],
      [],
      "2026-03",
      1000,
    );
    expect(r.months.map((m) => m.basisPeriod)).toEqual(["2026-01"]);
  });

  it("uses the current contract incentive for a month that was never credited", () => {
    const r = buildProductionLines(
      [{ period: "2026-02", assigned: 4, delivered: 3 }],
      [],
      "2026-02",
      1200,
    );
    expect(r.months[0].base).toBe(1200);
    expect(r.total).toBe(900);
  });
});

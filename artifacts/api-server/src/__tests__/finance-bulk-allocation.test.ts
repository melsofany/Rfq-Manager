/**
 * سداد إجمالي — the FIFO split, tested as a pure function.
 *
 * The operator types ONE total for a supplier and expects the money to clear
 * the OLDEST debt first. That rule is the whole contract of the feature: if the
 * split were arbitrary the printed breakdown could not be re-derived by hand,
 * which is what makes a bulk payment order auditable.
 */
import { describe, it, expect } from "vitest";
import { allocateFifo, remainingOf, totalOutstanding } from "../modules/finance/allocation";

const at = (day: number) => new Date(Date.UTC(2026, 0, day)).toISOString();

function order(id: number, due: number, paid = 0, day = id) {
  return { id, dueAmount: String(due), paidAmount: String(paid), selectedAt: at(day) };
}

describe("finance bulk payment — FIFO allocation", () => {
  it("clears the oldest order first, then moves to the next", () => {
    const orders = [order(1, 100, 0, 1), order(2, 200, 0, 2), order(3, 300, 0, 3)];
    // 250 clears order 1 fully (100) and puts 150 on order 2.
    expect(allocateFifo(orders, 250)).toEqual([
      { requestId: 1, amount: 100 },
      { requestId: 2, amount: 150 },
    ]);
  });

  it("settles every order when the total equals the outstanding balance", () => {
    const orders = [order(1, 100), order(2, 250), order(3, 50)];
    const out = allocateFifo(orders, 400);
    expect(out).toEqual([
      { requestId: 1, amount: 100 },
      { requestId: 2, amount: 250 },
      { requestId: 3, amount: 50 },
    ]);
    // The split must add up to the transfer EXACTLY — that is what lets one
    // bank instruction be reconciled against three debts.
    expect(out.reduce((s, a) => s + a.amount, 0)).toBe(400);
  });

  it("orders by selection date, not by id", () => {
    // id 2 was selected BEFORE id 1, so id 2 is the older debt.
    const orders = [order(1, 100, 0, 5), order(2, 100, 0, 2)];
    expect(allocateFifo(orders, 100)).toEqual([{ requestId: 2, amount: 100 }]);
  });

  it("counts only what is still owed on a partially paid order", () => {
    const orders = [order(1, 500, 300, 1), order(2, 100, 0, 2)];
    // 250: order 1 still owes 200 → gets 200; order 2 gets the remaining 50.
    expect(allocateFifo(orders, 250)).toEqual([
      { requestId: 1, amount: 200 },
      { requestId: 2, amount: 50 },
    ]);
  });

  it("skips orders that are already settled", () => {
    const orders = [order(1, 100, 100, 1), order(2, 80, 0, 2)];
    expect(allocateFifo(orders, 50)).toEqual([{ requestId: 2, amount: 50 }]);
  });

  it("never allocates to a zero or negative total", () => {
    const orders = [order(1, 100)];
    expect(allocateFifo(orders, 0)).toEqual([]);
    expect(allocateFifo(orders, -50)).toEqual([]);
  });

  it("leaves a total above the balance unallocated rather than inventing debt", () => {
    // The caller must refuse this; the function must not spread the excess.
    const orders = [order(1, 100), order(2, 50)];
    const out = allocateFifo(orders, 500);
    expect(out).toEqual([
      { requestId: 1, amount: 100 },
      { requestId: 2, amount: 50 },
    ]);
    expect(out.reduce((s, a) => s + a.amount, 0)).toBe(150);
  });

  it("keeps a cent-level remainder on the last order, not lost to rounding", () => {
    const orders = [order(1, 33.33, 0, 1), order(2, 33.33, 0, 2), order(3, 33.34, 0, 3)];
    const out = allocateFifo(orders, 100);
    expect(out.reduce((s, a) => s + a.amount, 0)).toBeCloseTo(100, 2);
  });

  it("reports the remaining balance per order and in total", () => {
    expect(remainingOf(order(1, 500, 200))).toBe(300);
    // Overpayment must not produce a negative debt.
    expect(remainingOf(order(1, 100, 150))).toBe(0);
    expect(totalOutstanding([order(1, 100, 40), order(2, 60, 0)])).toBe(120);
  });
});

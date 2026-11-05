/**
 * توزيع سداد إجمالي على أوامر التوريد المفتوحة — oldest first.
 *
 * One transfer to a supplier usually settles several purchase orders at once.
 * The operator enters ONE total; this decides how much of it belongs to each
 * open order, so the single payment order can carry a breakdown that adds up to
 * exactly the amount transferred.
 *
 * FIFO (الأقدم أولًا) is the rule because it is the one an accountant can
 * predict and defend: the oldest debt is cleared first. Any other rule would
 * make the breakdown impossible to verify without re-deriving it by hand.
 *
 * Pure on purpose — no database, no rounding surprises hidden in SQL.
 */

export interface AllocatableOrder {
  id: number;
  /** What the order owes in total. */
  dueAmount: unknown;
  /** What has already been paid against it. */
  paidAmount: unknown;
  /** Used only for ordering; the oldest debt is settled first. */
  selectedAt: unknown;
}

export interface Allocation {
  requestId: number;
  amount: number;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Still owed on one order, never negative. */
export function remainingOf(o: AllocatableOrder): number {
  return Math.max(0, round2(num(o.dueAmount) - num(o.paidAmount)));
}

function timeOf(v: unknown): number {
  if (v == null) return Number.MAX_SAFE_INTEGER;
  const t = v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
  return isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

/**
 * Split `total` across the open orders, oldest first.
 *
 * Returns only the orders that actually receive money, in allocation order, so
 * the printed breakdown never lists a zero line. A total that exceeds the sum
 * of what is owed allocates everything and leaves the excess unreported — the
 * caller must refuse it, not this function, because only the caller can say so
 * to the operator.
 */
export function allocateFifo(orders: AllocatableOrder[], total: number): Allocation[] {
  const wanted = round2(num(total));
  if (!(wanted > 0)) return [];

  const open = orders
    .map((o) => ({ ...o, remaining: remainingOf(o) }))
    .filter((o) => o.remaining > 0)
    .sort((a, b) => {
      const d = timeOf(a.selectedAt) - timeOf(b.selectedAt);
      return d !== 0 ? d : a.id - b.id;
    });

  const out: Allocation[] = [];
  let left = wanted;
  for (const o of open) {
    if (left <= 0) break;
    const amount = round2(Math.min(o.remaining, left));
    if (amount <= 0) continue;
    out.push({ requestId: o.id, amount });
    left = round2(left - amount);
  }
  return out;
}

/** Sum of what is still owed across the orders — the ceiling for a bulk payment. */
export function totalOutstanding(orders: AllocatableOrder[]): number {
  return round2(orders.reduce((s, o) => s + remainingOf(o), 0));
}

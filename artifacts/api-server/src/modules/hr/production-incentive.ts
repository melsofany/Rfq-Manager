/**
 * Production incentive (حافز الإنتاج) — the share of the incentive a procurement employee earns
 * from the customer items assigned to them, and that the customer has actually accepted.
 *
 * Rules (agreed with the business):
 *   - Denominator: the customer items whose CURRENT holder is the employee and whose assignment
 *     date falls in the basis month (Cairo time). Cancelled items are excluded.
 *   - Numerator: those items that have at least one non-voided customer delivery whose accepted
 *     quantity (delivered − rejected by customer) is greater than zero, delivered on or before
 *     the calculation time. A partial delivery counts the whole item.
 *   - Ratio = delivered ÷ assigned, and the month's share = base × ratio.
 *   - Late deliveries are settled retroactively: each basis month is recalculated on every
 *     payroll run, and only the difference from what was already credited is paid in the run
 *     where the delivery happens.
 *   - Reassignment: an item belongs to the employee whose assignment row is the latest one.
 *
 * The month arithmetic and the ratio are pure functions so they can be tested without a database.
 */
import {
  db,
  customerRfqItemAssignmentsTable,
  customerRfqItemsTable,
  customerPoItemsTable,
  customerPoItemDeliveriesTable,
  hrProductionCreditsTable,
} from "@workspace/db";
import { and, eq, inArray, lte } from "drizzle-orm";

export const CAIRO_TZ = "Africa/Cairo";

/** YYYY-MM of a date in Cairo time, so month boundaries follow the company's calendar. */
export function cairoPeriod(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CAIRO_TZ,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  return `${y}-${m}`;
}

/**
 * Amount a basis month should have paid so far, minus what it already paid.
 * Works in piasters (integers) so rounding never drifts. With no assigned items the target is
 * zero, so any earlier payment becomes a clawback.
 */
export function monthDue(
  base: number,
  assigned: number,
  delivered: number,
  credited: number,
): number {
  const baseCents = Math.round(base * 100);
  const targetCents = assigned > 0 ? Math.round((baseCents * delivered) / assigned) : 0;
  return (targetCents - Math.round(credited * 100)) / 100;
}

export interface AssignmentInput {
  id: number;
  customerRfqItemId: number;
  employeeId: number;
  assignedAt: Date;
  cancelled: boolean;
}

export interface DeliveryInput {
  customerRfqItemId: number;
  deliveredAt: Date;
  /** delivered − rejected by the customer. Only positive values are accepted. */
  acceptedQty: number;
}

export interface MonthCounts {
  period: string;
  assigned: number;
  delivered: number;
}

/**
 * Counts, per basis month, the items this employee currently holds and how many of them the
 * customer has accepted by `cutoff`.
 */
export function monthlyItemCounts(
  assignments: AssignmentInput[],
  deliveries: DeliveryInput[],
  employeeId: number,
  cutoff: Date,
): MonthCounts[] {
  // Latest assignment row per item decides the holder.
  const latest = new Map<number, AssignmentInput>();
  for (const a of assignments) {
    const cur = latest.get(a.customerRfqItemId);
    if (
      !cur ||
      a.assignedAt.getTime() > cur.assignedAt.getTime() ||
      (a.assignedAt.getTime() === cur.assignedAt.getTime() && a.id > cur.id)
    ) {
      latest.set(a.customerRfqItemId, a);
    }
  }

  const acceptedByItem = new Set<number>();
  for (const d of deliveries) {
    if (d.acceptedQty > 0 && d.deliveredAt.getTime() <= cutoff.getTime()) {
      acceptedByItem.add(d.customerRfqItemId);
    }
  }

  const byPeriod = new Map<string, MonthCounts>();
  for (const row of latest.values()) {
    if (row.employeeId !== employeeId || row.cancelled) continue;
    const period = cairoPeriod(row.assignedAt);
    const m = byPeriod.get(period) ?? { period, assigned: 0, delivered: 0 };
    m.assigned++;
    if (acceptedByItem.has(row.customerRfqItemId)) m.delivered++;
    byPeriod.set(period, m);
  }
  return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
}

export interface ProductionMonthLine {
  basisPeriod: string;
  assigned: number;
  delivered: number;
  base: number;
  credited: number;
  due: number;
}

export interface ProductionIncentiveResult {
  total: number;
  months: ProductionMonthLine[];
}

/**
 * Builds the per-month lines from the counts and the credits already paid. `runPeriod` limits the
 * result to basis months up to and including the payroll month. A month with earlier credits but
 * no current items still appears, as a clawback.
 */
export function buildProductionLines(
  counts: MonthCounts[],
  credits: { basisPeriod: string; baseAmount: number; creditedAmount: number }[],
  runPeriod: string,
  contractIncentive: number,
): ProductionIncentiveResult {
  const periods = new Set<string>();
  for (const c of counts) periods.add(c.period);
  for (const c of credits) periods.add(c.basisPeriod);

  const months: ProductionMonthLine[] = [];
  for (const period of [...periods].sort()) {
    if (period > runPeriod) continue;
    const c = counts.find((x) => x.period === period) ?? { period, assigned: 0, delivered: 0 };
    const mine = credits.filter((x) => x.basisPeriod === period);
    // The base is fixed by the first payment for that month, so a later contract change does not
    // rewrite what was already decided.
    const base = mine.length ? mine[0].baseAmount : contractIncentive;
    const credited = mine.reduce((s, x) => s + x.creditedAmount, 0);
    const due = monthDue(base, c.assigned, c.delivered, credited);
    months.push({
      basisPeriod: period,
      assigned: c.assigned,
      delivered: c.delivered,
      base,
      credited: Math.round(credited * 100) / 100,
      due,
    });
  }
  const total = Math.round(months.reduce((s, m) => s + m.due * 100, 0)) / 100;
  return { total, months };
}

/** Loads the items this procurement account holds and their deliveries, then computes the lines. */
export async function computeProductionIncentive(args: {
  hrEmployeeId: number;
  procurementEmployeeId: number;
  runPeriod: string;
  contractIncentive: number;
  now?: Date;
}): Promise<ProductionIncentiveResult> {
  const cutoff = args.now ?? new Date();

  const touched = await db
    .select({ itemId: customerRfqItemAssignmentsTable.customerRfqItemId })
    .from(customerRfqItemAssignmentsTable)
    .where(eq(customerRfqItemAssignmentsTable.employeeId, args.procurementEmployeeId));
  const itemIds = [...new Set(touched.map((t) => t.itemId))];

  let counts: MonthCounts[] = [];
  if (itemIds.length) {
    const assignRows = await db
      .select({
        id: customerRfqItemAssignmentsTable.id,
        customerRfqItemId: customerRfqItemAssignmentsTable.customerRfqItemId,
        employeeId: customerRfqItemAssignmentsTable.employeeId,
        assignedAt: customerRfqItemAssignmentsTable.assignedAt,
      })
      .from(customerRfqItemAssignmentsTable)
      .where(inArray(customerRfqItemAssignmentsTable.customerRfqItemId, itemIds));
    const cancelledRows = await db
      .select({ id: customerRfqItemsTable.id, cancelled: customerRfqItemsTable.isCancelled })
      .from(customerRfqItemsTable)
      .where(inArray(customerRfqItemsTable.id, itemIds));
    const cancelled = new Map(cancelledRows.map((r) => [r.id, r.cancelled]));

    const deliveryRows = await db
      .select({
        customerRfqItemId: customerPoItemsTable.customerRfqItemId,
        deliveredAt: customerPoItemDeliveriesTable.deliveredAt,
        deliveredQty: customerPoItemDeliveriesTable.deliveredQty,
        rejectedQty: customerPoItemDeliveriesTable.rejectedByCustomerQty,
      })
      .from(customerPoItemDeliveriesTable)
      .innerJoin(
        customerPoItemsTable,
        eq(customerPoItemsTable.id, customerPoItemDeliveriesTable.customerPoItemId),
      )
      .where(
        and(
          inArray(customerPoItemsTable.customerRfqItemId, itemIds),
          eq(customerPoItemDeliveriesTable.voided, false),
          lte(customerPoItemDeliveriesTable.deliveredAt, cutoff),
        ),
      );

    counts = monthlyItemCounts(
      assignRows.map((a) => ({
        id: a.id,
        customerRfqItemId: a.customerRfqItemId,
        employeeId: a.employeeId ?? -1,
        assignedAt: new Date(a.assignedAt),
        cancelled: cancelled.get(a.customerRfqItemId) ?? false,
      })),
      deliveryRows.flatMap((d) =>
        d.customerRfqItemId == null
          ? []
          : [
              {
                customerRfqItemId: d.customerRfqItemId,
                deliveredAt: new Date(d.deliveredAt),
                acceptedQty: Number(d.deliveredQty ?? 0) - Number(d.rejectedQty ?? 0),
              },
            ],
      ),
      args.procurementEmployeeId,
      cutoff,
    ).filter((m) => m.period <= args.runPeriod);
  }

  const creditRows = await db
    .select({
      basisPeriod: hrProductionCreditsTable.basisPeriod,
      baseAmount: hrProductionCreditsTable.baseAmount,
      creditedAmount: hrProductionCreditsTable.creditedAmount,
    })
    .from(hrProductionCreditsTable)
    .where(eq(hrProductionCreditsTable.employeeId, args.hrEmployeeId));

  return buildProductionLines(
    counts,
    creditRows.map((c) => ({
      basisPeriod: c.basisPeriod,
      baseAmount: Number(c.baseAmount),
      creditedAmount: Number(c.creditedAmount),
    })),
    args.runPeriod,
    args.contractIncentive,
  );
}

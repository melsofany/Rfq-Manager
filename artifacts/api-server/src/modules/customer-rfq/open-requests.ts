/**
 * Open-request rules — قواعد الطلبات المفتوحة
 *
 * The «الطلبات المفتوحة» tab on `/customer-rfq` answers two questions: which
 * requests still have work owed on them, and how long is left before the close
 * date. Both halves are RULES, so they live here — pure, no database and no
 * clock of their own — and are unit-tested.
 *
 * A wrong verdict is not a cosmetic defect: a request wrongly judged CLOSED
 * silently disappears from the operator's queue (work nobody sees again), and a
 * countdown that is off by a day makes the most urgent row look calm. Both are
 * the "a capability doing something other than it claims" family this repository
 * keeps paying for.
 *
 * Openness is derived from the request status the module ALREADY computes
 * (`buildRequestStatus` in routes.ts); this module never re-derives the
 * milestones, so the tab and the list can never disagree about a request.
 */

/** A request closing within this many days is «قريب الإغلاق» (mirrors the collections module). */
export const OPEN_SOON_DAYS = 7;

/** Terminal stages: the request has finished one way or another. */
const CLOSED_STAGES = new Set(["failed", "expired"]);

export type OpenUrgency = "overdue" | "today" | "soon" | "normal" | "none";

/** The facts the openness rule needs, all derived by the caller. */
export interface OpenRequestFacts {
  /** Derived request stage (`buildRequestStatus`). */
  stage: string | null | undefined;
  /** Share of the PO'd items delivered to the customer. */
  deliveredPct: number | null;
  /** Live items that never reached a customer PO. */
  unresolvedItems?: number;
  /** The close date has PASSED. */
  closePassed?: boolean;
}

/**
 * Is this request still OPEN?
 *
 * Closed when the derived status says the request is over:
 *   • `failed`   — items were rejected and none were delivered;
 *   • `expired`  — the close date passed with no progress at all;
 *   • `delivered` with 100% of the PO'd items delivered AND nothing un-ordered.
 *
 * **A passed close date closes the request.** Reported live: `26R012682` closed
 * 2026-10-17 and still appeared as «open» with a negative countdown. The
 * operator's own definition settles it — «مش هنقدر نقدم بيه عرض سعر للعميل»: once
 * the close date has passed, no quote can be submitted, so the request is no
 * longer open FOR QUOTING whatever progress it reached. A request already priced
 * or ordered is not an exception; it is fulfilment, not an open request, and the
 * tab's «إظهار المنتهية» toggle is where it can be reviewed.
 *
 * `unresolvedItems` matters because `deliveredPct` is computed over the PO'd
 * items ONLY, so a request can read «نجح بالكامل» while most of its items were
 * never ordered at all (live: `CRFQ-2026-004391`, 37 live items and 4 on a PO).
 */
export function isOpenRequest(facts: OpenRequestFacts): boolean {
  const { stage, deliveredPct, unresolvedItems = 0, closePassed = false } = facts;
  if (stage == null) return false;
  if (CLOSED_STAGES.has(stage)) return false;
  if (closePassed) return false;
  if (unresolvedItems > 0) return true;
  if (stage === "delivered") return deliveredPct == null ? true : deliveredPct < 100;
  return true;
}

/**
 * Calendar days from today until `dateStr` (negative when the date has passed,
 * 0 when it is today). `null` when the value is absent or unparseable.
 *
 * Compared as LOCAL calendar days, not as instants: the close date is stored as
 * a plain `YYYY-MM-DD` text, so "closes today" must read as 0 whatever the
 * server's timezone, and a date must never drift a day because of a time part
 * nobody entered.
 */
export function daysUntil(
  dateStr: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!dateStr) return null;
  const trimmed = String(dateStr).trim();
  if (!trimmed) return null;
  // Parse the stored form explicitly; `new Date("2026-11-15")` is UTC midnight
  // and would read as the PREVIOUS day west of Greenwich.
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed);
  const target = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(trimmed);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  return Math.round((day.getTime() - today.getTime()) / 86_400_000);
}

/** Bucket a countdown for the UI. */
export function urgencyOf(days: number | null, soonDays: number = OPEN_SOON_DAYS): OpenUrgency {
  if (days == null) return "none";
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= soonDays) return "soon";
  return "normal";
}

/** Arabic label for an urgency bucket (returned by the API so the UI never re-derives it). */
export const URGENCY_LABELS: Record<OpenUrgency, string> = {
  overdue: "متأخر عن موعد الإغلاق",
  today: "ينتهي اليوم",
  soon: "قريب الإغلاق",
  normal: "مفتوح",
  none: "بدون تاريخ إغلاق",
};

/** Arabic plural of «يوم» for a positive count (the 3–10 / 11+ split Arabic requires). */
function daysWord(n: number): string {
  if (n === 1) return "يوم";
  if (n === 2) return "يومان";
  if (n >= 3 && n <= 10) return "أيام";
  if (n >= 11 && n <= 99) return "يومًا";
  return "يوم";
}

/**
 * Human countdown, e.g. «متبقي 3 أيام» / «ينتهي اليوم» / «متأخر يومان».
 * The label is built HERE (not in the portal) so the server's countdown and the
 * sentence the operator reads are the same rule.
 */
export function remainingLabel(days: number | null): string {
  if (days == null) return URGENCY_LABELS.none;
  if (days === 0) return "ينتهي اليوم";
  if (days < 0) {
    const n = -days;
    return `متأخر ${n === 1 ? "" : `${n} `}${daysWord(n)}`;
  }
  return `متبقي ${n0(days)}${daysWord(days)}`;
}

/** 1 needs no number in Arabic («متبقي يوم»); every other count does. */
function n0(n: number): string {
  return n === 1 ? "" : `${n} `;
}

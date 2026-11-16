/**
 * Punch pairing — تحليل بصمات الجهاز إلى حضور وانصراف.
 *
 * The ZKTeco device records a DIRECTION with every punch (`status`):
 *   0 = check-in, 1 = check-out, 4 = overtime check-in, 5 = overtime check-out.
 * The attendance code ignored that column and simply took the first punch of the
 * day as the arrival and the last as the departure, so a rep who forgot to punch
 * on the way in and punched only on the way out was recorded as ARRIVING at
 * their departure time — the whole day read as a very late arrival.
 *
 * These helpers are pure (no DB) so the pairing is unit-testable. `status` is
 * used as the PRIMARY signal when present; the sequence is the fallback for
 * firmware that omits it.
 */

export const PUNCH_IN = "0";
export const PUNCH_OUT = "1";
export const PUNCH_OT_IN = "4";
export const PUNCH_OT_OUT = "5";

export interface PunchLike {
  /** "HH:MM:SS" wall-clock, as stored. */
  time: string;
  status: string | null;
}

export interface DayPunches {
  /** Earliest check-in, or null when the day has no arrival punch. */
  firstIn: string | null;
  /** Latest check-out, or null when the day has no departure punch. */
  lastOut: string | null;
  punchCount: number;
  /**
   * The day has punches but only one side of the pair: a lone check-out (they
   * forgot to punch in) or a lone check-in (they forgot to punch out). Payroll
   * must not treat such a day as complete.
   */
  incomplete: boolean;
  /** Which side is missing on an incomplete day. */
  missing: "in" | "out" | null;
}

/** A punch's direction from its `status` column, or null when it carries none. */
function directionOf(status: string | null | undefined): "in" | "out" | null {
  if (status === PUNCH_IN || status === PUNCH_OT_IN) return "in";
  if (status === PUNCH_OUT || status === PUNCH_OT_OUT) return "out";
  return null;
}

/**
 * Split one day's punches into an arrival and a departure.
 *
 * When the device gives directions, an ARRIVAL can only be a check-in and a
 * DEPARTURE only a check-out — so a lone check-out yields `firstIn = null`
 * rather than falsely reporting an arrival at the departure time. Without
 * directions the first/last punch is the only available reading, and a lone
 * punch is taken as an arrival (the historical behaviour, kept for firmware
 * that omits the column).
 */
export function pairDayPunches(punches: PunchLike[]): DayPunches {
  const count = punches.length;
  if (count === 0) {
    return { firstIn: null, lastOut: null, punchCount: 0, incomplete: false, missing: null };
  }
  const directed = punches.some((p) => directionOf(p.status) !== null);
  if (!directed) {
    return {
      firstIn: punches[0].time,
      lastOut: count > 1 ? punches[count - 1].time : null,
      punchCount: count,
      incomplete: count < 2,
      missing: count < 2 ? "out" : null,
    };
  }
  const ins = punches.filter((p) => directionOf(p.status) === "in");
  const outs = punches.filter((p) => directionOf(p.status) === "out");
  const firstIn = ins.length ? ins[0].time : null;
  const lastOut = outs.length ? outs[outs.length - 1].time : null;
  const incomplete = firstIn === null || lastOut === null;
  return {
    firstIn,
    lastOut,
    punchCount: count,
    incomplete,
    missing: !incomplete ? null : firstIn === null ? "in" : "out",
  };
}

/**
 * Can this day be settled as a full attendance day?
 *
 * A day with punches but a missing half is not complete: the operator decides
 * whether the employee was present (e.g. they forgot to punch in but worked the
 * whole day) or absent, and records a per-employee exception / mission for it.
 * Treating it as present automatically would hide a real absence.
 */
export function isDayComplete(day: DayPunches, exemptFromPunch: boolean): boolean {
  if (exemptFromPunch) return true;
  if (day.punchCount === 0) return false;
  return !day.incomplete;
}

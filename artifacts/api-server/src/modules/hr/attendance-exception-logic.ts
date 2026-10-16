/**
 * Per-employee attendance exceptions — قواعد استثناءات الحضور.
 *
 * The company shift is the default for everyone. A specific employee may work
 * to different terms: start later (e.g. shift 08:00 but they punch at 11:00
 * with no lateness), or not be required to punch at all (the day counts as
 * normal). Pure helpers so the resolution is unit-testable.
 *
 * Precedence, highest first:
 *   1. an approved mission (that day only — it overrides the standing policy)
 *   2. the employee's attendance exception
 *   3. the company shift
 */

// One definition of "HH:MM" and minutes-from-midnight for the whole HR module.
import { isHhMm, toMinutes } from "./missions-logic";
export { isHhMm, toMinutes };

export interface WorkShift {
  start: string;
  end: string;
  lateGraceMinutes: number;
}

export interface AttendanceException {
  startTime: string | null;
  lateGraceMinutes: number | null;
  exemptFromPunch: boolean;
  isActive: boolean;
}

/**
 * The terms actually applied to one employee, after folding the company shift
 * with their exception.
 *
 * A blank or malformed stored override is IGNORED rather than applied — a bad
 * value must not silently move everyone's lateness cutoff.
 */
export function resolveEmployeeShift(
  shift: WorkShift,
  exception: AttendanceException | null | undefined,
): WorkShift & { exemptFromPunch: boolean; hasException: boolean } {
  const base: WorkShift & { exemptFromPunch: boolean; hasException: boolean } = {
    start: shift.start,
    end: shift.end,
    lateGraceMinutes: shift.lateGraceMinutes,
    exemptFromPunch: false,
    hasException: false,
  };
  if (!exception || !exception.isActive) return base;

  base.hasException = true;
  if (isHhMm(exception.startTime)) base.start = exception.startTime;
  if (
    typeof exception.lateGraceMinutes === "number" &&
    Number.isInteger(exception.lateGraceMinutes) &&
    exception.lateGraceMinutes >= 0 &&
    exception.lateGraceMinutes <= 240
  ) {
    base.lateGraceMinutes = exception.lateGraceMinutes;
  }
  base.exemptFromPunch = exception.exemptFromPunch === true;
  return base;
}

/**
 * Late minutes for a first punch, given the resolved shift.
 *
 * An employee exempt from punching can never be late — that is the point of
 * the exemption, and it must hold even when a stray punch exists.
 */
export function lateMinutesFor(
  resolved: { start: string; lateGraceMinutes: number; exemptFromPunch: boolean },
  firstIn: string | null,
): number {
  if (resolved.exemptFromPunch) return 0;
  if (!firstIn) return 0;
  return Math.max(0, toMinutes(firstIn) - toMinutes(resolved.start) - resolved.lateGraceMinutes);
}

/**
 * Is the employee absent?
 *
 * An employee exempt from punching is never absent: there is no punch to
 * expect, so the day counts as normal. A full-day mission or approved leave
 * also accounts for the day.
 */
export function isAbsent(opts: {
  punchCount: number;
  exemptFromPunch: boolean;
  fullDayMission: boolean;
  onLeave: boolean;
}): boolean {
  if (opts.punchCount > 0) return false;
  if (opts.exemptFromPunch) return false;
  if (opts.fullDayMission) return false;
  if (opts.onLeave) return false;
  return true;
}

/**
 * Mission rules — قواعد المأموريات.
 *
 * Pure helpers (no DB, no Express) so the decision logic is unit-testable:
 * which missions excuse an absence, and which window they cover.
 *
 * The rule the operator asked for: a mission is a MANAGER decision. Only an
 * `approved` mission affects attendance; `pending` and `rejected` change
 * nothing, so a request cannot quietly excuse an absence on its own.
 */

export const MISSION_TYPES = ["full_day", "timed"] as const;
export type MissionType = (typeof MISSION_TYPES)[number];

export const MISSION_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export interface MissionLike {
  missionType: string;
  status: string;
  startTime: string | null;
  endTime: string | null;
}

export function isMissionType(v: unknown): v is MissionType {
  return typeof v === "string" && (MISSION_TYPES as readonly string[]).includes(v);
}

/** "HH:MM" wall-clock time. */
export function isHhMm(v: unknown): v is string {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * A timed mission must state a usable window; a full-day mission must not
 * carry times (they would be ignored, and a silent ignore is how a "timed"
 * mission looks approved while covering nothing).
 */
export function validateMissionWindow(
  type: MissionType,
  startTime: string | null,
  endTime: string | null,
): { error: string } | { startTime: string | null; endTime: string | null } {
  if (type === "full_day") {
    return { startTime: null, endTime: null };
  }
  if (!isHhMm(startTime) || !isHhMm(endTime)) {
    return { error: "المأمورية المحددة بوقت تحتاج وقت بداية ووقت نهاية (مثال 08:00)" };
  }
  if (toMinutes(endTime) <= toMinutes(startTime)) {
    return { error: "وقت النهاية يجب أن يكون بعد وقت البداية" };
  }
  return { startTime, endTime };
}

/** True when the mission excuses the given day entirely. */
export function isFullDayMission(m: MissionLike): boolean {
  return m.status === "approved" && m.missionType === "full_day";
}

/**
 * The time window an approved TIMED mission covers, in minutes from midnight.
 * Returns null when the mission excuses nothing (not approved, full-day, or an
 * unusable window) — a caller must then fall back to the punch-based result.
 */
export function approvedWindow(
  m: MissionLike,
): { start: number; end: number; startTime: string; endTime: string } | null {
  if (m.status !== "approved" || m.missionType !== "timed") return null;
  if (!isHhMm(m.startTime) || !isHhMm(m.endTime)) return null;
  const start = toMinutes(m.startTime);
  const end = toMinutes(m.endTime);
  if (end <= start) return null;
  return { start, end, startTime: m.startTime, endTime: m.endTime };
}

export interface MissionExcusal {
  /** Whole day excused → the employee is «في مأمورية», never absent. */
  fullDay: boolean;
  /** Approved timed windows for the day, earliest first. */
  windows: { start: number; end: number; startTime: string; endTime: string }[];
}

/** Summarise the approved missions covering one employee on one day. */
export function missionExcusal(missions: MissionLike[]): MissionExcusal {
  const fullDay = missions.some(isFullDayMission);
  const windows = missions
    .map(approvedWindow)
    .filter((w): w is NonNullable<typeof w> => w !== null)
    .sort((a, b) => a.start - b.start);
  return { fullDay, windows };
}

/**
 * Does a punch time (minutes from midnight) fall inside any excused window?
 * A punch within the mission window is not evidence of lateness.
 */
export function withinMissionWindow(windows: MissionExcusal["windows"], minutes: number): boolean {
  return windows.some((w) => minutes >= w.start && minutes <= w.end);
}

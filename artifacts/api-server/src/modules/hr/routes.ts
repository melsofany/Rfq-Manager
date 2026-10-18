/**
 * HR API — الموظفون والأجهزة والحضور اليومي.
 *
 *   GET    /api/hr/employees              list HR employees
 *   POST   /api/hr/employees              create
 *   PATCH  /api/hr/employees/:id          update
 *   GET    /api/hr/devices                list fingerprint devices (incl. pending)
 *   PATCH  /api/hr/devices/:sn            name / location / activate
 *   GET    /api/hr/attendance?date=&shiftStart=   daily attendance per employee
 *   GET    /api/hr/punches/recent?limit=  latest raw punches
 *
 * Access: admin always; others need the `hr` permission (role default: manager).
 */
import { validateEmployeeNames } from "./employee-names";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  db,
  employeesTable,
  hrEmployeesTable,
  hrAttendanceDevicesTable,
  hrAttendancePunchesTable,
  hrSettingsTable,
  hrMissionsTable,
  hrAttendanceExceptionsTable,
} from "@workspace/db";
import { and, eq, gte, inArray, lt, lte, desc, asc, sql } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { hrLeaveRequestsTable, hrLeaveTypesTable } from "@workspace/db";
import { missionExcusal, withinMissionWindow } from "./missions-logic";
import { resolveEmployeeShift, lateMinutesFor, isAbsent } from "./attendance-exception-logic";

const router: IRouter = Router();

type Session = { employeeId?: number; role?: string };

/** Role defaults for `hr` (mirrors portal permissions.ts: manager has all pages). */
const HR_ROLE_DEFAULT = new Set(["manager"]);

/** Mirrors portal resolvePermissions for the single `hr` key. */
function hasHrPermission(role: string, permissions: Record<string, boolean> | null): boolean {
  if (role === "admin") return true;
  const explicit = permissions && typeof permissions === "object" ? permissions : null;
  if (explicit && Object.keys(explicit).length) return explicit["hr"] === true;
  return HR_ROLE_DEFAULT.has(role);
}

/** Mirrors the portal's resolvePermissions: explicit map wins, else role default. */
export async function requireHr(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = (req as Request & { session?: Session }).session;
    if (!session?.employeeId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const [emp] = await db
      .select({
        role: employeesTable.role,
        permissions: employeesTable.permissions,
        isActive: employeesTable.isActive,
      })
      .from(employeesTable)
      .where(eq(employeesTable.id, session.employeeId))
      .limit(1);
    if (!emp || !emp.isActive) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!hasHrPermission(emp.role, emp.permissions)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMPNO_RE = /^[A-Za-z0-9_-]{1,32}$/;
const PIN_RE = /^[A-Za-z0-9_-]{1,32}$/;

function str(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function minutesOf(hhmmss: string): number {
  const [h, m] = hhmmss.split(":").map(Number);
  return h * 60 + m;
}

router.use("/hr", requireAuth, requireHr);

// ── Employees ───────────────────────────────────────────────────────────────
router.get("/hr/employees", async (_req, res): Promise<void> => {
  const rows = await db.select().from(hrEmployeesTable).orderBy(asc(hrEmployeesTable.employeeNo));
  res.json(rows);
});

router.post("/hr/employees", async (req, res): Promise<void> => {
  const employeeNo = str(req.body?.employeeNo, 32);
  const names = validateEmployeeNames(req.body?.fullName, req.body?.fullNameEn);
  const biometricPin = str(req.body?.biometricPin, 32);
  if (!employeeNo || !EMPNO_RE.test(employeeNo)) {
    res.status(400).json({ error: "رقم الموظف مطلوب ويجب أن يكون بالصيغة الصحيحة" });
    return;
  }
  if ("error" in names) {
    res.status(400).json({ error: names.error });
    return;
  }
  if (biometricPin && !PIN_RE.test(biometricPin)) {
    res.status(400).json({ error: "رقم البصمة غير صالح" });
    return;
  }
  try {
    const [row] = await db
      .insert(hrEmployeesTable)
      .values({
        employeeNo,
        fullName: names.fullName,
        fullNameEn: names.fullNameEn,
        jobTitle: str(req.body?.jobTitle),
        department: str(req.body?.department),
        hireDate: DATE_RE.test(req.body?.hireDate ?? "") ? req.body.hireDate : null,
        biometricPin,
        phone: str(req.body?.phone, 40),
        notes: str(req.body?.notes, 2000),
      })
      .returning();
    res.status(201).json(row);
  } catch (err) {
    const msg = String((err as Error)?.message ?? "");
    if (msg.includes("duplicate") || msg.includes("unique")) {
      res.status(409).json({ error: "رقم الموظف أو رقم البصمة مستخدم بالفعل" });
      return;
    }
    throw err;
  }
});

router.patch("/hr/employees/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (req.body?.fullName !== undefined || req.body?.fullNameEn !== undefined) {
    const [current] = await db
      .select({ fullName: hrEmployeesTable.fullName, fullNameEn: hrEmployeesTable.fullNameEn })
      .from(hrEmployeesTable)
      .where(eq(hrEmployeesTable.id, id))
      .limit(1);
    if (!current) {
      res.status(404).json({ error: "غير موجود" });
      return;
    }
    const names = validateEmployeeNames(
      req.body?.fullName ?? current.fullName,
      req.body?.fullNameEn ?? current.fullNameEn ?? "",
    );
    if ("error" in names) {
      res.status(400).json({ error: names.error });
      return;
    }
    patch.fullName = names.fullName;
    patch.fullNameEn = names.fullNameEn;
  }
  if (req.body?.hireDate !== undefined) {
    // تاريخ التعيين الجديد عند إعادة تعيين موظف مستقيل
    if (!DATE_RE.test(String(req.body.hireDate))) {
      res.status(400).json({ error: "تاريخ التعيين غير صالح" });
      return;
    }
    patch.hireDate = req.body.hireDate;
  }
  if (req.body?.procurementEmployeeId !== undefined) {
    // حساب المشتريات اللي البنود المسندة له بتحسب حافز الإنتاج لهذا الموظف. null = غير مرتبط.
    const raw = req.body.procurementEmployeeId;
    if (raw === null || raw === "") {
      patch.procurementEmployeeId = null;
    } else {
      const linkId = Number(raw);
      if (!Number.isInteger(linkId) || linkId <= 0) {
        res.status(400).json({ error: "حساب المشتريات غير صالح" });
        return;
      }
      const [account] = await db
        .select({ id: employeesTable.id })
        .from(employeesTable)
        .where(and(eq(employeesTable.id, linkId), eq(employeesTable.isActive, true)))
        .limit(1);
      if (!account) {
        res.status(400).json({ error: "حساب المشتريات غير موجود أو غير نشط" });
        return;
      }
      const [taken] = await db
        .select({ id: hrEmployeesTable.id })
        .from(hrEmployeesTable)
        .where(
          and(
            eq(hrEmployeesTable.procurementEmployeeId, linkId),
            sql`${hrEmployeesTable.id} <> ${id}`,
          ),
        )
        .limit(1);
      if (taken) {
        res.status(409).json({ error: "حساب المشتريات ده مربوط بموظف تاني بالفعل" });
        return;
      }
      patch.procurementEmployeeId = linkId;
    }
  }
  if (req.body?.jobTitle !== undefined) patch.jobTitle = str(req.body.jobTitle);
  if (req.body?.department !== undefined) patch.department = str(req.body.department);
  if (req.body?.phone !== undefined) patch.phone = str(req.body.phone, 40);
  if (req.body?.notes !== undefined) patch.notes = str(req.body.notes, 2000);
  if (req.body?.status !== undefined) {
    if (!["active", "resigned", "terminated"].includes(req.body.status)) {
      res.status(400).json({ error: "حالة غير صالحة" });
      return;
    }
    patch.status = req.body.status;
  }
  if (req.body?.biometricPin !== undefined) {
    const pin = req.body.biometricPin === null ? null : str(req.body.biometricPin, 32);
    if (pin && !PIN_RE.test(pin)) {
      res.status(400).json({ error: "رقم البصمة غير صالح" });
      return;
    }
    patch.biometricPin = pin;
  }
  try {
    const [row] = await db
      .update(hrEmployeesTable)
      .set(patch)
      .where(eq(hrEmployeesTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "غير موجود" });
      return;
    }
    res.json(row);
  } catch (err) {
    const msg = String((err as Error)?.message ?? "");
    if (msg.includes("duplicate") || msg.includes("unique")) {
      res.status(409).json({ error: "رقم البصمة مستخدم بالفعل" });
      return;
    }
    throw err;
  }
});

// ── Devices ─────────────────────────────────────────────────────────────────
router.get("/hr/devices", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(hrAttendanceDevicesTable)
    .orderBy(desc(hrAttendanceDevicesTable.lastSeenAt));
  res.json(rows);
});

router.patch("/hr/devices/:sn", async (req, res): Promise<void> => {
  const sn = String(req.params.sn ?? "");
  const patch: Record<string, unknown> = {};
  if (req.body?.name !== undefined) patch.name = str(req.body.name, 100);
  if (req.body?.location !== undefined) patch.location = str(req.body.location, 200);
  if (typeof req.body?.isActive === "boolean") patch.isActive = req.body.isActive;
  if (!Object.keys(patch).length) {
    res.status(400).json({ error: "لا توجد تغييرات" });
    return;
  }
  const [row] = await db
    .update(hrAttendanceDevicesTable)
    .set(patch)
    .where(eq(hrAttendanceDevicesTable.sn, sn))
    .returning();
  if (!row) {
    res.status(404).json({ error: "الجهاز غير موجود" });
    return;
  }
  res.json(row);
});

// ── Attendance ──────────────────────────────────────────────────────────────

export interface WorkShift {
  start: string;
  end: string;
  lateGraceMinutes: number;
}

/**
 * Work shift configured under HR settings (`work_shift`).
 * Returns null when it has not been configured yet, so callers fall back to
 * the historical 09:00 default.
 */
export async function loadWorkShift(): Promise<WorkShift | null> {
  const rows = await db
    .select()
    .from(hrSettingsTable)
    .where(eq(hrSettingsTable.key, "work_shift"))
    .limit(1);
  const value = rows[0]?.value as Partial<WorkShift> | undefined;
  const start = typeof value?.start === "string" ? value.start : null;
  if (!start || !TIME_RE.test(start)) return null;
  const grace = Number(value?.lateGraceMinutes);
  return {
    start,
    end: typeof value?.end === "string" && TIME_RE.test(value.end) ? value.end : "17:00",
    lateGraceMinutes: Number.isFinite(grace) && grace >= 0 ? grace : 0,
  };
}

/**
 * Non-working days: the weekly day(s) off from Settings → Absence, and official
 * holidays from Settings → Holidays. A non-working day is never absence.
 */
async function loadCalendar(): Promise<{
  weeklyOffDays: number[];
  holidays: Map<string, string>;
}> {
  const rows = await db
    .select()
    .from(hrSettingsTable)
    .where(inArray(hrSettingsTable.key, ["absence", "holidays"]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const absence = byKey.get("absence") as { weeklyOffDays?: number[] } | null | undefined;
  const holidayList = (byKey.get("holidays") as { date: string; name: string }[] | null) ?? [];
  return {
    weeklyOffDays: Array.isArray(absence?.weeklyOffDays) ? absence.weeklyOffDays : [],
    holidays: new Map(holidayList.map((h) => [h.date, h.name])),
  };
}

export type AttendanceOutcome =
  { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

/**
 * Attendance for one calendar date. The single source of the absence rule:
 * the attendance screen and the monthly payroll both call this.
 */
export async function buildAttendance(
  date: string,
  requestedShiftStart: string | undefined,
): Promise<AttendanceOutcome> {
  const configured = await loadWorkShift();
  const shiftStart = String(requestedShiftStart ?? configured?.start ?? "09:00");
  if (!DATE_RE.test(date) || !TIME_RE.test(shiftStart)) {
    return { ok: false, error: "تاريخ أو وقت الوردية غير صالح" };
  }
  const calendar = await loadCalendar();
  const holidayName = calendar.holidays.get(date) ?? null;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const dayOff: { kind: "holiday" | "weekly"; name: string | null } | null = holidayName
    ? { kind: "holiday", name: holidayName }
    : calendar.weeklyOffDays.includes(weekday)
      ? { kind: "weekly", name: null }
      : null;
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDate = next.toISOString().slice(0, 10);

  const employees = await db
    .select()
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.status, "active"))
    .orderBy(asc(hrEmployeesTable.employeeNo));
  const punches = await db
    .select()
    .from(hrAttendancePunchesTable)
    .where(
      and(
        gte(hrAttendancePunchesTable.punchedAt, `${date} 00:00:00`),
        lt(hrAttendancePunchesTable.punchedAt, `${nextDate} 00:00:00`),
      ),
    )
    .orderBy(asc(hrAttendancePunchesTable.punchedAt));

  // Approved leave covering this date → employee is "on leave", not absent.
  const onLeaveRows = await db
    .select({
      employeeId: hrLeaveRequestsTable.employeeId,
      nameAr: hrLeaveTypesTable.nameAr,
    })
    .from(hrLeaveRequestsTable)
    .innerJoin(hrLeaveTypesTable, eq(hrLeaveTypesTable.id, hrLeaveRequestsTable.leaveTypeId))
    .where(
      and(
        eq(hrLeaveRequestsTable.status, "approved"),
        lte(hrLeaveRequestsTable.startDate, date),
        gte(hrLeaveRequestsTable.endDate, date),
      ),
    );
  const leaveByEmp = new Map(onLeaveRows.map((r) => [r.employeeId, r.nameAr]));

  // Approved missions for this date → the employee is out on company business.
  // A full-day mission excuses the whole day; a timed one excuses only its
  // window. Pending/rejected missions change nothing (manager approval is what
  // makes a mission valid).
  const missionRows = await db
    .select()
    .from(hrMissionsTable)
    .where(and(eq(hrMissionsTable.status, "approved"), eq(hrMissionsTable.missionDate, date)));
  const missionsByEmp = new Map<number, typeof missionRows>();
  for (const m of missionRows) {
    const list = missionsByEmp.get(m.employeeId) ?? [];
    list.push(m);
    missionsByEmp.set(m.employeeId, list);
  }

  // Per-employee attendance exceptions (استثناءات الحضور) — a standing policy
  // that overrides the company shift for one employee.
  const exceptionRows = await db.select().from(hrAttendanceExceptionsTable);
  const exceptionByEmp = new Map(exceptionRows.map((r) => [r.employeeId, r]));

  const byPin = new Map<string, string[]>();
  for (const p of punches) {
    const list = byPin.get(p.pin) ?? [];
    list.push(p.punchedAt.slice(11, 19));
    byPin.set(p.pin, list);
  }
  const graceMin = configured?.lateGraceMinutes ?? 0;

  const rows = employees.map((e) => {
    const times = e.biometricPin ? (byPin.get(e.biometricPin) ?? []) : [];
    const firstIn = times[0] ?? null;
    const lastOut = times.length > 1 ? times[times.length - 1] : null;

    const excusal = missionExcusal(missionsByEmp.get(e.id) ?? []);
    const onMission = excusal.fullDay || excusal.windows.length > 0;

    // Fold the company shift with this employee's exception: their own start
    // time, their own grace, and whether a punch is required at all.
    const resolved = resolveEmployeeShift(
      { start: shiftStart, end: configured?.end ?? "17:00", lateGraceMinutes: graceMin },
      exceptionByEmp.get(e.id) ?? null,
    );

    // A punch inside an approved mission window is not lateness.
    const firstInMin = firstIn ? minutesOf(firstIn) : null;
    const coveredByMission =
      firstInMin !== null && withinMissionWindow(excusal.windows, firstInMin);
    const late = coveredByMission
      ? 0
      : lateMinutesFor(
          {
            start: resolved.start,
            lateGraceMinutes: resolved.lateGraceMinutes,
            exemptFromPunch: resolved.exemptFromPunch,
          },
          firstIn,
        );

    // No punches is only absence when nothing excuses the day: a full-day
    // mission, an approved leave, or an exemption from punching at all.
    const absent = dayOff
      ? false
      : isAbsent({
          punchCount: times.length,
          exemptFromPunch: resolved.exemptFromPunch,
          fullDayMission: excusal.fullDay,
          onLeave: leaveByEmp.has(e.id),
        });

    // A timed mission with no punch at all is worth flagging: the window was
    // excused but there is no evidence the employee was ever on site.
    const missingPunchWarning =
      excusal.windows.length > 0 && !excusal.fullDay && times.length === 0;

    return {
      employeeId: e.id,
      employeeNo: e.employeeNo,
      fullName: e.fullName,
      department: e.department,
      biometricPin: e.biometricPin,
      firstIn,
      lastOut,
      punchCount: times.length,
      lateMinutes: late,
      onLeave: leaveByEmp.has(e.id),
      leaveName: leaveByEmp.get(e.id) ?? null,
      onMission,
      missionFullDay: excusal.fullDay,
      missionWindows: excusal.windows.map((w) => `${w.startTime}-${w.endTime}`),
      missingPunchWarning,
      absent,
      dayOffName: dayOff?.name ?? null,
      dayOffKind: dayOff?.kind ?? null,
      // Which terms were applied, so the screen can show the exception rather
      // than silently reporting a lateness of 0.
      shiftStart: resolved.start,
      lateGraceMinutes: resolved.lateGraceMinutes,
      hasException: resolved.hasException,
      exemptFromPunch: resolved.exemptFromPunch,
    };
  });

  return {
    ok: true,
    body: {
      date,
      dayOff,
      shiftStart,
      shiftEnd: configured?.end ?? null,
      lateGraceMinutes: graceMin,
      totals: {
        employees: rows.length,
        present: rows.filter((r) => !r.absent).length,
        absent: rows.filter((r) => r.absent).length,
        onLeave: rows.filter((r) => r.onLeave).length,
        onMission: rows.filter((r) => r.onMission).length,
        late: rows.filter((r) => r.lateMinutes > 0).length,
      },
      rows,
    },
  };
}

router.get("/hr/attendance", async (req, res): Promise<void> => {
  const outcome = await buildAttendance(
    String(req.query.date ?? ""),
    req.query.shiftStart ? String(req.query.shiftStart) : undefined,
  );
  if (!outcome.ok) {
    res.status(400).json({ error: outcome.error });
    return;
  }
  res.json(outcome.body);
});

router.get("/hr/punches/recent", async (req, res): Promise<void> => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const rows = await db
    .select()
    .from(hrAttendancePunchesTable)
    .orderBy(desc(hrAttendancePunchesTable.punchedAt))
    .limit(limit);
  res.json(rows);
});

export default router;

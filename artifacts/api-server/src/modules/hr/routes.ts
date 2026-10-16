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
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  db,
  employeesTable,
  hrEmployeesTable,
  hrAttendanceDevicesTable,
  hrAttendancePunchesTable,
  hrSettingsTable,
} from "@workspace/db";
import { and, eq, gte, lt, lte, desc, asc } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { hrLeaveRequestsTable, hrLeaveTypesTable } from "@workspace/db";

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
  const fullName = str(req.body?.fullName);
  const biometricPin = str(req.body?.biometricPin, 32);
  if (!employeeNo || !EMPNO_RE.test(employeeNo) || !fullName) {
    res.status(400).json({ error: "رقم الموظف والاسم مطلوبان" });
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
        fullName,
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
  if (req.body?.fullName !== undefined) {
    const name = str(req.body.fullName);
    if (!name) {
      res.status(400).json({ error: "الاسم مطلوب" });
      return;
    }
    patch.fullName = name;
  }
  if (req.body?.hireDate !== undefined) {
    // تاريخ التعيين الجديد عند إعادة تعيين موظف مستقيل
    if (!DATE_RE.test(String(req.body.hireDate))) {
      res.status(400).json({ error: "تاريخ التعيين غير صالح" });
      return;
    }
    patch.hireDate = req.body.hireDate;
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

router.get("/hr/attendance", async (req, res): Promise<void> => {
  const date = String(req.query.date ?? "");
  const configured = await loadWorkShift();
  const shiftStart = String(req.query.shiftStart ?? configured?.start ?? "09:00");
  if (!DATE_RE.test(date) || !TIME_RE.test(shiftStart)) {
    res.status(400).json({ error: "تاريخ أو وقت الوردية غير صالح" });
    return;
  }
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

  const byPin = new Map<string, string[]>();
  for (const p of punches) {
    const list = byPin.get(p.pin) ?? [];
    list.push(p.punchedAt.slice(11, 19));
    byPin.set(p.pin, list);
  }
  const shiftMin = minutesOf(`${shiftStart}:00`);
  const graceMin = configured?.lateGraceMinutes ?? 0;

  const rows = employees.map((e) => {
    const times = e.biometricPin ? (byPin.get(e.biometricPin) ?? []) : [];
    const firstIn = times[0] ?? null;
    const lastOut = times.length > 1 ? times[times.length - 1] : null;
    const late = firstIn ? Math.max(0, minutesOf(firstIn) - shiftMin - graceMin) : 0;
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
      absent: times.length === 0 && !leaveByEmp.has(e.id),
    };
  });

  res.json({
    date,
    shiftStart,
    shiftEnd: configured?.end ?? null,
    lateGraceMinutes: graceMin,
    totals: {
      employees: rows.length,
      present: rows.filter((r) => !r.absent).length,
      absent: rows.filter((r) => r.absent).length,
      onLeave: rows.filter((r) => r.onLeave).length,
      late: rows.filter((r) => r.lateMinutes > 0).length,
    },
    rows,
  });
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

/**
 * HR attendance exceptions API — استثناءات الحضور.
 *
 *   GET   /api/hr/attendance-exceptions            all exceptions (with employee names)
 *   PUT   /api/hr/attendance-exceptions/:employeeId  upsert one employee's policy
 *   DELETE /api/hr/attendance-exceptions/:employeeId  remove it (back to company shift)
 *
 * One policy per employee, so the attendance screen always resolves exactly one
 * row. A missing row means the company shift applies — the normal case.
 */
import { Router, type IRouter } from "express";
import { db, hrEmployeesTable, hrAttendanceExceptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import { isHhMm } from "./attendance-exception-logic";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

function str(v: unknown, max = 300): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

router.get("/hr/attendance-exceptions", async (_req, res): Promise<void> => {
  const rows = await db.select().from(hrAttendanceExceptionsTable);
  const emps = await db
    .select({
      id: hrEmployeesTable.id,
      fullName: hrEmployeesTable.fullName,
      employeeNo: hrEmployeesTable.employeeNo,
      department: hrEmployeesTable.department,
    })
    .from(hrEmployeesTable);
  const empMap = new Map(emps.map((e) => [e.id, e]));
  res.json(
    rows.map((r) => ({
      ...r,
      employeeName: empMap.get(r.employeeId)?.fullName ?? "—",
      employeeNo: empMap.get(r.employeeId)?.employeeNo ?? "—",
      department: empMap.get(r.employeeId)?.department ?? null,
    })),
  );
});

router.put("/hr/attendance-exceptions/:employeeId", async (req, res): Promise<void> => {
  const employeeId = Number(req.params.employeeId);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    res.status(400).json({ error: "رقم الموظف غير صالح" });
    return;
  }
  const [emp] = await db
    .select()
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, employeeId))
    .limit(1);
  if (!emp) {
    res.status(404).json({ error: "الموظف غير موجود" });
    return;
  }

  // A blank override means "use the company shift" — stored as NULL, never as
  // an empty string, so the resolution cannot mistake "" for a real time.
  const rawStart = str(req.body?.startTime, 5);
  if (rawStart !== null && !isHhMm(rawStart)) {
    res.status(400).json({ error: "وقت بداية الحضور غير صالح (مثال 11:00)" });
    return;
  }

  let grace: number | null = null;
  if (req.body?.lateGraceMinutes !== undefined && req.body?.lateGraceMinutes !== null) {
    const g = Number(req.body.lateGraceMinutes);
    if (!Number.isInteger(g) || g < 0 || g > 240) {
      res.status(400).json({ error: "الدقائق المسموح بها للتأخير لازم تكون من 0 إلى 240" });
      return;
    }
    grace = g;
  }

  const values = {
    employeeId,
    startTime: rawStart,
    lateGraceMinutes: grace,
    exemptFromPunch: req.body?.exemptFromPunch === true,
    note: str(req.body?.note),
    isActive: req.body?.isActive !== false,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(hrAttendanceExceptionsTable)
    .values(values)
    .onConflictDoUpdate({ target: hrAttendanceExceptionsTable.employeeId, set: values })
    .returning();
  res.json(row);
});

router.delete("/hr/attendance-exceptions/:employeeId", async (req, res): Promise<void> => {
  const employeeId = Number(req.params.employeeId);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    res.status(400).json({ error: "رقم الموظف غير صالح" });
    return;
  }
  const [row] = await db
    .delete(hrAttendanceExceptionsTable)
    .where(eq(hrAttendanceExceptionsTable.employeeId, employeeId))
    .returning();
  if (!row) {
    res.status(404).json({ error: "لا يوجد استثناء لهذا الموظف" });
    return;
  }
  res.json({ ok: true, employeeId });
});

export default router;

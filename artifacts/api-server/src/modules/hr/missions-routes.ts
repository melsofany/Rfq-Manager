/**
 * HR missions API — المأموريات.
 *
 *   GET    /api/hr/missions?status=&employeeId=&from=&to=
 *   POST   /api/hr/missions
 *   PATCH  /api/hr/missions/:id/decision   { decision: "approve" | "reject" }
 *   PATCH  /api/hr/missions/:id/cancel
 *
 * An approved mission excuses the employee from absence (full day) or from
 * lateness inside its window (timed). Approval is a manager decision — the
 * attendance screen reads only `approved` rows.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, hrEmployeesTable, hrMissionsTable } from "@workspace/db";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import { isHhMm, isMissionType, validateMissionWindow, type MissionType } from "./missions-logic";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function sessionEmployeeId(req: Request): number | null {
  const s = (req as Request & { session?: { employeeId?: number } }).session;
  return s?.employeeId ?? null;
}

// ── List ────────────────────────────────────────────────────────────────────
router.get("/hr/missions", async (req, res): Promise<void> => {
  const conds = [];
  if (typeof req.query.status === "string" && req.query.status) {
    conds.push(eq(hrMissionsTable.status, req.query.status));
  }
  const empId = Number(req.query.employeeId);
  if (Number.isInteger(empId) && empId > 0) conds.push(eq(hrMissionsTable.employeeId, empId));
  const from = String(req.query.from ?? "");
  if (DATE_RE.test(from)) conds.push(gte(hrMissionsTable.missionDate, from));
  const to = String(req.query.to ?? "");
  if (DATE_RE.test(to)) conds.push(lte(hrMissionsTable.missionDate, to));

  const rows = await db
    .select()
    .from(hrMissionsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(hrMissionsTable.missionDate), desc(hrMissionsTable.id))
    .limit(500);

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

// ── Create ──────────────────────────────────────────────────────────────────
router.post("/hr/missions", async (req, res): Promise<void> => {
  const employeeId = Number(req.body?.employeeId);
  const missionDate = req.body?.missionDate;
  const missionType = req.body?.missionType ?? "full_day";

  if (!Number.isInteger(employeeId)) {
    res.status(400).json({ error: "الموظف مطلوب" });
    return;
  }
  if (!DATE_RE.test(String(missionDate ?? ""))) {
    res.status(400).json({ error: "تاريخ المأمورية غير صالح" });
    return;
  }
  if (!isMissionType(missionType)) {
    res.status(400).json({ error: "نوع المأمورية غير صالح" });
    return;
  }

  const [emp] = await db
    .select()
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, employeeId))
    .limit(1);
  if (!emp || emp.status !== "active") {
    res.status(400).json({ error: "الموظف غير نشط" });
    return;
  }

  const window = validateMissionWindow(
    missionType as MissionType,
    str(req.body?.startTime, 5),
    str(req.body?.endTime, 5),
  );
  if ("error" in window) {
    res.status(400).json({ error: window.error });
    return;
  }

  // One open request per employee per day keeps the approval list readable;
  // a second request for the same day must be edited or cancelled instead.
  const existing = await db
    .select()
    .from(hrMissionsTable)
    .where(
      and(
        eq(hrMissionsTable.employeeId, employeeId),
        eq(hrMissionsTable.missionDate, String(missionDate)),
        inArray(hrMissionsTable.status, ["pending", "approved"]),
      ),
    );
  if (existing.length) {
    res.status(409).json({ error: "يوجد طلب مأمورية مفتوح لنفس اليوم" });
    return;
  }

  const [row] = await db
    .insert(hrMissionsTable)
    .values({
      employeeId,
      missionDate: String(missionDate),
      missionType,
      startTime: window.startTime,
      endTime: window.endTime,
      destination: str(req.body?.destination, 200),
      reason: str(req.body?.reason, 500),
      createdBy: sessionEmployeeId(req),
    })
    .returning();
  res.status(201).json(row);
});

// ── Decision (manager) ──────────────────────────────────────────────────────
router.patch("/hr/missions/:id/decision", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const decision = req.body?.decision;
  if (decision !== "approve" && decision !== "reject") {
    res.status(400).json({ error: "القرار يجب أن يكون approve أو reject" });
    return;
  }
  const [current] = await db
    .select()
    .from(hrMissionsTable)
    .where(eq(hrMissionsTable.id, id))
    .limit(1);
  if (!current) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  if (current.status !== "pending") {
    res.status(409).json({ error: "تم البت في هذا الطلب بالفعل" });
    return;
  }
  const [row] = await db
    .update(hrMissionsTable)
    .set({
      status: decision === "approve" ? "approved" : "rejected",
      decidedBy: sessionEmployeeId(req),
      decidedAt: new Date(),
    })
    .where(and(eq(hrMissionsTable.id, id), eq(hrMissionsTable.status, "pending")))
    .returning();
  res.json(row);
});

router.patch("/hr/missions/:id/cancel", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [current] = await db
    .select()
    .from(hrMissionsTable)
    .where(eq(hrMissionsTable.id, id))
    .limit(1);
  if (!current) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  if (!["pending", "approved"].includes(current.status)) {
    res.status(409).json({ error: "لا يمكن إلغاء هذا الطلب" });
    return;
  }
  const [row] = await db
    .update(hrMissionsTable)
    .set({ status: "cancelled" })
    .where(eq(hrMissionsTable.id, id))
    .returning();
  res.json(row);
});

export default router;

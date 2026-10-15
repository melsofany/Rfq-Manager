/**
 * HR leave API — أنواع الإجازات، الطلبات، الاعتماد، والرصيد.
 *
 *   GET    /api/hr/leave-types
 *   POST   /api/hr/leave-types
 *   PATCH  /api/hr/leave-types/:id
 *   GET    /api/hr/leave-requests?status=&employeeId=
 *   POST   /api/hr/leave-requests
 *   PATCH  /api/hr/leave-requests/:id/decision   { decision: "approve" | "reject" }
 *   PATCH  /api/hr/leave-requests/:id/cancel
 *   GET    /api/hr/leave-balances?year=YYYY
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, hrEmployeesTable, hrLeaveTypesTable, hrLeaveRequestsTable } from "@workspace/db";
import { and, asc, eq, inArray, desc } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import {
  inclusiveDays,
  rangesOverlap,
  remainingBalance,
  isValidYmd,
  daysInYear,
} from "./leave-logic";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

const CODE_RE = /^[a-z][a-z0-9_]{1,31}$/;

function str(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function sessionEmployeeId(req: Request): number | null {
  const s = (req as Request & { session?: { employeeId?: number } }).session;
  return s?.employeeId ?? null;
}

// ── Leave types ─────────────────────────────────────────────────────────────
router.get("/hr/leave-types", async (_req, res): Promise<void> => {
  res.json(await db.select().from(hrLeaveTypesTable).orderBy(asc(hrLeaveTypesTable.id)));
});

router.post("/hr/leave-types", async (req, res): Promise<void> => {
  const code = str(req.body?.code, 32);
  const nameAr = str(req.body?.nameAr, 100);
  const nameEn = str(req.body?.nameEn, 100);
  const annualDays = Number(req.body?.annualDays ?? 0);
  if (!code || !CODE_RE.test(code) || !nameAr || !nameEn) {
    res.status(400).json({ error: "الكود والاسم بالعربي والإنجليزي مطلوبين" });
    return;
  }
  if (!Number.isInteger(annualDays) || annualDays < 0 || annualDays > 365) {
    res.status(400).json({ error: "عدد الأيام غير صالح" });
    return;
  }
  try {
    const [row] = await db
      .insert(hrLeaveTypesTable)
      .values({
        code,
        nameAr,
        nameEn,
        annualDays,
        paid: req.body?.paid !== false,
        requiresCertificate: req.body?.requiresCertificate === true,
      })
      .returning();
    res.status(201).json(row);
  } catch (err) {
    if (String((err as Error)?.message).includes("unique")) {
      res.status(409).json({ error: "الكود مستخدم بالفعل" });
      return;
    }
    throw err;
  }
});

router.patch("/hr/leave-types/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const patch: Record<string, unknown> = {};
  if (req.body?.nameAr !== undefined) patch.nameAr = str(req.body.nameAr, 100);
  if (req.body?.nameEn !== undefined) patch.nameEn = str(req.body.nameEn, 100);
  if (req.body?.annualDays !== undefined) {
    const n = Number(req.body.annualDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) {
      res.status(400).json({ error: "عدد الأيام غير صالح" });
      return;
    }
    patch.annualDays = n;
  }
  if (typeof req.body?.paid === "boolean") patch.paid = req.body.paid;
  if (typeof req.body?.requiresCertificate === "boolean")
    patch.requiresCertificate = req.body.requiresCertificate;
  if (typeof req.body?.isActive === "boolean") patch.isActive = req.body.isActive;
  if (!Object.keys(patch).length) {
    res.status(400).json({ error: "لا توجد تغييرات" });
    return;
  }
  const [row] = await db
    .update(hrLeaveTypesTable)
    .set(patch)
    .where(eq(hrLeaveTypesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  res.json(row);
});

// ── Requests ────────────────────────────────────────────────────────────────
router.get("/hr/leave-requests", async (req, res): Promise<void> => {
  const conds = [];
  if (typeof req.query.status === "string" && req.query.status) {
    conds.push(eq(hrLeaveRequestsTable.status, req.query.status));
  }
  const empId = Number(req.query.employeeId);
  if (Number.isInteger(empId) && empId > 0) conds.push(eq(hrLeaveRequestsTable.employeeId, empId));
  const rows = await db
    .select()
    .from(hrLeaveRequestsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(hrLeaveRequestsTable.startDate))
    .limit(500);
  const emps = await db
    .select({
      id: hrEmployeesTable.id,
      fullName: hrEmployeesTable.fullName,
      employeeNo: hrEmployeesTable.employeeNo,
    })
    .from(hrEmployeesTable);
  const types = await db.select().from(hrLeaveTypesTable);
  const empMap = new Map(emps.map((e) => [e.id, e]));
  const typeMap = new Map(types.map((t) => [t.id, t]));
  res.json(
    rows.map((r) => ({
      ...r,
      employeeName: empMap.get(r.employeeId)?.fullName ?? "—",
      employeeNo: empMap.get(r.employeeId)?.employeeNo ?? "—",
      leaveNameAr: typeMap.get(r.leaveTypeId)?.nameAr ?? "—",
      leaveNameEn: typeMap.get(r.leaveTypeId)?.nameEn ?? "—",
    })),
  );
});

router.post("/hr/leave-requests", async (req, res): Promise<void> => {
  const employeeId = Number(req.body?.employeeId);
  const leaveTypeId = Number(req.body?.leaveTypeId);
  const startDate = req.body?.startDate;
  const endDate = req.body?.endDate;
  if (!Number.isInteger(employeeId) || !Number.isInteger(leaveTypeId)) {
    res.status(400).json({ error: "الموظف ونوع الإجازة مطلوبين" });
    return;
  }
  if (!isValidYmd(startDate) || !isValidYmd(endDate) || endDate < startDate) {
    res.status(400).json({ error: "تواريخ غير صالحة" });
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
  const [type] = await db
    .select()
    .from(hrLeaveTypesTable)
    .where(eq(hrLeaveTypesTable.id, leaveTypeId))
    .limit(1);
  if (!type || !type.isActive) {
    res.status(400).json({ error: "نوع الإجازة غير متاح" });
    return;
  }
  const certificateNote = str(req.body?.certificateNote, 500);
  if (type.requiresCertificate && !certificateNote) {
    res.status(400).json({ error: "هذا النوع يحتاج شهادة طبية (رقم أو ملاحظة)" });
    return;
  }

  const days = inclusiveDays(startDate, endDate);
  const existing = await db
    .select()
    .from(hrLeaveRequestsTable)
    .where(
      and(
        eq(hrLeaveRequestsTable.employeeId, employeeId),
        inArray(hrLeaveRequestsTable.status, ["pending", "approved"]),
      ),
    );
  if (existing.some((r) => rangesOverlap(r.startDate, r.endDate, startDate, endDate))) {
    res.status(409).json({ error: "يوجد طلب إجازة متداخل مع هذه الفترة" });
    return;
  }

  if (type.annualDays > 0 && type.paid) {
    const year = Number(startDate.slice(0, 4));
    const used = existing
      .filter((r) => r.leaveTypeId === leaveTypeId)
      .reduce((sum, r) => sum + daysInYear(r.startDate, r.endDate, year), 0);
    const remaining = remainingBalance(type.annualDays, used);
    if (days > remaining) {
      res.status(400).json({ error: `الرصيد غير كافٍ (المتاح ${remaining} يوم)` });
      return;
    }
  }

  const [row] = await db
    .insert(hrLeaveRequestsTable)
    .values({
      employeeId,
      leaveTypeId,
      startDate,
      endDate,
      days: String(days),
      reason: str(req.body?.reason, 500),
      certificateNote,
    })
    .returning();
  res.status(201).json(row);
});

router.patch("/hr/leave-requests/:id/decision", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const decision = req.body?.decision;
  if (decision !== "approve" && decision !== "reject") {
    res.status(400).json({ error: "القرار يجب أن يكون approve أو reject" });
    return;
  }
  const [current] = await db
    .select()
    .from(hrLeaveRequestsTable)
    .where(eq(hrLeaveRequestsTable.id, id))
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
    .update(hrLeaveRequestsTable)
    .set({
      status: decision === "approve" ? "approved" : "rejected",
      decidedBy: sessionEmployeeId(req),
      decidedAt: new Date(),
    })
    .where(and(eq(hrLeaveRequestsTable.id, id), eq(hrLeaveRequestsTable.status, "pending")))
    .returning();
  res.json(row);
});

router.patch("/hr/leave-requests/:id/cancel", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [current] = await db
    .select()
    .from(hrLeaveRequestsTable)
    .where(eq(hrLeaveRequestsTable.id, id))
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
    .update(hrLeaveRequestsTable)
    .set({ status: "cancelled" })
    .where(eq(hrLeaveRequestsTable.id, id))
    .returning();
  res.json(row);
});

// ── Balances ────────────────────────────────────────────────────────────────
router.get("/hr/leave-balances", async (req, res): Promise<void> => {
  const year = Number(req.query.year) || new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    res.status(400).json({ error: "سنة غير صالحة" });
    return;
  }
  const emps = await db
    .select()
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.status, "active"));
  const types = (
    await db.select().from(hrLeaveTypesTable).where(eq(hrLeaveTypesTable.isActive, true))
  ).filter((t) => t.annualDays > 0);
  const reqs = await db
    .select()
    .from(hrLeaveRequestsTable)
    .where(inArray(hrLeaveRequestsTable.status, ["approved", "pending"]));

  const rows = emps.map((e) => ({
    employeeId: e.id,
    employeeNo: e.employeeNo,
    fullName: e.fullName,
    balances: types.map((t) => {
      const mine = reqs.filter((r) => r.employeeId === e.id && r.leaveTypeId === t.id);
      const used = mine
        .filter((r) => r.status === "approved")
        .reduce((s, r) => s + daysInYear(r.startDate, r.endDate, year), 0);
      const pending = mine
        .filter((r) => r.status === "pending")
        .reduce((s, r) => s + daysInYear(r.startDate, r.endDate, year), 0);
      return {
        leaveTypeId: t.id,
        code: t.code,
        nameAr: t.nameAr,
        allocated: t.annualDays,
        used,
        pending,
        remaining: remainingBalance(t.annualDays, used + pending),
      };
    }),
  }));
  res.json({
    year,
    types: types.map((t) => ({ id: t.id, nameAr: t.nameAr, nameEn: t.nameEn })),
    rows,
  });
});

export default router;

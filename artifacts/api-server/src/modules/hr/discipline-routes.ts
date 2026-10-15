/**
 * Disciplinary cases and pay adjustments.
 *
 *   GET    /api/hr/cases?employeeId=
 *   POST   /api/hr/cases
 *   GET    /api/hr/cases/:id                 (case + investigation log)
 *   POST   /api/hr/cases/:id/notes           append to investigation log
 *   PATCH  /api/hr/cases/:id/status          { status, penaltyType?, penaltyAmount?, decision? }
 *   GET    /api/hr/pay-adjustments?period=YYYY-MM
 *   POST   /api/hr/pay-adjustments
 *   DELETE /api/hr/pay-adjustments/:id
 */
import { Router, type IRouter, type Request } from "express";
import {
  db,
  hrEmployeesTable,
  hrDisciplinaryCasesTable,
  hrCaseNotesTable,
  hrPayAdjustmentsTable,
} from "@workspace/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import {
  canTransition,
  isValidPeriod,
  parseMoney,
  PENALTY_TYPES,
  ADJUSTMENT_KINDS,
  CASE_STATUSES,
} from "./discipline-logic";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

function sessionEmployeeId(req: Request): number | null {
  const s = (req as Request & { session?: { employeeId?: number } }).session;
  return s?.employeeId ?? null;
}
function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseId(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── Cases ───────────────────────────────────────────────────────────────────
router.get("/hr/cases", async (req, res): Promise<void> => {
  const empId = Number(req.query.employeeId);
  const rows = await db
    .select()
    .from(hrDisciplinaryCasesTable)
    .where(
      Number.isInteger(empId) && empId > 0
        ? eq(hrDisciplinaryCasesTable.employeeId, empId)
        : undefined,
    )
    .orderBy(desc(hrDisciplinaryCasesTable.createdAt))
    .limit(300);
  res.json(rows);
});

router.post("/hr/cases", async (req, res): Promise<void> => {
  const employeeId = Number(req.body?.employeeId);
  const title = str(req.body?.title, 200);
  const incidentDate = req.body?.incidentDate;
  if (!Number.isInteger(employeeId) || !title || !DATE_RE.test(incidentDate ?? "")) {
    res.status(400).json({ error: "الموظف والعنوان وتاريخ الواقعة مطلوبين" });
    return;
  }
  const [emp] = await db
    .select({ id: hrEmployeesTable.id })
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, employeeId))
    .limit(1);
  if (!emp) {
    res.status(404).json({ error: "الموظف غير موجود" });
    return;
  }
  const [row] = await db
    .insert(hrDisciplinaryCasesTable)
    .values({
      employeeId,
      title,
      description: str(req.body?.description, 4000),
      incidentDate,
      createdBy: sessionEmployeeId(req),
    })
    .returning();
  res.status(201).json(row);
});

router.get("/hr/cases/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  const [c] = await db
    .select()
    .from(hrDisciplinaryCasesTable)
    .where(eq(hrDisciplinaryCasesTable.id, id))
    .limit(1);
  if (!c) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  const notes = await db
    .select()
    .from(hrCaseNotesTable)
    .where(eq(hrCaseNotesTable.caseId, id))
    .orderBy(asc(hrCaseNotesTable.createdAt));
  res.json({ ...c, notes });
});

router.post("/hr/cases/:id/notes", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const body = str(req.body?.body, 4000);
  const kind = ["note", "statement", "witness", "evidence"].includes(req.body?.kind)
    ? req.body.kind
    : "note";
  if (!id || !body) {
    res.status(400).json({ error: "النص مطلوب" });
    return;
  }
  const [c] = await db
    .select({ status: hrDisciplinaryCasesTable.status })
    .from(hrDisciplinaryCasesTable)
    .where(eq(hrDisciplinaryCasesTable.id, id))
    .limit(1);
  if (!c) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  if (c.status === "closed") {
    res.status(409).json({ error: "القضية مغلقة" });
    return;
  }
  const [row] = await db
    .insert(hrCaseNotesTable)
    .values({ caseId: id, kind, body, byEmployee: sessionEmployeeId(req) })
    .returning();
  res.status(201).json(row);
});

router.patch("/hr/cases/:id/status", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const to = req.body?.status;
  if (!id || !(CASE_STATUSES as readonly string[]).includes(to)) {
    res.status(400).json({ error: "حالة غير صالحة" });
    return;
  }
  const [c] = await db
    .select()
    .from(hrDisciplinaryCasesTable)
    .where(eq(hrDisciplinaryCasesTable.id, id))
    .limit(1);
  if (!c) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  if (!canTransition(c.status, to)) {
    res.status(409).json({ error: `لا يمكن الانتقال من ${c.status} إلى ${to}` });
    return;
  }
  const patch: Record<string, unknown> = { status: to };
  if (to === "decided") {
    const pType = req.body?.penaltyType ?? null;
    if (pType !== null && !(PENALTY_TYPES as readonly string[]).includes(pType)) {
      res.status(400).json({ error: "نوع الجزاء غير صالح" });
      return;
    }
    const amount =
      req.body?.penaltyAmount === undefined ||
      req.body?.penaltyAmount === null ||
      req.body?.penaltyAmount === ""
        ? null
        : parseMoney(req.body.penaltyAmount);
    if (pType === "fine" && (amount === null || amount <= 0)) {
      res.status(400).json({ error: "الغرامة تحتاج مبلغاً أكبر من صفر" });
      return;
    }
    if (pType !== "fine" && amount !== null && amount > 0) {
      res.status(400).json({ error: "المبلغ يُدخل للغرامة فقط" });
      return;
    }
    const decision = str(req.body?.decision, 4000);
    if (!decision) {
      res.status(400).json({ error: "نص القرار مطلوب" });
      return;
    }
    patch.penaltyType = pType;
    patch.penaltyAmount = amount === null ? null : String(amount);
    patch.decision = decision;
    patch.decidedAt = new Date();
  }
  const [row] = await db
    .update(hrDisciplinaryCasesTable)
    .set(patch)
    .where(eq(hrDisciplinaryCasesTable.id, id))
    .returning();
  res.json(row);
});

// ── Pay adjustments ─────────────────────────────────────────────────────────
router.get("/hr/pay-adjustments", async (req, res): Promise<void> => {
  const period = String(req.query.period ?? "");
  if (!isValidPeriod(period)) {
    res.status(400).json({ error: "الفترة يجب أن تكون YYYY-MM" });
    return;
  }
  const rows = await db
    .select()
    .from(hrPayAdjustmentsTable)
    .where(eq(hrPayAdjustmentsTable.period, period))
    .orderBy(asc(hrPayAdjustmentsTable.employeeId));
  res.json(rows);
});

router.post("/hr/pay-adjustments", async (req, res): Promise<void> => {
  const employeeId = Number(req.body?.employeeId);
  const kind = req.body?.kind;
  const amount = parseMoney(req.body?.amount);
  const period = req.body?.period;
  if (!Number.isInteger(employeeId) || !(ADJUSTMENT_KINDS as readonly string[]).includes(kind)) {
    res.status(400).json({ error: "الموظف ونوع الحركة مطلوبين" });
    return;
  }
  if (amount === null || amount <= 0) {
    res.status(400).json({ error: "المبلغ يجب أن يكون أكبر من صفر (بحد أقصى منزلتين عشريتين)" });
    return;
  }
  if (!isValidPeriod(period)) {
    res.status(400).json({ error: "الفترة يجب أن تكون YYYY-MM" });
    return;
  }
  const caseId = req.body?.caseId ? parseId(String(req.body.caseId)) : null;
  const [row] = await db
    .insert(hrPayAdjustmentsTable)
    .values({
      employeeId,
      kind,
      amount: String(amount),
      period,
      reason: str(req.body?.reason, 500),
      caseId,
      createdBy: sessionEmployeeId(req),
    })
    .returning();
  res.status(201).json(row);
});

router.delete("/hr/pay-adjustments/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  const [row] = await db
    .delete(hrPayAdjustmentsTable)
    .where(eq(hrPayAdjustmentsTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  res.json({ ok: true });
});

export default router;

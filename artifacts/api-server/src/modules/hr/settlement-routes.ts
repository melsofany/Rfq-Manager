/**
 * Final settlement API — تسوية نهاية الخدمة.
 *
 *   POST /api/hr/employees/:id/settlements    { exitDate, reason, eligibilityPct?, deductions? } calculates a draft
 *   GET  /api/hr/settlements                  list
 *   POST /api/hr/settlements/:id/approve      ends the employment, cancels pending leave
 */
import { Router, type IRouter } from "express";
import {
  db,
  hrEmployeesTable,
  hrContractsTable,
  hrSettingsTable,
  hrLeaveTypesTable,
  hrLeaveRequestsTable,
  hrSettlementsTable,
  hrPayrollRunsTable,
  hrPayslipsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import { isValidYmd, daysInYear, remainingBalance } from "./leave-logic";
import {
  computeSettlement,
  eligibilityForYears,
  EXIT_REASONS,
  serviceYears,
  type EndOfServiceRule,
  type ExitReason,
} from "./settlement-logic";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

const num = (v: unknown) => Number(v ?? 0);

async function setting(key: string): Promise<unknown> {
  const [row] = await db
    .select()
    .from(hrSettingsTable)
    .where(eq(hrSettingsTable.key, key))
    .limit(1);
  return row?.value ?? null;
}

router.post("/hr/employees/:id/settlements", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  const exitDate = String(req.body?.exitDate ?? "");
  const reason = String(req.body?.reason ?? "") as ExitReason;
  if (!isValidYmd(exitDate)) {
    res.status(400).json({ error: "تاريخ الخروج غير صالح" });
    return;
  }
  if (!(EXIT_REASONS as readonly string[]).includes(reason)) {
    res.status(400).json({ error: "سبب الخروج غير صالح" });
    return;
  }
  // Optional manual override. Without it, the percentage comes from Settings for this exit reason.
  const overridePct =
    req.body?.eligibilityPct === undefined || req.body?.eligibilityPct === null
      ? null
      : Number(req.body.eligibilityPct);
  if (
    overridePct !== null &&
    (!Number.isFinite(overridePct) || overridePct < 0 || overridePct > 100)
  ) {
    res.status(400).json({ error: "نسبة الاستحقاق لازم تكون من 0 إلى 100" });
    return;
  }
  const deductions = req.body?.deductions === undefined ? 0 : Number(req.body.deductions);
  if (!Number.isFinite(deductions) || deductions < 0) {
    res.status(400).json({ error: "الخصومات لازم تكون رقم موجب" });
    return;
  }

  const absence = (await setting("absence")) as { dailyDivisor: number } | null;
  const eos = (await setting("end_of_service")) as EndOfServiceRule | null;
  const missing = [
    !absence && "absence",
    (!eos || !eos.eligibilityByReason) && "end_of_service",
  ].filter(Boolean);
  if (missing.length) {
    res.status(400).json({ error: "إعدادات ناقصة قبل التسوية", missing });
    return;
  }
  const eligibilitySource = overridePct === null ? "setting" : "manual";

  const [emp] = await db
    .select()
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, id))
    .limit(1);
  if (!emp) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  if (emp.status !== "active") {
    res.status(409).json({ error: "الموظف مش نشط، التسوية لا تتعمل إلا للموظف النشط" });
    return;
  }
  if (!emp.hireDate) {
    res.status(400).json({ error: "تاريخ تعيين الموظف مش مسجل" });
    return;
  }
  if (exitDate < emp.hireDate) {
    res.status(400).json({ error: "تاريخ الخروج قبل تاريخ التعيين" });
    return;
  }

  const [contract] = await db
    .select()
    .from(hrContractsTable)
    .where(and(eq(hrContractsTable.employeeId, id), eq(hrContractsTable.isCurrent, true)))
    .limit(1);
  if (!contract) {
    res.status(400).json({ error: "الموظف مالوش عقد حالي" });
    return;
  }
  // Share comes from the exit reason's band for this service length, unless HR entered an override.
  const band = eligibilityForYears(
    eos!.eligibilityByReason[reason],
    serviceYears(emp.hireDate, exitDate),
  );
  const eligibilityPct = overridePct ?? band.pct;

  // رصيد الإجازة السنوية المتبقي في سنة الخروج
  const year = Number(exitDate.slice(0, 4));
  const [annualType] = await db
    .select()
    .from(hrLeaveTypesTable)
    .where(eq(hrLeaveTypesTable.code, "annual"))
    .limit(1);
  const approved = await db
    .select()
    .from(hrLeaveRequestsTable)
    .where(
      and(eq(hrLeaveRequestsTable.employeeId, id), eq(hrLeaveRequestsTable.status, "approved")),
    );
  const usedThisYear = approved.reduce(
    (acc, r) => acc + daysInYear(r.startDate, r.endDate, year),
    0,
  );
  const unusedLeaveDays = remainingBalance(annualType?.annualDays ?? 0, usedThisYear);

  // لو مرتب شهر الخروج اتحسب وفيه الموظف، الأيام دي متدفعتش تاني في التسوية
  const exitMonth = exitDate.slice(0, 7);
  const [exitRun] = await db
    .select({ id: hrPayrollRunsTable.id })
    .from(hrPayrollRunsTable)
    .where(eq(hrPayrollRunsTable.period, exitMonth))
    .limit(1);
  let finalSalaryPaid = false;
  if (exitRun) {
    const [slip] = await db
      .select({ id: hrPayslipsTable.id })
      .from(hrPayslipsTable)
      .where(and(eq(hrPayslipsTable.runId, exitRun.id), eq(hrPayslipsTable.employeeId, id)))
      .limit(1);
    finalSalaryPaid = !!slip;
  }

  const result = computeSettlement({
    hireDate: emp.hireDate,
    exitDate,
    reason,
    basic: num(contract.basicSalary),
    allowances: num(contract.allowances),
    divisor: absence!.dailyDivisor,
    rule: eos!,
    eligibilityPct,
    unusedLeaveDays,
    deductions,
    finalSalaryPaid,
  });

  const [locked] = await db
    .select({ id: hrSettlementsTable.id })
    .from(hrSettlementsTable)
    .where(and(eq(hrSettlementsTable.employeeId, id), eq(hrSettlementsTable.status, "approved")))
    .limit(1);
  if (locked) {
    res.status(409).json({ error: "الموظف ده ليه تسوية معتمدة بالفعل" });
    return;
  }

  const inputs = {
    exitDate,
    reason,
    eligibilityPct,
    deductions,
    annualDaysAllocated: annualType?.annualDays ?? 0,
    usedThisYear,
    finalSalaryPaidInPayroll: finalSalaryPaid,
  };
  const created = await db.transaction(async (tx) => {
    await tx
      .delete(hrSettlementsTable)
      .where(and(eq(hrSettlementsTable.employeeId, id), eq(hrSettlementsTable.status, "draft")));
    const [row] = await tx
      .insert(hrSettlementsTable)
      .values({
        employeeId: id,
        exitDate,
        reason,
        status: "draft",
        total: String(result.total),
        details: {
          inputs,
          result,
          settingsUsed: {
            absence,
            endOfService: eos,
            eligibilitySource,
            eligibilityBandFromYears: band.fromYears,
          },
        },
      })
      .returning();
    return row;
  });
  res.status(201).json({ id: created.id, status: "draft", result });
});

router.get("/hr/settlements", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: hrSettlementsTable.id,
      employeeId: hrSettlementsTable.employeeId,
      name: hrEmployeesTable.fullName,
      exitDate: hrSettlementsTable.exitDate,
      reason: hrSettlementsTable.reason,
      status: hrSettlementsTable.status,
      total: hrSettlementsTable.total,
      details: hrSettlementsTable.details,
    })
    .from(hrSettlementsTable)
    .innerJoin(hrEmployeesTable, eq(hrEmployeesTable.id, hrSettlementsTable.employeeId))
    .orderBy(desc(hrSettlementsTable.id));
  res.json(rows.map((r) => ({ ...r, total: num(r.total) })));
});

router.post("/hr/settlements/:id/approve", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [s] = await db
    .select()
    .from(hrSettlementsTable)
    .where(eq(hrSettlementsTable.id, id))
    .limit(1);
  if (!s) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  if (s.status !== "draft") {
    res.status(409).json({ error: "التسوية معتمدة بالفعل" });
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(hrSettlementsTable)
      .set({ status: "approved", approvedAt: new Date() })
      .where(eq(hrSettlementsTable.id, id));
    await tx
      .update(hrEmployeesTable)
      .set({
        status: s.reason === "resignation" ? "resigned" : "terminated",
        updatedAt: new Date(),
      })
      .where(eq(hrEmployeesTable.id, s.employeeId));
    await tx
      .update(hrLeaveRequestsTable)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(hrLeaveRequestsTable.employeeId, s.employeeId),
          eq(hrLeaveRequestsTable.status, "pending"),
        ),
      );
  });
  res.json({ ok: true });
});

export default router;

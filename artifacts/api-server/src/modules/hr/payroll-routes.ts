/**
 * Payroll API — مسير الرواتب الشهري.
 *
 *   GET    /api/hr/payroll/runs?period=YYYY-MM   list runs
 *   GET    /api/hr/payroll/runs/:id              run with payslips
 *   POST   /api/hr/payroll/runs                  { period } calculates a draft (absence days come from attendance)
 *   POST   /api/hr/payroll/runs/:id/approve      locks the run and sends payslips on WhatsApp
 *   POST   /api/hr/payroll/runs/:id/send-payslips  (re)send payslips to employees
 *   DELETE /api/hr/payroll/runs/:id              deletes a draft only
 */
import { Router, type IRouter } from "express";
import {
  db,
  hrEmployeesTable,
  hrContractsTable,
  hrPayAdjustmentsTable,
  hrDisciplinaryCasesTable,
  hrSettingsTable,
  hrPayrollRunsTable,
  hrPayslipsTable,
  hrProductionCreditsTable,
  employeesTable,
} from "@workspace/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import { isValidPeriod } from "./discipline-logic";
import { computeProductionIncentive, type ProductionIncentiveResult } from "./production-incentive";
import { buildAttendance } from "./routes";
import { deliverPayslips } from "./payroll-delivery";
import { logger } from "../../shared/logger";
import {
  computePayslip,
  missingPayrollSettings,
  withMissingPayrollSettingsAsDefaults,
  absenceDates,
  round2,
  type PayrollSettings,
} from "./payroll-logic";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

const num = (v: unknown) => Number(v ?? 0);

async function loadSettings(): Promise<{
  settings: PayrollSettings;
  raw: Record<string, unknown>;
}> {
  const rows = await db.select().from(hrSettingsTable);
  const raw: Record<string, unknown> = {};
  for (const r of rows) raw[r.key] = r.value;
  const settings: PayrollSettings = {
    social: (raw.social_insurance as PayrollSettings["social"]) ?? null,
    health: (raw.health_insurance as PayrollSettings["health"]) ?? null,
    tax: (raw.income_tax as PayrollSettings["tax"]) ?? null,
    absence: (raw.absence as PayrollSettings["absence"]) ?? null,
    fines: (raw.fines as PayrollSettings["fines"]) ?? null,
  };
  return { settings, raw };
}

/** Today in Cairo as YYYY-MM-DD (the business calendar, not UTC). */
function cairoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/**
 * Absent days per employee for the month, taken from the attendance rule
 * (buildAttendance), so payroll and the attendance screen always agree.
 * Only days the employee could work count: after hire, not in the future,
 * and not a weekly day off.
 */
async function countAbsenceDays(
  employees: { id: number; hireDate: string | null }[],
  period: string,
  weeklyOffDays: number[],
): Promise<Record<number, number>> {
  const today = cairoToday();
  const expected = new Map(
    employees.map((e) => [e.id, new Set(absenceDates(period, e.hireDate, today, weeklyOffDays))]),
  );
  const allDates = [...new Set([...expected.values()].flatMap((set) => [...set]))].sort();
  const out: Record<number, number> = {};
  for (const e of employees) out[e.id] = 0;
  for (const date of allDates) {
    const outcome = await buildAttendance(date, undefined);
    if (!outcome.ok) throw new Error(outcome.error);
    const rows = outcome.body.rows as { employeeId: number; absent: boolean }[];
    for (const row of rows) {
      if (row.absent && expected.get(row.employeeId)?.has(date)) out[row.employeeId] += 1;
    }
  }
  return out;
}

router.get("/hr/payroll/runs", async (req, res): Promise<void> => {
  const period = req.query.period ? String(req.query.period) : null;
  if (period && !isValidPeriod(period)) {
    res.status(400).json({ error: "الفترة يجب أن تكون YYYY-MM" });
    return;
  }
  const runs = await db
    .select()
    .from(hrPayrollRunsTable)
    .where(period ? eq(hrPayrollRunsTable.period, period) : undefined)
    .orderBy(desc(hrPayrollRunsTable.period));
  const slips = runs.length
    ? await db
        .select()
        .from(hrPayslipsTable)
        .where(
          inArray(
            hrPayslipsTable.runId,
            runs.map((r) => r.id),
          ),
        )
    : [];
  res.json(
    runs.map((r) => {
      const mine = slips.filter((s) => s.runId === r.id);
      return {
        id: r.id,
        period: r.period,
        status: r.status,
        employees: mine.length,
        totalNet: round2(mine.reduce((a, s) => a + num(s.net), 0)),
        approvedAt: r.approvedAt,
      };
    }),
  );
});

router.get("/hr/payroll/runs/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  const [run] = await db
    .select()
    .from(hrPayrollRunsTable)
    .where(eq(hrPayrollRunsTable.id, id))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  const slips = await db
    .select({
      slip: hrPayslipsTable,
      name: hrEmployeesTable.fullName,
      employeeNo: hrEmployeesTable.employeeNo,
      hasPhone: sql<boolean>`(${hrEmployeesTable.phone} IS NOT NULL AND btrim(${hrEmployeesTable.phone}) <> '')`,
    })
    .from(hrPayslipsTable)
    .innerJoin(hrEmployeesTable, eq(hrEmployeesTable.id, hrPayslipsTable.employeeId))
    .where(eq(hrPayslipsTable.runId, id));
  res.json({
    run: { id: run.id, period: run.period, status: run.status, approvedAt: run.approvedAt },
    payslips: slips.map(({ slip: s, name, employeeNo, hasPhone }) => ({
      id: s.id,
      employeeId: s.employeeId,
      employeeNo,
      name,
      basic: num(s.basicSalary),
      allowances: num(s.allowances),
      bonuses: num(s.bonuses),
      incentives: num(s.incentives),
      deductions: num(s.deductions),
      absenceDays: s.absenceDays,
      absenceAmount: num(s.absenceAmount),
      finesApplied: num(s.finesApplied),
      finesDeferred: num(s.finesDeferred),
      socialEmployee: num(s.socialEmployee),
      healthEmployee: num(s.healthEmployee),
      incomeTax: num(s.incomeTax),
      gross: num(s.gross),
      net: num(s.net),
      // WhatsApp delivery of this employee's payslip. Never surfaced on the
      // shared /whatsapp screen — only here, behind the HR permission.
      deliveryStatus: s.deliveryStatus,
      deliveredAt: s.deliveredAt,
      deliveryError: s.deliveryError,
      hasPhone,
    })),
  });
});

router.post("/hr/payroll/runs", async (req, res): Promise<void> => {
  const period = String(req.body?.period ?? "");
  if (!isValidPeriod(period)) {
    res.status(400).json({ error: "الفترة يجب أن تكون YYYY-MM" });
    return;
  }
  const { settings: stored, raw } = await loadSettings();
  // Missing settings don't block the run anymore; they count as defaults and the run records them.
  const missingSettings = missingPayrollSettings(stored);
  const settings = withMissingPayrollSettingsAsDefaults(stored);

  const employees = await db
    .select({
      id: hrEmployeesTable.id,
      fullName: hrEmployeesTable.fullName,
      hireDate: hrEmployeesTable.hireDate,
      procurementEmployeeId: hrEmployeesTable.procurementEmployeeId,
    })
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.status, "active"));
  if (!employees.length) {
    res.status(400).json({ error: "مفيش موظفين نشطين للحساب" });
    return;
  }
  const ids = employees.map((e) => e.id);
  const absence = await countAbsenceDays(employees, period, settings.absence!.weeklyOffDays);

  const contracts = await db
    .select()
    .from(hrContractsTable)
    .where(and(inArray(hrContractsTable.employeeId, ids), eq(hrContractsTable.isCurrent, true)));
  const missingContract = ids.filter((id) => !contracts.some((c) => c.employeeId === id));
  if (missingContract.length) {
    const names = employees.filter((e) => missingContract.includes(e.id)).map((e) => e.fullName);
    res.status(400).json({ error: "موظفين بدون عقد حالي", employees: names });
    return;
  }

  const adjustments = await db
    .select()
    .from(hrPayAdjustmentsTable)
    .where(
      and(eq(hrPayAdjustmentsTable.period, period), inArray(hrPayAdjustmentsTable.employeeId, ids)),
    );

  const cases = await db
    .select()
    .from(hrDisciplinaryCasesTable)
    .where(
      and(
        inArray(hrDisciplinaryCasesTable.employeeId, ids),
        eq(hrDisciplinaryCasesTable.penaltyType, "fine"),
      ),
    );

  // Production incentive (حافز الإنتاج) for employees linked to a procurement account. It replaces
  // the fixed contract incentive for them; manual incentive adjustments still apply on top.
  const productionByEmp = new Map<number, number>();
  for (const e of employees) {
    if (e.procurementEmployeeId == null) continue;
    const c = contracts.find((x) => x.employeeId === e.id)!;
    const prod = await computeProductionIncentive({
      hrEmployeeId: e.id,
      procurementEmployeeId: e.procurementEmployeeId,
      runPeriod: period,
      contractIncentive: num(c.incentive),
    });
    productionByEmp.set(e.id, prod.total);
  }

  const rows = ids.map((employeeId) => {
    const c = contracts.find((x) => x.employeeId === employeeId)!;
    const mine = adjustments.filter((a) => a.employeeId === employeeId);
    const sumKind = (kind: string) =>
      mine.filter((a) => a.kind === kind).reduce((acc, a) => acc + num(a.amount), 0);
    // Day-based bonuses are worth days × (basic ÷ divisor), at the rate of this payroll month.
    const dailyRate = round2(num(c.basicSalary) / settings.absence!.dailyDivisor);
    const daysBonus = mine
      .filter((a) => a.kind === "bonus" && a.days !== null)
      .reduce((acc, a) => acc + num(a.days), 0);
    const finesTotal = cases
      .filter(
        (k) =>
          k.employeeId === employeeId &&
          k.decidedAt &&
          new Date(k.decidedAt).toISOString().slice(0, 7) === period,
      )
      .reduce((acc, k) => acc + num(k.penaltyAmount), 0);
    const calc = computePayslip(
      {
        basic: num(c.basicSalary),
        allowances: num(c.allowances),
        bonuses: sumKind("bonus") + round2(daysBonus * dailyRate),
        incentives:
          (productionByEmp.has(employeeId) ? productionByEmp.get(employeeId)! : num(c.incentive)) +
          sumKind("incentive"),
        deductions: sumKind("deduction"),
        absenceDays: absence[employeeId],
        finesTotal,
      },
      settings,
    );
    return { employeeId, calc };
  });
  const negative = rows.filter((r) => r.calc.net < 0).map((r) => r.employeeId);
  if (negative.length) {
    const names = employees.filter((e) => negative.includes(e.id)).map((e) => e.fullName);
    res
      .status(400)
      .json({ error: "صافي الراتب سالب لموظفين — راجع الخصومات والغياب", employees: names });
    return;
  }

  try {
    const run = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(hrPayrollRunsTable)
        .where(eq(hrPayrollRunsTable.period, period))
        .limit(1);
      if (existing?.status === "approved")
        throw new PayrollRejected("مسير الشهر ده معتمد بالفعل ومقفول");
      if (existing) {
        await tx.delete(hrPayslipsTable).where(eq(hrPayslipsTable.runId, existing.id));
        await tx.delete(hrPayrollRunsTable).where(eq(hrPayrollRunsTable.id, existing.id));
      }
      const [created] = await tx
        .insert(hrPayrollRunsTable)
        .values({
          period,
          status: "draft",
          settingsSnapshot: { ...raw, missingAtRun: missingSettings },
        })
        .returning();
      await tx.insert(hrPayslipsTable).values(
        rows.map(({ employeeId, calc }) => ({
          runId: created.id,
          employeeId,
          basicSalary: String(calc.basic),
          allowances: String(calc.allowances),
          bonuses: String(calc.bonuses),
          incentives: String(calc.incentives),
          deductions: String(calc.deductions),
          absenceDays: calc.absenceDays,
          absenceAmount: String(calc.absenceAmount),
          finesApplied: String(calc.finesApplied),
          finesDeferred: String(calc.finesDeferred),
          socialEmployee: String(calc.socialEmployee),
          healthEmployee: String(calc.healthEmployee),
          incomeTax: String(calc.incomeTax),
          gross: String(calc.gross),
          net: String(calc.net),
        })),
      );
      return created;
    });
    res.status(201).json({
      id: run.id,
      period,
      status: "draft",
      employees: rows.length,
      missingSettings,
    });
  } catch (err) {
    if (err instanceof PayrollRejected) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

class PayrollRejected extends Error {}

router.post("/hr/payroll/runs/:id/approve", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [run] = await db
    .select()
    .from(hrPayrollRunsTable)
    .where(eq(hrPayrollRunsTable.id, id))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  if (run.status !== "draft") {
    res.status(409).json({ error: "المسير معتمد بالفعل" });
    return;
  }

  // Recompute production incentive for linked employees right before approval. If the payslip no
  // longer matches, the draft is stale and must be recalculated first.
  const slips = await db.select().from(hrPayslipsTable).where(eq(hrPayslipsTable.runId, id));
  const linked = await db
    .select({
      id: hrEmployeesTable.id,
      fullName: hrEmployeesTable.fullName,
      procurementEmployeeId: hrEmployeesTable.procurementEmployeeId,
    })
    .from(hrEmployeesTable)
    .where(
      and(
        inArray(
          hrEmployeesTable.id,
          slips.map((s) => s.employeeId),
        ),
        isNotNull(hrEmployeesTable.procurementEmployeeId),
      ),
    );
  const linkedIds = linked.map((e) => e.id);
  const contracts = linkedIds.length
    ? await db
        .select()
        .from(hrContractsTable)
        .where(
          and(
            inArray(hrContractsTable.employeeId, linkedIds),
            eq(hrContractsTable.isCurrent, true),
          ),
        )
    : [];
  const manual = linkedIds.length
    ? await db
        .select()
        .from(hrPayAdjustmentsTable)
        .where(
          and(
            eq(hrPayAdjustmentsTable.period, run.period),
            inArray(hrPayAdjustmentsTable.employeeId, linkedIds),
            eq(hrPayAdjustmentsTable.kind, "incentive"),
          ),
        )
    : [];

  const plans: { employee: (typeof linked)[number]; result: ProductionIncentiveResult }[] = [];
  const stale: string[] = [];
  for (const e of linked) {
    const c = contracts.find((x) => x.employeeId === e.id);
    const slip = slips.find((s) => s.employeeId === e.id);
    if (!c || !slip) continue;
    const result = await computeProductionIncentive({
      hrEmployeeId: e.id,
      procurementEmployeeId: e.procurementEmployeeId!,
      runPeriod: run.period,
      contractIncentive: num(c.incentive),
    });
    const manualSum = manual
      .filter((a) => a.employeeId === e.id)
      .reduce((acc, a) => acc + num(a.amount), 0);
    if (round2(num(slip.incentives)) !== round2(result.total + manualSum)) stale.push(e.fullName);
    plans.push({ employee: e, result });
  }
  if (stale.length) {
    res.status(409).json({
      error: "تغيرت بيانات حافز الإنتاج بعد حساب المسير — أعد حسابه قبل الاعتماد",
      employees: stale,
    });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(hrPayrollRunsTable)
      .set({ status: "approved", approvedAt: new Date() })
      .where(eq(hrPayrollRunsTable.id, id));
    for (const { employee, result } of plans) {
      if (!result.months.length) continue;
      await tx.insert(hrProductionCreditsTable).values(
        result.months.map((m) => ({
          employeeId: employee.id,
          basisPeriod: m.basisPeriod,
          runPeriod: run.period,
          assignedCount: m.assigned,
          deliveredCount: m.delivered,
          baseAmount: m.base.toFixed(2),
          creditedAmount: m.due.toFixed(2),
        })),
      );
    }
  });

  // Send every employee their own payslip. Best-effort and after the commit: the
  // run is already approved and locked, so a WhatsApp/PDF problem must not fail
  // the approval. Each failure is recorded on the payslip row and surfaced in
  // the payroll screen for a resend.
  try {
    const { results } = await deliverPayslips(id);
    const failed = results.filter((r) => r.outcome !== "sent").length;
    logger.info(
      { runId: id, period: run.period, sent: results.length - failed, failed },
      "hr: payslips dispatched after approval",
    );
  } catch (err) {
    logger.error({ err, runId: id }, "hr: payslip dispatch after approval failed");
  }

  res.json({ ok: true });
});

/**
 * (Re)send payslips for an approved run over WhatsApp.
 *   body: { employeeIds?: number[] }  — omit to send to every employee,
 *                                      pass ids to resend for specific employees.
 * Already-delivered employees are skipped unless `force: true` is passed.
 */
router.post("/hr/payroll/runs/:id/send-payslips", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  const rawIds = req.body?.employeeIds;
  if (rawIds !== undefined && !Array.isArray(rawIds)) {
    res.status(400).json({ error: "employeeIds لازم يكون مصفوفة أرقام" });
    return;
  }
  const employeeIds = Array.isArray(rawIds)
    ? rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : undefined;
  const force = req.body?.force === true;

  try {
    const out = await deliverPayslips(id, { employeeIds, force });
    res.json({
      ok: true,
      period: out.period,
      sent: out.results.filter((r) => r.outcome === "sent").length,
      failed: out.results.filter((r) => r.outcome === "failed").length,
      skippedNoPhone: out.results.filter((r) => r.outcome === "skipped_no_phone").length,
      results: out.results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message === "المسير غير موجود" ? 404 : 409;
    res.status(status).json({ error: message });
  }
});

// Production incentive preview for one payroll month (read-only; the approval recomputes it).
router.get("/hr/production-incentive", async (req, res): Promise<void> => {
  const period = String(req.query.period ?? "");
  if (!isValidPeriod(period)) {
    res.status(400).json({ error: "الفترة يجب أن تكون YYYY-MM" });
    return;
  }
  const linked = await db
    .select({
      id: hrEmployeesTable.id,
      fullName: hrEmployeesTable.fullName,
      procurementEmployeeId: hrEmployeesTable.procurementEmployeeId,
    })
    .from(hrEmployeesTable)
    .where(
      and(eq(hrEmployeesTable.status, "active"), isNotNull(hrEmployeesTable.procurementEmployeeId)),
    );
  const contracts = linked.length
    ? await db
        .select()
        .from(hrContractsTable)
        .where(
          and(
            inArray(
              hrContractsTable.employeeId,
              linked.map((e) => e.id),
            ),
            eq(hrContractsTable.isCurrent, true),
          ),
        )
    : [];
  const out = [];
  for (const e of linked) {
    const c = contracts.find((x) => x.employeeId === e.id);
    if (!c) continue;
    const result = await computeProductionIncentive({
      hrEmployeeId: e.id,
      procurementEmployeeId: e.procurementEmployeeId!,
      runPeriod: period,
      contractIncentive: num(c.incentive),
    });
    out.push({ employeeId: e.id, fullName: e.fullName, ...result });
  }
  res.json({ period, employees: out });
});

// Procurement accounts that can be linked to an HR employee.
router.get("/hr/procurement-accounts", async (_req, res): Promise<void> => {
  const rows = await db
    .select({ id: employeesTable.id, name: employeesTable.name })
    .from(employeesTable)
    .where(eq(employeesTable.isActive, true));
  res.json(rows);
});

router.delete("/hr/payroll/runs/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [run] = await db
    .select()
    .from(hrPayrollRunsTable)
    .where(eq(hrPayrollRunsTable.id, id))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  if (run.status !== "draft") {
    res.status(409).json({ error: "المسير المعتمد مش ممكن يتحذف" });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.delete(hrPayslipsTable).where(eq(hrPayslipsTable.runId, id));
    await tx.delete(hrPayrollRunsTable).where(eq(hrPayrollRunsTable.id, id));
  });
  res.json({ ok: true });
});

export default router;

/**
 * Payroll API — مسير الرواتب الشهري.
 *
 *   GET    /api/hr/payroll/runs?period=YYYY-MM   list runs
 *   GET    /api/hr/payroll/runs/:id              run with payslips
 *   POST   /api/hr/payroll/runs                  { period, absenceDays: { [employeeId]: n } } calculates a draft
 *   POST   /api/hr/payroll/runs/:id/approve      locks the run
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
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import { isValidPeriod } from "./discipline-logic";
import {
  computePayslip,
  missingPayrollSettings,
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

function parseAbsence(
  v: unknown,
  employeeIds: number[],
): Record<number, number> | { error: string } {
  const out: Record<number, number> = {};
  const map = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  for (const id of employeeIds) {
    const raw = map[String(id)];
    const n = raw === undefined || raw === null || raw === "" ? 0 : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 31)
      return { error: "أيام الغياب لازم تكون رقم صحيح من 0 إلى 31" };
    out[id] = n;
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
    })
    .from(hrPayslipsTable)
    .innerJoin(hrEmployeesTable, eq(hrEmployeesTable.id, hrPayslipsTable.employeeId))
    .where(eq(hrPayslipsTable.runId, id));
  res.json({
    run: { id: run.id, period: run.period, status: run.status, approvedAt: run.approvedAt },
    payslips: slips.map(({ slip: s, name, employeeNo }) => ({
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
    })),
  });
});

router.post("/hr/payroll/runs", async (req, res): Promise<void> => {
  const period = String(req.body?.period ?? "");
  if (!isValidPeriod(period)) {
    res.status(400).json({ error: "الفترة يجب أن تكون YYYY-MM" });
    return;
  }
  const { settings, raw } = await loadSettings();
  const missing = missingPayrollSettings(settings);
  if (missing.length) {
    res.status(400).json({ error: "إعدادات ناقصة قبل الحساب", missing });
    return;
  }

  const employees = await db
    .select({ id: hrEmployeesTable.id, fullName: hrEmployeesTable.fullName })
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.status, "active"));
  if (!employees.length) {
    res.status(400).json({ error: "مفيش موظفين نشطين للحساب" });
    return;
  }
  const ids = employees.map((e) => e.id);
  const absence = parseAbsence(req.body?.absenceDays, ids);
  if ("error" in absence) {
    res.status(400).json({ error: absence.error });
    return;
  }

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
        incentives: num(c.incentive) + sumKind("incentive"),
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
        .values({ period, status: "draft", settingsSnapshot: raw })
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
    res.status(201).json({ id: run.id, period, status: "draft", employees: rows.length });
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
  await db
    .update(hrPayrollRunsTable)
    .set({ status: "approved", approvedAt: new Date() })
    .where(eq(hrPayrollRunsTable.id, id));
  res.json({ ok: true });
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

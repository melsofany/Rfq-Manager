/**
 * Payroll API — مسير الرواتب الشهري.
 *
 *   GET    /api/hr/payroll/runs?period=YYYY-MM   list runs
 *   GET    /api/hr/payroll/runs/:id              run with payslips
 *   POST   /api/hr/payroll/runs                  { period } calculates a draft (absence days come from attendance)
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
import { buildAttendance } from "./routes";
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
  const { settings: stored, raw } = await loadSettings();
  // Missing settings don't block the run anymore; they count as defaults and the run records them.
  const missingSettings = missingPayrollSettings(stored);
  const settings = withMissingPayrollSettingsAsDefaults(stored);

  const employees = await db
    .select({
      id: hrEmployeesTable.id,
      fullName: hrEmployeesTable.fullName,
      hireDate: hrEmployeesTable.hireDate,
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

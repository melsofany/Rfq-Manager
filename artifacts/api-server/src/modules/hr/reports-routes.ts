/**
 * HR reports — تقارير شهرية للإدارة والمحاسب. كلها للقراءة.
 *
 *   GET /api/hr/reports/headcount
 *   GET /api/hr/reports/payroll?period=YYYY-MM         totals and by department
 *   GET /api/hr/reports/payroll.csv?period=YYYY-MM     payslips as CSV (no bank numbers)
 *   GET /api/hr/reports/leave?year=YYYY                annual leave balances
 */
import { Router, type IRouter } from "express";
import {
  db,
  hrEmployeesTable,
  hrPayrollRunsTable,
  hrPayslipsTable,
  hrLeaveTypesTable,
  hrLeaveRequestsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import { isValidPeriod } from "./discipline-logic";
import { daysInYear, remainingBalance } from "./leave-logic";
import { round2 } from "./payroll-logic";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

const num = (v: unknown) => Number(v ?? 0);

router.get("/hr/reports/headcount", async (_req, res): Promise<void> => {
  const emps = await db
    .select({ status: hrEmployeesTable.status, department: hrEmployeesTable.department })
    .from(hrEmployeesTable);
  const byStatus: Record<string, number> = { active: 0, resigned: 0, terminated: 0 };
  const byDept = new Map<string, number>();
  for (const e of emps) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    if (e.status === "active") {
      const d = e.department?.trim() || "—";
      byDept.set(d, (byDept.get(d) ?? 0) + 1);
    }
  }
  res.json({
    total: emps.length,
    byStatus,
    byDepartment: [...byDept.entries()]
      .map(([department, count]) => ({ department, count }))
      .sort((a, b) => b.count - a.count),
  });
});

async function loadRun(period: string) {
  const [run] = await db
    .select()
    .from(hrPayrollRunsTable)
    .where(eq(hrPayrollRunsTable.period, period))
    .limit(1);
  if (!run) return null;
  const slips = await db
    .select({
      slip: hrPayslipsTable,
      name: hrEmployeesTable.fullName,
      employeeNo: hrEmployeesTable.employeeNo,
      department: hrEmployeesTable.department,
    })
    .from(hrPayslipsTable)
    .innerJoin(hrEmployeesTable, eq(hrEmployeesTable.id, hrPayslipsTable.employeeId))
    .where(eq(hrPayslipsTable.runId, run.id));
  return { run, slips };
}

router.get("/hr/reports/payroll", async (req, res): Promise<void> => {
  const period = String(req.query.period ?? "");
  if (!isValidPeriod(period)) {
    res.status(400).json({ error: "الفترة يجب أن تكون YYYY-MM" });
    return;
  }
  const loaded = await loadRun(period);
  if (!loaded) {
    res.status(404).json({ error: "مفيش مسير للشهر ده" });
    return;
  }
  const { run, slips } = loaded;
  const sum = (f: (s: (typeof slips)[number]["slip"]) => unknown) =>
    round2(slips.reduce((acc, r) => acc + num(f(r.slip)), 0));
  const byDeptMap = new Map<
    string,
    { department: string; count: number; gross: number; net: number }
  >();
  for (const r of slips) {
    const d = r.department?.trim() || "—";
    const cur = byDeptMap.get(d) ?? { department: d, count: 0, gross: 0, net: 0 };
    cur.count += 1;
    cur.gross = round2(cur.gross + num(r.slip.gross));
    cur.net = round2(cur.net + num(r.slip.net));
    byDeptMap.set(d, cur);
  }
  res.json({
    period,
    status: run.status,
    employees: slips.length,
    totals: {
      gross: sum((s) => s.gross),
      net: sum((s) => s.net),
      absence: sum((s) => s.absenceAmount),
      fines: sum((s) => s.finesApplied),
      finesDeferred: sum((s) => s.finesDeferred),
      insurance: round2(sum((s) => s.socialEmployee) + sum((s) => s.healthEmployee)),
      incomeTax: sum((s) => s.incomeTax),
    },
    byDepartment: [...byDeptMap.values()].sort((a, b) => b.net - a.net),
  });
});

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get("/hr/reports/payroll.csv", async (req, res): Promise<void> => {
  const period = String(req.query.period ?? "");
  if (!isValidPeriod(period)) {
    res.status(400).json({ error: "الفترة يجب أن تكون YYYY-MM" });
    return;
  }
  const loaded = await loadRun(period);
  if (!loaded) {
    res.status(404).json({ error: "مفيش مسير للشهر ده" });
    return;
  }
  const header = [
    "employee_no",
    "name",
    "department",
    "basic",
    "allowances",
    "bonuses",
    "incentives",
    "deductions",
    "absence_days",
    "absence_amount",
    "fines_applied",
    "fines_deferred",
    "social_employee",
    "health_employee",
    "income_tax",
    "gross",
    "net",
  ];
  const lines = [header.join(",")];
  for (const r of loaded.slips) {
    const s = r.slip;
    lines.push(
      [
        r.employeeNo,
        r.name,
        r.department,
        s.basicSalary,
        s.allowances,
        s.bonuses,
        s.incentives,
        s.deductions,
        s.absenceDays,
        s.absenceAmount,
        s.finesApplied,
        s.finesDeferred,
        s.socialEmployee,
        s.healthEmployee,
        s.incomeTax,
        s.gross,
        s.net,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="payroll-${period}.csv"`);
  res.send("﻿" + lines.join("\r\n") + "\r\n");
});

router.get("/hr/reports/leave", async (req, res): Promise<void> => {
  const year = Number(req.query.year ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    res.status(400).json({ error: "السنة غير صالحة" });
    return;
  }
  const [annual] = await db
    .select()
    .from(hrLeaveTypesTable)
    .where(eq(hrLeaveTypesTable.code, "annual"))
    .limit(1);
  const emps = await db
    .select({
      id: hrEmployeesTable.id,
      name: hrEmployeesTable.fullName,
      status: hrEmployeesTable.status,
    })
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.status, "active"));
  const ids = emps.map((e) => e.id);
  const approved = ids.length
    ? await db
        .select()
        .from(hrLeaveRequestsTable)
        .where(
          and(
            inArray(hrLeaveRequestsTable.employeeId, ids),
            eq(hrLeaveRequestsTable.status, "approved"),
          ),
        )
    : [];
  const allocated = annual?.annualDays ?? 0;
  res.json({
    year,
    annualDays: allocated,
    rows: emps.map((e) => {
      const used = approved
        .filter((r) => r.employeeId === e.id)
        .reduce((acc, r) => acc + daysInYear(r.startDate, r.endDate, year), 0);
      return { employeeId: e.id, name: e.name, used, remaining: remainingBalance(allocated, used) };
    }),
  });
});

export default router;

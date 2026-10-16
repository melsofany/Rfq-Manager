/**
 * ملف التحويل البنكي للمسير المعتمد.
 *
 *   GET /api/hr/payroll/runs/:id/bank-file   CSV (أرقام الحسابات بتتفك وقت التحميل بس)
 *
 * بيرفض لو المسير مش معتمد، أو لو موظف عليه صافي مرتب من غير حساب بنكي.
 */
import { Router, type IRouter } from "express";
import {
  db,
  hrEmployeesTable,
  hrBankAccountsTable,
  hrPayrollRunsTable,
  hrPayslipsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import { decryptField, isHrKeyConfigured } from "../../shared/hr-crypto";
import { logger } from "../../shared/logger";
import { buildTransferCsv, needsTransfer, type TransferRow } from "./bank-transfer-logic";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

router.get("/hr/payroll/runs/:id/bank-file", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  if (!isHrKeyConfigured()) {
    res
      .status(503)
      .json({ error: "مفتاح تشفير بيانات الموظفين (HR_DATA_KEY) غير مضبوط على السيرفر" });
    return;
  }
  const [run] = await db
    .select()
    .from(hrPayrollRunsTable)
    .where(eq(hrPayrollRunsTable.id, id))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "المسير غير موجود" });
    return;
  }
  if (run.status !== "approved") {
    res.status(409).json({ error: "ملف التحويل متاح للمسير المعتمد بس" });
    return;
  }

  const slips = (
    await db.select().from(hrPayslipsTable).where(eq(hrPayslipsTable.runId, id))
  ).filter((s) => needsTransfer(s.net));
  const empIds = slips.map((s) => s.employeeId);
  const emps = empIds.length
    ? await db.select().from(hrEmployeesTable).where(inArray(hrEmployeesTable.id, empIds))
    : [];
  const banks = empIds.length
    ? await db
        .select()
        .from(hrBankAccountsTable)
        .where(
          and(
            inArray(hrBankAccountsTable.employeeId, empIds),
            eq(hrBankAccountsTable.isPrimary, true),
          ),
        )
    : [];

  const empById = new Map(emps.map((e) => [e.id, e]));
  const bankByEmp = new Map(banks.map((b) => [b.employeeId, b]));
  const missing = slips.filter((s) => !bankByEmp.has(s.employeeId));
  if (missing.length) {
    res.status(409).json({
      error: "فيه موظفين عليهم صافي مرتب من غير حساب بنكي",
      missing: missing.map((s) => ({
        employeeNo: empById.get(s.employeeId)?.employeeNo ?? "",
        fullName: empById.get(s.employeeId)?.fullName ?? "",
      })),
    });
    return;
  }

  const rows: TransferRow[] = slips.map((s) => {
    const emp = empById.get(s.employeeId)!;
    const bank = bankByEmp.get(s.employeeId)!;
    return {
      employeeNo: emp.employeeNo,
      fullName: emp.fullName,
      bankName: bank.bankName,
      accountHolder: bank.accountHolder,
      iban: bank.ibanEnc ? decryptField(bank.ibanEnc) : null,
      accountNo: decryptField(bank.accountNoEnc),
      netAmount: s.net,
      period: run.period,
    };
  });

  logger.info(
    { runId: id, period: run.period, rows: rows.length },
    "hr: bank transfer file exported",
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="salary-transfer-${run.period}.csv"`);
  res.send(buildTransferCsv(rows));
});

export default router;

/**
 * Payslip delivery — إرسال كشوف المرتبات للموظفين على واتساب.
 *
 * Each employee receives ONLY their own payslip, on their own phone number.
 *
 * Privacy is the whole point of this module: the portal's /whatsapp screen is a
 * shared inbox that the whole procurement team can open, so a payslip must never
 * be written to `whatsapp_chats` (that is what would make it visible to a
 * colleague) and salary figures must never be put on the SSE bus that feeds
 * that screen. Delivery state lives on the payslip row instead, readable only
 * through the HR-permissioned payroll API.
 */
import { db, hrEmployeesTable, hrPayrollRunsTable, hrPayslipsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { isWhatsAppConfigured, sendPayslipWhatsApp } from "../communications/service";
import { logger } from "../../shared/logger";
import { pickSendablePhone } from "../../shared/phone";
import { generatePayslipPdf } from "./payslip-pdf";

const num = (v: unknown) => Number(v ?? 0);

export type PayslipDeliveryOutcome = "sent" | "failed" | "skipped_no_phone";

export interface PayslipDeliveryResult {
  employeeId: number;
  employeeNo: string;
  fullName: string;
  outcome: PayslipDeliveryOutcome;
  error?: string;
}

export interface DeliverPayslipsOptions {
  /** Restrict to these employees (the «إرسال» button per row). Omit to send to everyone. */
  employeeIds?: number[];
  /**
   * Resend even to employees already marked `sent`. Used by the explicit send
   * button; the automatic post-approval pass leaves it off so a retry can never
   * spam an employee who already received their payslip.
   */
  force?: boolean;
}

/**
 * Send the run's payslips over WhatsApp, one message per employee.
 *
 * A failure for one employee never blocks the others: each row is marked
 * `sent` / `failed` (+ reason) / `pending`, and the caller gets the full list so
 * the payroll screen can show who still needs attention.
 */
export async function deliverPayslips(
  runId: number,
  opts: DeliverPayslipsOptions = {},
): Promise<{ runId: number; period: string; results: PayslipDeliveryResult[] }> {
  const [run] = await db
    .select()
    .from(hrPayrollRunsTable)
    .where(eq(hrPayrollRunsTable.id, runId))
    .limit(1);
  if (!run) throw new Error("المسير غير موجود");
  if (run.status !== "approved") throw new Error("لا يمكن إرسال الكشوف قبل اعتماد المسير");

  const where = opts.employeeIds?.length
    ? and(eq(hrPayslipsTable.runId, runId), inArray(hrPayslipsTable.employeeId, opts.employeeIds))
    : eq(hrPayslipsTable.runId, runId);

  const rows = await db
    .select({ slip: hrPayslipsTable, employee: hrEmployeesTable })
    .from(hrPayslipsTable)
    .innerJoin(hrEmployeesTable, eq(hrEmployeesTable.id, hrPayslipsTable.employeeId))
    .where(where);

  const results: PayslipDeliveryResult[] = [];

  for (const { slip, employee } of rows) {
    const base: PayslipDeliveryResult = {
      employeeId: employee.id,
      employeeNo: employee.employeeNo,
      fullName: employee.fullName,
      outcome: "failed",
    };

    // The automatic pass skips anyone already delivered; an explicit resend does not.
    if (!opts.force && slip.deliveryStatus === "sent") {
      results.push({ ...base, outcome: "sent" });
      continue;
    }

    const { phone, ignored } = pickSendablePhone(employee.phone);
    if (ignored.length) {
      logger.warn({ employeeId: employee.id, ignored }, "payslip: extra phone numbers ignored");
    }
    if (!phone) {
      await markFailed(slip.id, "لا يوجد رقم واتساب صالح للموظف");
      results.push({ ...base, outcome: "skipped_no_phone", error: "لا يوجد رقم واتساب صالح" });
      continue;
    }
    if (!isWhatsAppConfigured) {
      await markFailed(slip.id, "واتساب غير مُعدّ على السيرفر");
      results.push({ ...base, outcome: "failed", error: "واتساب غير مُعدّ على السيرفر" });
      continue;
    }

    try {
      const pdf = await generatePayslipPdf({
        period: run.period,
        employeeNo: employee.employeeNo,
        fullName: employee.fullName,
        jobTitle: employee.jobTitle,
        department: employee.department,
        basic: num(slip.basicSalary),
        allowances: num(slip.allowances),
        bonuses: num(slip.bonuses),
        incentives: num(slip.incentives),
        deductions: num(slip.deductions),
        absenceDays: slip.absenceDays,
        absenceAmount: num(slip.absenceAmount),
        finesApplied: num(slip.finesApplied),
        finesDeferred: num(slip.finesDeferred),
        socialEmployee: num(slip.socialEmployee),
        healthEmployee: num(slip.healthEmployee),
        incomeTax: num(slip.incomeTax),
        gross: num(slip.gross),
        net: num(slip.net),
      });
      await sendPayslipWhatsApp({
        phone,
        employeeName: employee.fullName,
        period: run.period,
        net: num(slip.net),
        pdf,
      });
      await db
        .update(hrPayslipsTable)
        .set({ deliveryStatus: "sent", deliveredAt: new Date(), deliveryError: null })
        .where(eq(hrPayslipsTable.id, slip.id));
      results.push({ ...base, outcome: "sent" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markFailed(slip.id, message);
      results.push({ ...base, outcome: "failed", error: message });
      logger.error({ err, employeeId: employee.id }, "payslip: WhatsApp send failed");
    }
  }

  return { runId, period: run.period, results };
}

async function markFailed(slipId: number, message: string): Promise<void> {
  await db
    .update(hrPayslipsTable)
    .set({ deliveryStatus: "failed", deliveryError: message.slice(0, 500) })
    .where(eq(hrPayslipsTable.id, slipId));
}

import { describe, it, expect } from "vitest";
import { generatePayslipPdf, type PayslipPdfOptions } from "../modules/hr/payslip-pdf";

const base: PayslipPdfOptions = {
  period: "2026-07",
  employeeNo: "EMP-0001",
  fullName: "محمد أحمد عبد الله",
  jobTitle: "أمين مخزن",
  department: "المخازن",
  basic: 6000,
  allowances: 500,
  bonuses: 300,
  incentives: 250,
  deductions: 100,
  absenceDays: 2,
  absenceAmount: 400,
  finesApplied: 150,
  finesDeferred: 0,
  socialEmployee: 660,
  healthEmployee: 60,
  incomeTax: 205,
  gross: 7050,
  net: 5475,
};

describe("payslip PDF", () => {
  it("renders a real PDF document with the Arabic font embedded", async () => {
    const pdf = await generatePayslipPdf(base);
    // %PDF- magic, and an embedded TrueType font (the Amiri subset).
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2000);
    expect(pdf.toString("latin1")).toContain("/FontFile2");
  });

  it("renders when optional job title and department are absent", async () => {
    const pdf = await generatePayslipPdf({ ...base, jobTitle: null, department: null });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("accepts a month with zero deductions and no deferred fines", async () => {
    const pdf = await generatePayslipPdf({
      ...base,
      absenceDays: 0,
      absenceAmount: 0,
      finesApplied: 0,
      finesDeferred: 0,
      deductions: 0,
      socialEmployee: 0,
      healthEmployee: 0,
      incomeTax: 0,
      gross: base.basic,
      net: base.basic,
    });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("passes a malformed period through without throwing", async () => {
    const pdf = await generatePayslipPdf({ ...base, period: "not-a-period" });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

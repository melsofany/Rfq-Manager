import { describe, it, expect } from "vitest";
import {
  buildTransferCsv,
  needsTransfer,
  TRANSFER_HEADER,
  type TransferRow,
} from "../modules/hr/bank-transfer-logic";

const row = (over: Partial<TransferRow> = {}): TransferRow => ({
  employeeNo: "26940001",
  fullName: "أحمد يوسف",
  bankName: "البنك الأهلي",
  accountHolder: "أحمد يوسف",
  iban: "EG123456789012345678901234567",
  accountNo: "123456789012",
  netAmount: "5000.00",
  period: "2026-10",
  ...over,
});

describe("salary transfer file", () => {
  it("starts with a UTF-8 BOM and the fixed header", () => {
    const csv = buildTransferCsv([]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split("\r\n")[0]).toBe(TRANSFER_HEADER.join(","));
  });
  it("writes one line per employee with the net amount", () => {
    const csv = buildTransferCsv([row()]);
    const line = csv.slice(1).split("\r\n")[1];
    expect(line).toBe(
      "26940001,أحمد يوسف,البنك الأهلي,أحمد يوسف,EG123456789012345678901234567,123456789012,5000.00,2026-10",
    );
  });
  it("quotes names with commas and doubles quotes", () => {
    const csv = buildTransferCsv([row({ fullName: 'أحمد, "الكبير"' })]);
    expect(csv).toContain('"أحمد, ""الكبير"""');
  });
  it("leaves the IBAN empty when the employee has none", () => {
    const csv = buildTransferCsv([row({ iban: null })]);
    expect(csv.slice(1).split("\r\n")[1].split(",")[4]).toBe("");
  });
  it("only pays positive nets", () => {
    expect(needsTransfer("0.00")).toBe(false);
    expect(needsTransfer("-120.00")).toBe(false);
    expect(needsTransfer("0.01")).toBe(true);
  });
});

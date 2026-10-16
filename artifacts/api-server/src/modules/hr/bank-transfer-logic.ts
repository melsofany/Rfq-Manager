/**
 * ملف التحويل البنكي للمرتبات — الصيغة العامة (CSV بأعمدة ثابتة).
 * لما يتوفر قالب البنك الرسمي، بيتغير هنا بس.
 */

export const TRANSFER_HEADER = [
  "employee_no",
  "full_name",
  "bank_name",
  "account_holder",
  "iban",
  "account_no",
  "net_amount",
  "period",
] as const;

export interface TransferRow {
  employeeNo: string;
  fullName: string;
  bankName: string;
  accountHolder: string;
  iban: string | null;
  accountNo: string;
  netAmount: string; // numeric(12,2) as text
  period: string;
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV with a UTF-8 BOM so Excel shows Arabic names correctly. */
export function buildTransferCsv(rows: TransferRow[]): string {
  const lines = [TRANSFER_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.employeeNo,
        r.fullName,
        r.bankName,
        r.accountHolder,
        r.iban ?? "",
        r.accountNo,
        r.netAmount,
        r.period,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** Only employees with a positive net need a transfer; zero or negative nets are skipped. */
export function needsTransfer(net: string): boolean {
  return Number(net) > 0;
}

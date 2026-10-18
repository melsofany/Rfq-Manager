/**
 * Employee documents — مستندات الموظف.
 *
 * The company's HR documents (employment contract, internal regulations, annexes, deposit
 * receipts) are stored as templates in document-templates.ts. Their {{placeholders}} are filled
 * with the employee's record; blanks that the record does not hold stay as fillable inputs.
 */
import { COMPANY_LOGO_DATA_URL, DOCUMENT_TEMPLATES } from "./document-templates";
import { escapeHtml, formatCardDate } from "./card-logic";

export const DOCUMENT_KEYS = [
  "contract",
  "internalRules",
  "annex1",
  "annex2",
  "receiptA",
  "receiptB",
] as const;
export type DocumentKey = (typeof DOCUMENT_KEYS)[number];

export interface DocumentData {
  fullName: string;
  nationalId: string | null;
  address: string | null;
  phone: string | null;
  jobTitle: string | null;
  department: string | null;
  hireDate: string | null;
  /** Current contract: "indefinite" | "fixed" | "probation" | "part_time". */
  contractType: string | null;
  contractEndDate: string | null;
  probationEndDate: string | null;
  basicSalary: string | number | null;
  allowances: string | number | null;
  incentive: string | number | null;
}

export function isDocumentKey(v: string): v is DocumentKey {
  return (DOCUMENT_KEYS as readonly string[]).includes(v);
}

/** Money as 1,500.00 جنيه; empty when the amount is not known. */
export function formatMoney(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} جنيه`;
}

function sumMoney(...values: Array<string | number | null | undefined>): number {
  return values.reduce<number>((total, v) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? total + n : total;
  }, 0);
}

export function documentValues(
  d: DocumentData,
  logo: string = COMPANY_LOGO_DATA_URL,
): Record<string, string> {
  const isFixed = d.contractType === "fixed";
  const isIndefinite = d.contractType === "indefinite";
  // Open-ended contracts have no end date; the template shows "غير محدد" instead.
  const endDate =
    d.contractType === "indefinite" ? "غير محدد" : (formatCardDate(d.contractEndDate) ?? "");
  const probation = formatCardDate(d.probationEndDate);
  const total = sumMoney(d.basicSalary, d.allowances, d.incentive);
  return {
    logo,
    fullName: d.fullName,
    nationalId: d.nationalId ?? "",
    address: d.address ?? "",
    phone: d.phone ?? "",
    jobTitle: d.jobTitle ?? "",
    department: d.department ?? "",
    hireDate: formatCardDate(d.hireDate) ?? "",
    endDate,
    probationText: probation ? `حتى ${probation}` : "",
    checkFixed: isFixed ? "☑" : "☐",
    checkIndefinite: isIndefinite ? "☑" : "☐",
    basicSalary: formatMoney(d.basicSalary),
    allowances: formatMoney(d.allowances),
    incentive: formatMoney(d.incentive),
    totalSalary: total > 0 ? formatMoney(total) : "",
  };
}

/** Fills every {{key}} with its escaped value; a placeholder with no value becomes blank. */
export function renderDocument(key: DocumentKey, data: DocumentData): string {
  const values = documentValues(data);
  return DOCUMENT_TEMPLATES[key].replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
    escapeHtml(values[name] ?? ""),
  );
}

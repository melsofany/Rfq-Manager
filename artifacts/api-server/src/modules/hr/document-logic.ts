/**
 * Employee documents — مستندات الموظف.
 *
 * The company's HR documents are templates (document-templates.ts). Their {{placeholders}} are filled
 * from three sources: the employee record (name, national ID, job, contract, salary), the employee's
 * saved document fields, and the company fields set once in Settings. Only signature, stamp and
 * witness lines stay blank on the printed page.
 */
import { COMPANY_LOGO_DATA_URL, DOCUMENT_TEMPLATES } from "./document-templates";
import { escapeHtml, formatCardDate } from "./card-logic";
import {
  ALL_DOC_FIELDS,
  COMPANY_DOC_FIELDS,
  EMPLOYEE_DOC_FIELDS,
  displayValue,
  isFieldEmpty,
  type DocField,
} from "./document-fields";

export const DOCUMENT_KEYS = [
  "contract",
  "internalRules",
  "annex1",
  "annex2",
  "receiptA",
  "receiptB",
] as const;
export type DocumentKey = (typeof DOCUMENT_KEYS)[number];

export const DOCUMENT_TITLES: Record<DocumentKey, string> = {
  contract: "عقد عمل",
  internalRules: "اللائحة الداخلية للموظفين",
  annex1: "ملحق رقم (1): السياسات المالية والإدارية",
  annex2: "ملحق رقم (2): لائحة الجزاءات والإجراءات التأديبية",
  receiptA: "إيصال أمانة (1)",
  receiptB: "إيصال أمانة (2)",
};

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
  /** Saved per-employee values (keys from EMPLOYEE_DOC_FIELDS). */
  fields: Record<string, string>;
  /** Company values from Settings (keys from COMPANY_DOC_FIELDS). */
  company: Record<string, string>;
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

function placeholdersOf(key: DocumentKey): Set<string> {
  return new Set([...DOCUMENT_TEMPLATES[key].matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
}

function rawFor(def: DocField, data: DocumentData): string | undefined {
  return def.name in data.company ? data.company[def.name] : data.fields[def.name];
}

function valueFor(def: DocField, data: DocumentData): string {
  return displayValue(def, rawFor(def, data));
}

export function documentValues(
  d: DocumentData,
  logo: string = COMPANY_LOGO_DATA_URL,
): Record<string, string> {
  const probation = formatCardDate(d.probationEndDate);
  const total = sumMoney(d.basicSalary, d.allowances, d.incentive);
  // Open-ended contracts have no end date; the template shows "غير محدد" instead.
  const endDate =
    d.contractType === "indefinite" ? "غير محدد" : (formatCardDate(d.contractEndDate) ?? "");
  const values: Record<string, string> = {
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
    checkFixed: d.contractType === "fixed" ? "☑" : "☐",
    checkIndefinite: d.contractType === "indefinite" ? "☑" : "☐",
    basicSalary: formatMoney(d.basicSalary),
    allowances: formatMoney(d.allowances),
    incentive: formatMoney(d.incentive),
    totalSalary: total > 0 ? formatMoney(total) : "",
  };
  for (const def of ALL_DOC_FIELDS) values[def.name] = valueFor(def, d);
  return values;
}

/** Labels of the fields this document needs that are still empty. */
export function missingFields(key: DocumentKey, d: DocumentData): string[] {
  const used = placeholdersOf(key);
  return ALL_DOC_FIELDS.filter((def) => used.has(def.name) && isFieldEmpty(rawFor(def, d))).map(
    (def) => def.label,
  );
}

/** Fills every {{key}} with its escaped value; a placeholder with no value becomes blank. */
export function renderDocument(key: DocumentKey, data: DocumentData): string {
  const values = documentValues(data);
  return DOCUMENT_TEMPLATES[key].replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
    escapeHtml(values[name] ?? ""),
  );
}

export { ALL_DOC_FIELDS, COMPANY_DOC_FIELDS, EMPLOYEE_DOC_FIELDS };

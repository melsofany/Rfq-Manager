/**
 * Employee documents — مستندات الموظف.
 *
 * The company's HR documents are templates (document-templates.ts). Each {{placeholder}} is filled
 * from the employee's effective field values: the system default, unless the user overrode it.
 * Company values come from Settings. Only signature, stamp and witness lines stay blank on paper.
 */
import { COMPANY_LOGO_DATA_URL, DOCUMENT_TEMPLATES } from "./document-templates";
import { escapeHtml, formatCardDate } from "./card-logic";
import {
  ALL_DOC_FIELDS,
  COMPANY_DOC_FIELDS,
  CONTRACT_TYPE_OPTIONS,
  DELIVERED_TITLES,
  EMPLOYEE_DOC_FIELDS,
  displayValue,
  formatMoney,
  isFieldEmpty,
} from "./document-fields";

export { formatMoney };

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
  contractNo: string | null;
  contractEndDate: string | null;
  probationEndDate: string | null;
  basicSalary: string | number | null;
  allowances: string | number | null;
  incentive: string | number | null;
  /** Saved overrides per employee (keys from EMPLOYEE_DOC_FIELDS). */
  fields: Record<string, string>;
  /** Company values from Settings (keys from COMPANY_DOC_FIELDS). */
  company: Record<string, string>;
}

export function isDocumentKey(v: string): v is DocumentKey {
  return (DOCUMENT_KEYS as readonly string[]).includes(v);
}

function moneyRaw(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "";
}

/** System default for each employee field, taken from the employee record and current contract. */
export function defaultFieldValues(d: DocumentData): Record<string, string> {
  const hire = d.hireDate ?? "";
  const contractType =
    d.contractType === "fixed"
      ? CONTRACT_TYPE_OPTIONS[0]
      : d.contractType === "indefinite"
        ? CONTRACT_TYPE_OPTIONS[1]
        : "";
  const values: Record<string, string> = {
    fullName: d.fullName,
    nationalId: d.nationalId ?? "",
    address: d.address ?? "",
    phone: d.phone ?? "",
    jobTitle: d.jobTitle ?? "",
    department: d.department ?? "",
    hireDate: hire,
    contractType,
    endDate: d.contractEndDate ?? "",
    probationEndDate: d.probationEndDate ?? "",
    basicSalary: moneyRaw(d.basicSalary),
    allowances: moneyRaw(d.allowances),
    incentive: moneyRaw(d.incentive),
    contractNo: d.contractNo ?? "",
    contractDate: hire,
    agreementDate: hire,
  };
  // The contract's attached documents are delivered with the contract by default.
  DELIVERED_TITLES.forEach((_title, i) => {
    values[`delivered${i + 1}`] = "نعم";
    values[`deliveredDate${i + 1}`] = hire;
  });
  return values;
}

/** Effective employee values: the system default, unless the user saved an override. */
export function effectiveFieldValues(d: DocumentData): Record<string, string> {
  return { ...defaultFieldValues(d), ...d.fields };
}

/** Only the values that differ from the system default are kept as overrides. */
export function overridesFrom(
  defaults: Record<string, string>,
  draft: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of EMPLOYEE_DOC_FIELDS) {
    if (!(def.name in draft)) continue;
    if (draft[def.name] !== (defaults[def.name] ?? "")) out[def.name] = draft[def.name];
  }
  return out;
}

const WEEKDAYS_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/** Arabic weekday for a YYYY-MM-DD date; empty when the date is missing. */
export function weekdayAr(ymd: string | undefined): string {
  if (!ymd || !isValidYmdLoose(ymd)) return "";
  return WEEKDAYS_AR[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
}

function isValidYmdLoose(ymd: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) && !Number.isNaN(Date.parse(`${ymd}T00:00:00Z`));
}

/** Placeholders that are computed from one or more fields. */
const DERIVED: Record<string, string[]> = {
  checkFixed: ["contractType"],
  checkIndefinite: ["contractType"],
  probationText: ["probationEndDate"],
  agreementDay: ["agreementDate"],
  totalSalary: ["basicSalary", "allowances", "incentive"],
  endDate: ["endDate", "contractType"],
};
/** Fields a document can print without; blank is acceptable. */
const OPTIONAL = new Set(["probationEndDate", "allowances", "incentive"]);

function placeholdersOf(key: DocumentKey): Set<string> {
  return new Set([...DOCUMENT_TEMPLATES[key].matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
}

function rawFor(name: string, d: DocumentData, eff: Record<string, string>): string | undefined {
  return name in d.company ? d.company[name] : eff[name];
}

export function documentValues(
  d: DocumentData,
  logo: string = COMPANY_LOGO_DATA_URL,
): Record<string, string> {
  const eff = effectiveFieldValues(d);
  const values: Record<string, string> = { logo };
  for (const def of EMPLOYEE_DOC_FIELDS) values[def.name] = displayValue(def, eff[def.name]);
  for (const def of COMPANY_DOC_FIELDS) values[def.name] = displayValue(def, d.company[def.name]);
  const indefinite = eff.contractType === CONTRACT_TYPE_OPTIONS[1];
  values.checkFixed = eff.contractType === CONTRACT_TYPE_OPTIONS[0] ? "☑" : "☐";
  values.checkIndefinite = indefinite ? "☑" : "☐";
  values.endDate = indefinite ? "غير محدد" : (formatCardDate(eff.endDate) ?? "");
  const probation = formatCardDate(eff.probationEndDate);
  values.probationText = probation ? `حتى ${probation}` : "";
  values.agreementDay = weekdayAr(eff.agreementDate);
  const total = ["basicSalary", "allowances", "incentive"].reduce((sum, k) => {
    const n = Number(eff[k] ?? 0);
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);
  values.totalSalary = total > 0 ? formatMoney(total) : "";
  return values;
}

/** Labels of the fields this document needs that are still empty. */
export function missingFields(key: DocumentKey, d: DocumentData): string[] {
  const eff = effectiveFieldValues(d);
  const needed = new Set<string>();
  for (const p of placeholdersOf(key)) for (const f of DERIVED[p] ?? [p]) needed.add(f);
  const indefinite = eff.contractType === CONTRACT_TYPE_OPTIONS[1];
  return ALL_DOC_FIELDS.filter((def) => {
    if (!needed.has(def.name) || OPTIONAL.has(def.name)) return false;
    if (def.name === "endDate" && indefinite) return false;
    return isFieldEmpty(rawFor(def.name, d, eff));
  }).map((def) => def.label);
}

/**
 * Print rules added to every document: a signature block, a heading or a table
 * row must not be split across two sheets, and a heading must not be left alone
 * at the bottom of a sheet. Without them the header and the signature land on
 * different pages whenever the content length changes.
 */
const PRINT_PAGINATION_CSS = `<style>
/* Every printed sheet carries its own footer: page X of Y, the company name and
   the employee's signature line. Printed by the browser on each A4 sheet, so the
   numbering and the signature are never missing or typed by hand. */
@page {
  size: A4;
  margin: 18mm 14mm 20mm 14mm;
  @bottom-left { content: "ورقة " counter(page) " من " counter(pages); font-family: Tahoma, Arial, sans-serif; font-size: 9px; color: #5b6573; }
  @bottom-center { content: "شركة قرطبة للتوريدات"; font-family: Tahoma, Arial, sans-serif; font-size: 9px; color: #5b6573; }
  @bottom-right { content: "توقيع الموظف: ............................"; font-family: Tahoma, Arial, sans-serif; font-size: 9px; color: #263238; }
}
/* The first sheet states how many sheets the document has. */
@page :first {
  @top-center { content: "هذا المستند من " counter(pages) " ورقة"; font-family: Tahoma, Arial, sans-serif; font-size: 9px; color: #263238; }
}
@media print {
  html, body { background: #fff !important; }
  .toolbar, button { display: none !important; }
  .footer-note, .foot { display: none !important; }
  .document, .sheet, main {
    margin: 0 !important; padding: 0 !important; border: 0 !important;
    box-shadow: none !important; width: auto !important; max-width: none !important;
  }
  .signature, .sign, .signatures, .two-col, .two, .notice, .cover,
  table, tr, td, th, p, li, h1, h2, h3, .page-header, header {
    break-inside: avoid; page-break-inside: avoid;
  }
  .bar, .section-title, h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
  .document, .sheet, main { min-height: 0 !important; }
  .page-header img, .brand img, .cover img, header img { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
}
</style>`;

/** Fills every {{key}} with its escaped value; a placeholder with no value becomes blank. */
export function renderDocument(key: DocumentKey, data: DocumentData): string {
  const values = documentValues(data);
  const html = DOCUMENT_TEMPLATES[key].replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
    escapeHtml(values[name] ?? ""),
  );
  return html.includes("</head>")
    ? html.replace("</head>", `${PRINT_PAGINATION_CSS}</head>`)
    : `${PRINT_PAGINATION_CSS}${html}`;
}

export { ALL_DOC_FIELDS, COMPANY_DOC_FIELDS, EMPLOYEE_DOC_FIELDS };

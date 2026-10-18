/**
 * Values for the HR documents.
 *
 * Employee fields have a system default (from the employee record, contract, or company rules).
 * The form shows the effective value; only values the user changed are saved as overrides, so
 * untouched fields keep following the system. Company fields are set once in Settings.
 * Select fields print as a ticked checkbox list.
 */
import { formatCardDate } from "./card-logic";
import { isValidYmd } from "./leave-logic";

export type FieldType = "text" | "date" | "select" | "textarea" | "money";
export interface DocField {
  name: string;
  label: string;
  type: FieldType;
  options?: readonly string[];
}

export const YES_NO = ["نعم", "لا"] as const;
export const CONTRACT_TYPE_OPTIONS = ["محدد المدة", "غير محدد المدة"] as const;
export const DELIVERED_TITLES = [
  "اللائحة الداخلية",
  "ملحق السياسات المالية والإدارية",
  "ملحق الجزاءات والإجراءات التأديبية",
];

const SYSTEM_FIELDS: readonly DocField[] = [
  { name: "fullName", label: "الاسم بالعربي", type: "text" },
  { name: "nationalId", label: "الرقم القومي", type: "text" },
  { name: "address", label: "العنوان", type: "text" },
  { name: "phone", label: "رقم الهاتف", type: "text" },
  { name: "jobTitle", label: "المسمى الوظيفي", type: "text" },
  { name: "department", label: "القسم / الإدارة", type: "text" },
  { name: "hireDate", label: "تاريخ بدء العمل", type: "date" },
  { name: "contractType", label: "نوع العقد", type: "select", options: CONTRACT_TYPE_OPTIONS },
  { name: "endDate", label: "تاريخ انتهاء العقد", type: "date" },
  { name: "probationEndDate", label: "نهاية فترة التجربة", type: "date" },
  { name: "basicSalary", label: "الأجر الأساسي الشهري", type: "money" },
  { name: "allowances", label: "البدلات", type: "money" },
  { name: "incentive", label: "الحافز الشهري", type: "money" },
  { name: "contractNo", label: "رقم العقد", type: "text" },
  { name: "contractDate", label: "تاريخ تحرير العقد", type: "date" },
  { name: "agreementDate", label: "تاريخ الاتفاق", type: "date" },
  ...DELIVERED_TITLES.flatMap((title, i): DocField[] => [
    { name: `delivered${i + 1}`, label: `تم تسليم: ${title}`, type: "select", options: YES_NO },
    { name: `deliveredDate${i + 1}`, label: `تاريخ تسليم: ${title}`, type: "date" },
  ]),
];

const MANUAL_FIELDS: readonly DocField[] = [
  { name: "nationality", label: "الجنسية", type: "text" },
  { name: "email", label: "البريد الإلكتروني", type: "text" },
  { name: "directManager", label: "المدير المباشر", type: "text" },
  { name: "workplace", label: "مكان العمل", type: "text" },
  { name: "contractDuration", label: "مدة العقد", type: "text" },
  { name: "workHours", label: "ساعات العمل اليومية", type: "text" },
  { name: "jobDescNo", label: "رقم الوصف الوظيفي", type: "text" },
  { name: "scope", label: "نطاق العمل", type: "text" },
  {
    name: "workMode",
    label: "مكان أداء العمل",
    type: "select",
    options: ["مقر الشركة", "ميداني", "هجين"],
  },
  { name: "travel", label: "السفر لمهام العمل", type: "select", options: YES_NO },
  { name: "equipment", label: "المعدات المسلمة", type: "text" },
  { name: "workEmail", label: "البريد الوظيفي", type: "text" },
  { name: "adminDependency", label: "التبعية الإدارية", type: "text" },
  { name: "firstReviewDate", label: "موعد المراجعة الأولى", type: "date" },
  {
    name: "payMethod",
    label: "طريقة الصرف",
    type: "select",
    options: ["نقدًا", "تحويل بنكي", "محفظة إلكترونية"],
  },
  { name: "housingAllowance", label: "بدل السكن", type: "text" },
  { name: "transportAllowance", label: "بدل الانتقال", type: "text" },
  { name: "payDate", label: "تاريخ صرف الأجر", type: "text" },
  { name: "workDays", label: "أيام العمل", type: "text" },
  { name: "workTime", label: "موعد الدوام", type: "text" },
  { name: "restPeriod", label: "مدة الراحة", type: "text" },
  { name: "amountType", label: "نوع الأمانة أو وصفها", type: "text" },
  { name: "purpose", label: "الغرض من التسليم", type: "text" },
  { name: "giverName", label: "اسم المسلم", type: "text" },
  { name: "giverDetails", label: "بيانات المسلم وعنوانه", type: "text" },
  { name: "receiptDate", label: "تاريخ الاستلام", type: "date" },
  { name: "receiptPlace", label: "مكان الاستلام", type: "text" },
  { name: "returnDate", label: "موعد الرد أو التسليم", type: "date" },
  { name: "returnPlace", label: "مكان الرد أو التسليم", type: "text" },
  { name: "returnMethod", label: "طريقة الرد أو التسليم", type: "text" },
  { name: "notes", label: "ملاحظات", type: "textarea" },
];

export const EMPLOYEE_DOC_FIELDS: readonly DocField[] = [...SYSTEM_FIELDS, ...MANUAL_FIELDS];

export const COMPANY_DOC_FIELDS: readonly DocField[] = [
  { name: "issueNo", label: "رقم الإصدار", type: "text" },
  { name: "issueDate", label: "تاريخ الإصدار", type: "date" },
  { name: "effectiveDate", label: "تاريخ النفاذ", type: "date" },
  { name: "approvingBody", label: "الجهة المعتمدة", type: "text" },
  { name: "lawCountry", label: "الدولة والقانون الحاكم", type: "text" },
  { name: "legalName", label: "الاسم القانوني الكامل", type: "text" },
  { name: "companyWorkHours", label: "ساعات العمل الرسمية", type: "text" },
  { name: "complaintsBody", label: "جهة الشكاوى", type: "text" },
  { name: "infoSecOfficer", label: "مسؤول أمن المعلومات", type: "text" },
  { name: "settleDays", label: "مدة تقديم تسوية المصروفات (أيام)", type: "text" },
  { name: "reportBody", label: "جهة الإبلاغ عن المخالفات المالية", type: "text" },
  { name: "reportEmail", label: "بريد الإبلاغ", type: "text" },
  { name: "purchaseLimit", label: "حدود الشراء", type: "text" },
  { name: "accountantName", label: "مسؤول الحسابات", type: "text" },
  { name: "hrName", label: "مسؤول الموارد البشرية", type: "text" },
  { name: "advanceSettleDays", label: "مدة تسوية العهد (أيام)", type: "text" },
  { name: "docRetentionDays", label: "مدة حفظ المستندات", type: "text" },
  { name: "appealDays", label: "مدة التظلم (أيام)", type: "text" },
  { name: "appealBody", label: "الجهة المختصة بالتظلم", type: "text" },
  { name: "investigationBody", label: "جهة التحقيق", type: "text" },
  { name: "appealsBody", label: "جهة التظلمات", type: "text" },
  { name: "appealPeriod", label: "مدة التظلم", type: "text" },
  { name: "penaltyRetentionDays", label: "مدة حفظ الجزاءات", type: "text" },
];

export const ALL_DOC_FIELDS: readonly DocField[] = [...EMPLOYEE_DOC_FIELDS, ...COMPANY_DOC_FIELDS];

const MAX_TEXT = 300;
const MAX_TEXTAREA = 2000;
const MONEY_RE = /^\d{1,9}(\.\d{1,2})?$/;

type Result = { error: string } | { value: Record<string, string> };

/** Keeps only known fields and validates each by type. An empty value is kept (it can override a default). */
export function sanitizeFields(defs: readonly DocField[], input: unknown): Result {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: "البيانات لازم تكون كائن" };
  }
  const src = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const def of defs) {
    const raw = src[def.name];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") return { error: `${def.label} لازم يكون نص` };
    let v = raw.trim();
    if (v !== "") {
      if (def.type === "date") {
        if (!isValidYmd(v)) return { error: `${def.label} لازم يكون تاريخ صحيح` };
      } else if (def.type === "select") {
        if (!def.options?.includes(v)) return { error: `${def.label}: اختيار غير متاح` };
      } else if (def.type === "money") {
        const plain = v.replace(/,/g, "");
        if (!MONEY_RE.test(plain)) return { error: `${def.label} لازم يكون مبلغ بالأرقام` };
        v = Number(plain).toFixed(2);
      } else {
        const max = def.type === "textarea" ? MAX_TEXTAREA : MAX_TEXT;
        if (v.length > max) return { error: `${def.label} أطول من ${max} حرف` };
      }
    }
    out[def.name] = v;
  }
  return { value: out };
}

/** Money as 1,500.00 جنيه; empty when the amount is not known. */
export function formatMoney(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} جنيه`;
}

/** Text shown on the printed document for one field. Selects become a ticked checkbox list. */
export function displayValue(def: DocField, raw: string | undefined): string {
  const v = raw ?? "";
  if (def.type === "select") {
    return (def.options ?? []).map((o) => `${o === v ? "☑" : "☐"} ${o}`).join("　 ");
  }
  if (def.type === "date") return formatCardDate(v) ?? "";
  if (def.type === "money") return formatMoney(v);
  return v;
}

export function isFieldEmpty(raw: string | undefined): boolean {
  return raw === undefined || raw.trim() === "";
}

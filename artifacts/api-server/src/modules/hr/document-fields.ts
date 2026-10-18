/**
 * Values for the HR documents that are not in the employee record.
 * Employee fields are typed or picked per employee (saved in hr_employee_document_fields).
 * Company fields are set once in Settings (document_company) and used by every employee's documents.
 * Select fields print as a checkbox list, so the printed page shows the chosen option ticked.
 */
import { formatCardDate, escapeHtml } from "./card-logic";
import { isValidYmd } from "./leave-logic";

export type FieldType = "text" | "date" | "select" | "textarea";
export interface DocField {
  name: string;
  label: string;
  type: FieldType;
  options?: readonly string[];
}

const YES_NO = ["نعم", "لا"] as const;
const DELIVERED = [
  "اللائحة الداخلية",
  "ملحق السياسات المالية والإدارية",
  "ملحق الجزاءات والإجراءات التأديبية",
  "الوصف الوظيفي المعتمد",
  "عرض العمل أو خطاب التعيين",
];

export const EMPLOYEE_DOC_FIELDS: readonly DocField[] = [
  { name: "contractNo", label: "رقم العقد", type: "text" },
  { name: "contractDate", label: "تاريخ تحرير العقد", type: "date" },
  { name: "agreementDay", label: "يوم الاتفاق", type: "text" },
  { name: "agreementDate", label: "تاريخ الاتفاق", type: "date" },
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
  ...DELIVERED.flatMap((title, i): DocField[] => [
    {
      name: `delivered${i + 1}`,
      label: `تم تسليم: ${title}`,
      type: "select",
      options: YES_NO,
    },
    { name: `deliveredDate${i + 1}`, label: `تاريخ تسليم: ${title}`, type: "date" },
  ]),
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

type Result = { error: string } | { value: Record<string, string> };

/** Keeps only known fields; each value is validated against its type. Empty means not filled. */
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
    const v = raw.trim();
    if (v === "") continue;
    if (def.type === "date") {
      if (!isValidYmd(v)) return { error: `${def.label} لازم يكون تاريخ صحيح` };
    } else if (def.type === "select") {
      if (!def.options?.includes(v)) return { error: `${def.label}: اختيار غير متاح` };
    } else {
      const max = def.type === "textarea" ? MAX_TEXTAREA : MAX_TEXT;
      if (v.length > max) return { error: `${def.label} أطول من ${max} حرف` };
    }
    out[def.name] = v;
  }
  return { value: out };
}

/** Text shown on the printed document for one field. Selects become a ticked checkbox list. */
export function displayValue(def: DocField, raw: string | undefined): string {
  const v = raw ?? "";
  if (def.type === "select") {
    return (def.options ?? []).map((o) => `${o === v ? "☑" : "☐"} ${o}`).join("　 ");
  }
  if (def.type === "date") return formatCardDate(v) ?? "";
  return v;
}

export function isFieldEmpty(raw: string | undefined): boolean {
  return raw === undefined || raw.trim() === "";
}

export function escapedDisplay(def: DocField, raw: string | undefined): string {
  return escapeHtml(displayValue(def, raw));
}

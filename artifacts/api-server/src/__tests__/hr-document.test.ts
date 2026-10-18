import { describe, it, expect } from "vitest";
import { DOCUMENT_TEMPLATES, COMPANY_LOGO_DATA_URL } from "../modules/hr/document-templates";
import {
  DOCUMENT_KEYS,
  documentValues,
  formatMoney,
  isDocumentKey,
  missingFields,
  renderDocument,
  type DocumentData,
} from "../modules/hr/document-logic";
import {
  ALL_DOC_FIELDS,
  COMPANY_DOC_FIELDS,
  EMPLOYEE_DOC_FIELDS,
  sanitizeFields,
} from "../modules/hr/document-fields";

const SYSTEM_PLACEHOLDERS = new Set([
  "logo",
  "fullName",
  "nationalId",
  "address",
  "phone",
  "jobTitle",
  "department",
  "hireDate",
  "endDate",
  "probationText",
  "checkFixed",
  "checkIndefinite",
  "basicSalary",
  "allowances",
  "incentive",
  "totalSalary",
]);

const company = Object.fromEntries(
  COMPANY_DOC_FIELDS.map((f) => [f.name, f.type === "date" ? "2026-01-01" : `قيمة ${f.label}`]),
);
const fields = Object.fromEntries(
  EMPLOYEE_DOC_FIELDS.map((f) => [
    f.name,
    f.type === "date" ? "2026-01-15" : (f.options?.[0] ?? `قيمة ${f.label}`),
  ]),
);

const employee: DocumentData = {
  fullName: "أحمد يوسف",
  nationalId: "29001011234567",
  address: "مطروح — شارع علم الروم",
  phone: "01000000000",
  jobTitle: "مندوب مبيعات",
  department: "المبيعات",
  hireDate: "2024-03-01",
  contractType: "fixed",
  contractEndDate: "2026-12-31",
  probationEndDate: "2024-06-01",
  basicSalary: "5000.00",
  allowances: "1000.00",
  incentive: "500.00",
  fields,
  company,
};

import { validateEmployeeNames } from "../modules/hr/employee-names";

describe("employee names", () => {
  it("requires an Arabic name and an English name", () => {
    expect(validateEmployeeNames("أحمد يوسف", "Ahmed Youssef")).toEqual({
      fullName: "أحمد يوسف",
      fullNameEn: "Ahmed Youssef",
    });
    expect("error" in validateEmployeeNames("", "Ahmed")).toBe(true);
    expect("error" in validateEmployeeNames("Ahmed", "Ahmed")).toBe(true);
    expect("error" in validateEmployeeNames("أحمد", "")).toBe(true);
    expect("error" in validateEmployeeNames("أحمد", "أحمد")).toBe(true);
    expect("error" in validateEmployeeNames("أحمد", "Ahmed 2")).toBe(true);
  });
});

describe("employee documents", () => {
  it("does not print the employee name on acknowledgment or signature lines", () => {
    for (const key of ["internalRules", "annex1", "annex2"] as const) {
      expect(renderDocument(key, employee), key).not.toContain("أحمد يوسف");
    }
    for (const key of ["contract", "receiptA", "receiptB"] as const) {
      const html = renderDocument(key, employee);
      // Only the employee's data row carries the name; the signing lines stay blank.
      expect(html.split("أحمد يوسف").length - 1, key).toBe(1);
    }
  });

  it("every placeholder is a system value or a known field", () => {
    const known = new Set([...SYSTEM_PLACEHOLDERS, ...ALL_DOC_FIELDS.map((f) => f.name)]);
    for (const key of DOCUMENT_KEYS) {
      for (const m of DOCUMENT_TEMPLATES[key].matchAll(/\{\{(\w+)\}\}/g)) {
        expect(known.has(m[1]), `${key}: ${m[1]}`).toBe(true);
      }
    }
  });

  it("a complete record leaves nothing to fill in by hand", () => {
    for (const key of DOCUMENT_KEYS) {
      expect(missingFields(key, employee), key).toEqual([]);
      expect(renderDocument(key, employee)).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it("lists the empty fields a document still needs", () => {
    const missing = missingFields("contract", { ...employee, fields: {}, company: {} });
    expect(missing).toContain("رقم العقد");
    expect(missing).toContain("مكان أداء العمل");
    expect(missing).toContain("مدة العقد");
    expect(missingFields("internalRules", { ...employee, company: {} })).toContain("رقم الإصدار");
  });

  it("prints select fields as a ticked checkbox list", () => {
    const html = renderDocument("contract", {
      ...employee,
      fields: { ...fields, workMode: "هجين" },
    });
    expect(html).toContain("☑ هجين");
    expect(html).toContain("☐ مقر الشركة");
  });

  it("fills the employee data and the open-ended end date", () => {
    const html = renderDocument("contract", employee);
    expect(html).toContain("أحمد يوسف");
    expect(html).toContain("29001011234567");
    expect(html).toContain("01/03/2024");
    expect(html).toContain("5,000.00 جنيه");
    expect(html).toContain("6,500.00 جنيه");
    expect(html).toContain(COMPANY_LOGO_DATA_URL);
    expect(documentValues({ ...employee, contractType: "indefinite" }).endDate).toBe("غير محدد");
    expect(documentValues({ ...employee, contractType: "fixed" }).checkFixed).toBe("☑");
  });

  it("escapes employee text so it cannot inject markup", () => {
    const html = renderDocument("receiptA", { ...employee, fullName: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("validates saved fields by type and drops unknown keys", () => {
    const ok = sanitizeFields(EMPLOYEE_DOC_FIELDS, {
      contractDate: "2026-02-03",
      payMethod: "نقدًا",
      x: "y",
    });
    expect(ok).toEqual({ value: { contractDate: "2026-02-03", payMethod: "نقدًا" } });
    expect("error" in sanitizeFields(EMPLOYEE_DOC_FIELDS, { contractDate: "31/12/2026" })).toBe(
      true,
    );
    expect("error" in sanitizeFields(EMPLOYEE_DOC_FIELDS, { payMethod: "شيك" })).toBe(true);
    expect("error" in sanitizeFields(EMPLOYEE_DOC_FIELDS, { notes: "x".repeat(2001) })).toBe(true);
  });

  it("formats money and validates keys", () => {
    expect(formatMoney("1234.5")).toBe("1,234.50 جنيه");
    expect(formatMoney(null)).toBe("");
    expect(isDocumentKey("contract")).toBe(true);
    expect(isDocumentKey("../secret")).toBe(false);
  });
});

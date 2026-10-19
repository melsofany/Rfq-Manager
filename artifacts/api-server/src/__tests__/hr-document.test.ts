import { describe, it, expect } from "vitest";
import { DOCUMENT_TEMPLATES, COMPANY_LOGO_DATA_URL } from "../modules/hr/document-templates";
import {
  DOCUMENT_KEYS,
  defaultFieldValues,
  documentValues,
  effectiveFieldValues,
  isDocumentKey,
  missingFields,
  overridesFrom,
  renderDocument,
  weekdayAr,
  formatMoney,
  type DocumentData,
} from "../modules/hr/document-logic";
import {
  ALL_DOC_FIELDS,
  COMPANY_DOC_FIELDS,
  EMPLOYEE_DOC_FIELDS,
  sanitizeFields,
} from "../modules/hr/document-fields";
import { validateEmployeeNames } from "../modules/hr/employee-names";

// Computed placeholders that are not stored fields.
const COMPUTED = new Set([
  "logo",
  "checkFixed",
  "checkIndefinite",
  "probationText",
  "agreementDay",
  "totalSalary",
]);

const company = Object.fromEntries(
  COMPANY_DOC_FIELDS.map((f) => [f.name, f.type === "date" ? "2026-01-01" : `قيمة ${f.label}`]),
);

// Values the user types for the fields that have no system default.
const manual = Object.fromEntries(
  EMPLOYEE_DOC_FIELDS.filter((f) => !(f.name in defaultFieldValues(baseEmployee()))).map((f) => [
    f.name,
    f.type === "date" ? "2026-01-15" : f.type === "select" ? f.options![0] : `قيمة ${f.label}`,
  ]),
);

function baseEmployee(): DocumentData {
  return {
    fullName: "أحمد يوسف",
    nationalId: "29001011234567",
    address: "مطروح — شارع علم الروم",
    phone: "01000000000",
    jobTitle: "مندوب مبيعات",
    department: "المبيعات",
    hireDate: "2026-02-01",
    contractType: "fixed",
    contractNo: "CT-2026-00012",
    contractEndDate: "2026-12-31",
    probationEndDate: "2026-05-01",
    basicSalary: "5000",
    allowances: "1000",
    incentive: "500",
    fields: {},
    company,
  };
}

const employee: DocumentData = { ...baseEmployee(), fields: manual };

describe("employee names", () => {
  it("requires an Arabic name and an English name", () => {
    expect(validateEmployeeNames("أحمد يوسف", "Ahmed Youssef")).toEqual({
      fullName: "أحمد يوسف",
      fullNameEn: "Ahmed Youssef",
    });
    expect("error" in validateEmployeeNames("Ahmed", "Ahmed")).toBe(true);
    expect("error" in validateEmployeeNames("أحمد", "أحمد")).toBe(true);
    expect("error" in validateEmployeeNames("أحمد", "Ahmed 2")).toBe(true);
  });
});

describe("employee documents", () => {
  it("every placeholder is computed or a known field", () => {
    const known = new Set([...COMPUTED, ...ALL_DOC_FIELDS.map((f) => f.name)]);
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

  it("defaults the contract and agreement dates to the hire date, with the weekday", () => {
    const eff = effectiveFieldValues(baseEmployee());
    expect(eff.contractDate).toBe("2026-02-01");
    expect(eff.agreementDate).toBe("2026-02-01");
    expect(documentValues(baseEmployee()).agreementDay).toBe("الأحد");
    expect(weekdayAr("2026-02-01")).toBe("الأحد");
    expect(weekdayAr(undefined)).toBe("");
  });

  it("shows the system contract number, name and salary, and lets the user change them", () => {
    const d = {
      ...baseEmployee(),
      fields: { contractNo: "CT-2026-99999", basicSalary: "7000.00" },
    };
    const html = renderDocument("contract", { ...d, fields: { ...manual, ...d.fields } });
    expect(html).toContain("CT-2026-99999");
    expect(html).toContain("7,000.00 جنيه");
    expect(html).toContain("أحمد يوسف");
    expect(documentValues(baseEmployee()).contractNo).toBe("CT-2026-00012");
  });

  it("an override of the agreement date also changes its weekday", () => {
    const d = { ...employee, fields: { ...manual, agreementDate: "2026-03-02" } };
    expect(documentValues(d).agreementDay).toBe("الاثنين");
  });

  it("stores only the values that differ from the system default", () => {
    const defaults = defaultFieldValues(baseEmployee());
    const draft = { ...defaults, basicSalary: "7000.00", nationality: "مصري" };
    expect(overridesFrom(defaults, draft)).toEqual({ basicSalary: "7000.00", nationality: "مصري" });
    expect(overridesFrom(defaults, { ...defaults })).toEqual({});
  });

  it("an open-ended contract prints غير محدد and needs no end date", () => {
    const d = {
      ...baseEmployee(),
      contractType: "indefinite",
      contractEndDate: null,
      fields: manual,
    };
    expect(documentValues(d).endDate).toBe("غير محدد");
    expect(documentValues(d).checkIndefinite).toBe("☑");
    expect(missingFields("contract", d)).not.toContain("تاريخ انتهاء العقد");
  });

  it("asks for the contract type and number when there is no current contract", () => {
    const missing = missingFields("contract", {
      ...baseEmployee(),
      contractType: null,
      contractNo: null,
      basicSalary: null,
      fields: {},
    });
    expect(missing).toContain("نوع العقد");
    expect(missing).toContain("رقم العقد");
    expect(missing).toContain("الأجر الأساسي الشهري");
    expect(missing).not.toContain("البدلات");
  });

  it("lists the company fields an annex still needs", () => {
    expect(missingFields("internalRules", { ...employee, company: {} })).toContain("رقم الإصدار");
  });

  it("prints select fields as a ticked checkbox list", () => {
    const html = renderDocument("contract", {
      ...employee,
      fields: { ...manual, workMode: "هجين" },
    });
    expect(html).toContain("☑ هجين");
    expect(html).toContain("☐ مقر الشركة");
  });

  it("does not print the employee name on acknowledgment or signature lines", () => {
    for (const key of ["internalRules", "annex1", "annex2"] as const) {
      expect(renderDocument(key, employee), key).not.toContain("أحمد يوسف");
    }
    for (const key of ["contract", "receiptA", "receiptB"] as const) {
      expect(renderDocument(key, employee).split("أحمد يوسف").length - 1, key).toBe(1);
    }
  });

  it("escapes employee text so it cannot inject markup", () => {
    const html = renderDocument("receiptA", {
      ...employee,
      fullName: "<script>x</script>",
    });
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("validates saved fields by type, normalizes money and drops unknown keys", () => {
    const ok = sanitizeFields(EMPLOYEE_DOC_FIELDS, {
      contractDate: "2026-02-03",
      payMethod: "نقدًا",
      basicSalary: "5,000",
      x: "y",
    });
    expect(ok).toEqual({
      value: { contractDate: "2026-02-03", payMethod: "نقدًا", basicSalary: "5000.00" },
    });
    expect("error" in sanitizeFields(EMPLOYEE_DOC_FIELDS, { contractDate: "31/12/2026" })).toBe(
      true,
    );
    expect("error" in sanitizeFields(EMPLOYEE_DOC_FIELDS, { payMethod: "شيك" })).toBe(true);
    expect("error" in sanitizeFields(EMPLOYEE_DOC_FIELDS, { basicSalary: "abc" })).toBe(true);
    expect("error" in sanitizeFields(EMPLOYEE_DOC_FIELDS, { notes: "x".repeat(2001) })).toBe(true);
  });

  it("formats money and validates keys", () => {
    expect(formatMoney("1234.5")).toBe("1,234.50 جنيه");
    expect(formatMoney(null)).toBe("");
    expect(isDocumentKey("contract")).toBe(true);
    expect(isDocumentKey("../secret")).toBe(false);
  });
});

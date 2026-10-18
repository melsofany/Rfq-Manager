import { describe, it, expect } from "vitest";
import { DOCUMENT_TEMPLATES, COMPANY_LOGO_DATA_URL } from "../modules/hr/document-templates";
import {
  DOCUMENT_KEYS,
  documentValues,
  formatMoney,
  isDocumentKey,
  renderDocument,
  type DocumentData,
} from "../modules/hr/document-logic";

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
};

describe("employee documents", () => {
  it("has a template for every key and no leftover unknown placeholders", () => {
    for (const key of DOCUMENT_KEYS) {
      expect(DOCUMENT_TEMPLATES[key].length).toBeGreaterThan(1000);
      const html = renderDocument(key, employee);
      expect(html).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it("fills the employee data into the contract", () => {
    const html = renderDocument("contract", employee);
    expect(html).toContain("أحمد يوسف");
    expect(html).toContain("29001011234567");
    expect(html).toContain("01/03/2024");
    expect(html).toContain("31/12/2026");
    expect(html).toContain("5,000.00 جنيه");
    expect(html).toContain("6,500.00 جنيه");
    expect(html).toContain(COMPANY_LOGO_DATA_URL);
  });

  it("checks the matching contract type box only", () => {
    expect(documentValues({ ...employee, contractType: "fixed" }).checkFixed).toBe("☑");
    expect(documentValues({ ...employee, contractType: "fixed" }).checkIndefinite).toBe("☐");
    expect(documentValues({ ...employee, contractType: "indefinite" }).checkIndefinite).toBe("☑");
  });

  it("shows an open-ended contract end as غير محدد", () => {
    const v = documentValues({ ...employee, contractType: "indefinite", contractEndDate: null });
    expect(v.endDate).toBe("غير محدد");
  });

  it("leaves unknown fields blank for handwriting", () => {
    const v = documentValues({
      ...employee,
      nationalId: null,
      address: null,
      contractEndDate: null,
    });
    expect(v.nationalId).toBe("");
    expect(v.address).toBe("");
    expect(v.endDate).toBe("");
  });

  it("escapes employee text so it cannot inject markup", () => {
    const html = renderDocument("receiptA", { ...employee, fullName: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("formats money and validates keys", () => {
    expect(formatMoney("1234.5")).toBe("1,234.50 جنيه");
    expect(formatMoney(null)).toBe("");
    expect(isDocumentKey("contract")).toBe(true);
    expect(isDocumentKey("../secret")).toBe(false);
  });
});

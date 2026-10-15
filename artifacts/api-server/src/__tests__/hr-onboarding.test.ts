import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  hrEmployeesTable: {},
  hrEmployeeProfilesTable: {},
  hrContractsTable: {},
  hrBankAccountsTable: {},
  hrDisciplinaryCasesTable: {},
  hrCaseNotesTable: {},
  hrPayAdjustmentsTable: {},
  hrLeaveTypesTable: {},
  hrLeaveRequestsTable: {},
  hrAttendanceDevicesTable: {},
  hrAttendancePunchesTable: {},
  employeesTable: {},
}));
vi.mock("../shared/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { encryptField, decryptField, last4, isHrKeyConfigured } from "../shared/hr-crypto";
import {
  isValidNationalId,
  isValidEgyptianIban,
  isValidAccountNo,
  contractDatesError,
  isValidSalary,
} from "../modules/hr/onboarding-logic";
import { parseOnboard } from "../modules/hr/onboarding-routes";

beforeAll(() => {
  process.env.HR_DATA_KEY = Buffer.alloc(32, 7).toString("base64");
});

const goodBody = () => ({
  employee: {
    fullName: "أحمد يوسف",
    jobTitle: "مندوب",
    department: "المبيعات",
    hireDate: "2026-10-01",
    phone: "01000000000",
    biometricPin: "12",
  },
  profile: {
    nationalId: "29001011234567",
    dateOfBirth: "1990-01-01",
    gender: "male",
    address: "القاهرة",
    emergencyContactName: "ali",
    emergencyContactPhone: "0100",
    socialInsuranceNo: "123",
    healthInsuranceNo: "456",
  },
  contract: {
    contractType: "indefinite",
    startDate: "2026-10-01",
    endDate: null,
    probationEndDate: null,
    basicSalary: 5000,
    allowances: 500,
  },
  bank: {
    bankName: "بنك مصر",
    accountHolder: "أحمد يوسف",
    accountNo: "1234 5678 9012",
    iban: "eg 12 3456 7890 1234 5678 9012 3456 7",
  },
});

describe("encryption of sensitive HR fields", () => {
  it("round-trips and never returns the plain text inside the payload", () => {
    const enc = encryptField("29001011234567");
    expect(enc).not.toContain("29001011234567");
    expect(decryptField(enc)).toBe("29001011234567");
  });
  it("uses a fresh IV each time", () => {
    expect(encryptField("123456")).not.toBe(encryptField("123456"));
  });
  it("detects tampering", () => {
    const enc = encryptField("secret");
    const parts = enc.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptField(parts.join(":"))).toThrow();
  });
  it("reports key presence", () => {
    expect(isHrKeyConfigured()).toBe(true);
    const saved = process.env.HR_DATA_KEY;
    delete process.env.HR_DATA_KEY;
    expect(isHrKeyConfigured()).toBe(false);
    process.env.HR_DATA_KEY = saved;
  });
  it("keeps only last four digits for display", () => {
    expect(last4("1234 5678 9012")).toBe("9012");
  });
});

describe("field validation", () => {
  it("national ID must be exactly 14 digits", () => {
    expect(isValidNationalId("29001011234567")).toBe(true);
    expect(isValidNationalId("2900101123456")).toBe(false);
    expect(isValidNationalId("2900101123456a")).toBe(false);
  });
  it("IBAN must be EG + 27 digits", () => {
    expect(isValidEgyptianIban("EG123456789012345678901234567")).toBe(true);
    expect(isValidEgyptianIban("DE123456789012345678901234567")).toBe(false);
    expect(isValidEgyptianIban("EG1234")).toBe(false);
  });
  it("account number is 6–30 digits", () => {
    expect(isValidAccountNo("123456")).toBe(true);
    expect(isValidAccountNo("12345")).toBe(false);
    expect(isValidAccountNo("12a456")).toBe(false);
  });
  it("salary must be non-negative with at most two decimals", () => {
    expect(isValidSalary(5000)).toBe(true);
    expect(isValidSalary(12.5)).toBe(true);
    expect(isValidSalary(-1)).toBe(false);
    expect(isValidSalary(1.234)).toBe(false);
  });
});

describe("contract dates", () => {
  it("fixed-term contracts need an end after the start", () => {
    expect(contractDatesError("fixed", "2026-10-01", null, null)).not.toBeNull();
    expect(contractDatesError("fixed", "2026-10-01", "2026-09-30", null)).not.toBeNull();
    expect(contractDatesError("fixed", "2026-10-01", "2027-09-30", null)).toBeNull();
  });
  it("probation must end inside the contract", () => {
    expect(contractDatesError("probation", "2026-10-01", null, null)).not.toBeNull();
    expect(
      contractDatesError("probation", "2026-10-01", "2027-01-01", "2027-03-01"),
    ).not.toBeNull();
    expect(contractDatesError("probation", "2026-10-01", "2027-01-01", "2026-12-01")).toBeNull();
  });
  it("indefinite contracts need no end date", () => {
    expect(contractDatesError("indefinite", "2026-10-01", null, null)).toBeNull();
  });
});

describe("onboarding payload", () => {
  it("accepts a complete valid hire and normalizes account and IBAN", () => {
    const r = parseOnboard(goodBody());
    expect("input" in r).toBe(true);
    if ("input" in r) {
      expect(r.input.bank.accountNo).toBe("123456789012");
      expect(r.input.bank.iban).toBe("EG123456789012345678901234567");
    }
  });
  it("refuses a hire without a national ID", () => {
    const b = goodBody();
    b.profile.nationalId = "";
    expect(parseOnboard(b)).toHaveProperty("error");
  });
  it("refuses a bad IBAN and a bad account number", () => {
    const b1 = goodBody();
    b1.bank.iban = "DE00";
    expect(parseOnboard(b1)).toHaveProperty("error");
    const b2 = goodBody();
    b2.bank.accountNo = "12";
    expect(parseOnboard(b2)).toHaveProperty("error");
  });
  it("refuses an unknown contract type", () => {
    const b = goodBody();
    (b.contract as any).contractType = "freelance";
    expect(parseOnboard(b)).toHaveProperty("error");
  });
});

describe("onboarding: number, birth date and photo", () => {
  it("refuses a hire without a date of birth (needed for the employee number)", () => {
    const b = goodBody();
    b.profile.dateOfBirth = null as any;
    expect(parseOnboard(b)).toHaveProperty("error");
  });
  it("refuses a birth date too close to the hire date", () => {
    const b = goodBody();
    b.profile.dateOfBirth = "2020-01-01";
    expect(parseOnboard(b)).toHaveProperty("error");
  });
  it("carries an accepted photo into the parsed input", () => {
    const b: any = { ...goodBody(), photo: "data:image/webp;base64,UklGRg==" };
    const r = parseOnboard(b);
    expect("input" in r).toBe(true);
    if ("input" in r) expect(r.input.photo?.mime).toBe("image/webp");
  });
  it("refuses a bad photo", () => {
    const b: any = { ...goodBody(), photo: "data:application/pdf;base64,JVBERi0=" };
    expect(parseOnboard(b)).toHaveProperty("error");
  });
});

import { describe, it, expect } from "vitest";
import {
  compareRegistrationEntries,
  describeFields,
  heldDataSnapshot,
  isSupplierRegistrationComplete,
  missingRegistrationFields,
  normalizeForCompare,
  validateRegistrationSubmission,
  validateRegistrationValue,
  REGISTRATION_FIELD_LABELS,
  type RegistrationField,
} from "../shared/supplier-registration";

/** A supplier with every required field filled. */
const complete = {
  commercialRegister: "12345",
  taxRegistration: "67890",
  bankName: "NBE",
  bankAccountHolder: "Acme Co",
  bankAccountNumber: "1234567890",
  iban: "EG380019000500000000263180002",
  swiftCode: "NBEGEGCX",
  bankBranch: "Cairo",
};

describe("supplier registration rules", () => {
  it("treats a fully-registered supplier as complete", () => {
    expect(missingRegistrationFields(complete)).toEqual([]);
    expect(isSupplierRegistrationComplete(complete)).toBe(true);
  });

  it("treats a brand-new supplier (all null) as incomplete with every field missing", () => {
    const missing = missingRegistrationFields({});
    // iban and bankAccountNumber collapse into ONE requirement (at least one).
    expect(missing).toContain("bankName");
    expect(missing).toContain("bankAccountHolder");
    expect(missing).toContain("commercialRegister");
    expect(missing.filter((f) => f === "iban" || f === "bankAccountNumber")).toEqual([
      "bankAccountNumber",
    ]);
  });

  it("accepts an IBAN alone, without an account number", () => {
    const { bankAccountNumber: _drop, ...noAccount } = complete;
    expect(missingRegistrationFields(noAccount)).toEqual([]);
  });

  it("accepts an account number alone, without an IBAN", () => {
    const { iban: _drop, ...noIban } = complete;
    expect(missingRegistrationFields(noIban)).toEqual([]);
  });

  it("treats a whitespace-only value as missing, not as data", () => {
    expect(missingRegistrationFields({ ...complete, bankName: "   " })).toEqual(["bankName"]);
  });

  it("snapshots exactly what the company holds, empty values as null", () => {
    const snap = heldDataSnapshot({ ...complete, bankName: "  ", iban: null });
    expect(snap.bankName).toBeNull();
    expect(snap.iban).toBeNull();
    expect(snap.bankAccountHolder).toBe("Acme Co");
  });

  it("validates IBAN, account number and SWIFT formats", () => {
    expect(validateRegistrationValue("iban", "EG380019000500000000263180002")).toBeNull();
    expect(validateRegistrationValue("iban", "EG123")).toMatch(/IBAN/);
    expect(validateRegistrationValue("bankAccountNumber", "1234567890")).toBeNull();
    expect(validateRegistrationValue("bankAccountNumber", "12")).toMatch(/6 إلى 30/);
    expect(validateRegistrationValue("swiftCode", "NBEGEGCX")).toBeNull();
    expect(validateRegistrationValue("swiftCode", "NBE")).toMatch(/السويف/);
    expect(validateRegistrationValue("bankName", "")).toMatch(/مطلوب/);
  });

  it("rejects a submission with an invalid field and reports it per field", () => {
    const res = validateRegistrationSubmission({ bankName: "NBE", iban: "nope" }, [
      "bankName",
      "iban",
    ] as RegistrationField[]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(Object.keys(res.errors)).toEqual(["iban"]);
    }
  });

  it("accepts a submission where every required field is valid", () => {
    const res = validateRegistrationSubmission(complete, [
      "bankName",
      "iban",
    ] as RegistrationField[]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ bankName: "NBE", iban: complete.iban });
  });

  it("compares entries forgivingly about spacing/case but strictly about content", () => {
    const first = { iban: "EG380019000500000000263180002", bankName: "Acme  Co" };
    const sameButFormatted = { iban: "EG38 0019 0005 0000 0000 2631 8000 2", bankName: "acme co" };
    expect(
      compareRegistrationEntries(first, sameButFormatted, [
        "iban",
        "bankName",
      ] as RegistrationField[]),
    ).toEqual([]);
  });

  it("flags a genuine difference in any field", () => {
    const first = { iban: "EG380019000500000000263180002", bankName: "Acme Co" };
    const second = { iban: "EG380019000500000000263180003", bankName: "Acme Co" };
    expect(
      compareRegistrationEntries(first, second, ["iban", "bankName"] as RegistrationField[]),
    ).toEqual(["iban"]);
  });

  it("normalises an account number with dashes to the bare digits", () => {
    expect(normalizeForCompare("bankAccountNumber", "1234-5678-90")).toBe("1234567890");
  });

  it("names the fields in Arabic for the mismatch notice", () => {
    expect(describeFields(["bankAccountNumber", "iban"])).toBe(
      `${REGISTRATION_FIELD_LABELS.bankAccountNumber}، ${REGISTRATION_FIELD_LABELS.iban}`,
    );
  });
});

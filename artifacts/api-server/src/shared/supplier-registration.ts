/**
 * استكمال بيانات المورد — pure rules for the supplier self-registration link.
 *
 * The whole feature rests on one claim: a purchase order cannot be sent to a
 * supplier we cannot pay. So "has the supplier registered his data?" is a
 * decision, not a display string — it is computed here, once, and both the PO
 * dispatch gate and the supplier page read the SAME answer. Two copies of this
 * rule would let the page say "مكتمل" while the dispatch still refuses (or the
 * reverse), which is the class of defect this repository keeps recording: a
 * surface that describes something untrue.
 *
 * Everything in this module is pure — no database, no model — so it is unit
 * tested directly and cannot drift with the schema.
 */

/** The bank/commercial fields a supplier must have before we can pay him. */
export const REQUIRED_REGISTRATION_FIELDS = [
  "commercialRegister",
  "taxRegistration",
  "bankName",
  "bankAccountHolder",
  "bankAccountNumber",
  "iban",
  "swiftCode",
  "bankBranch",
] as const;

export type RegistrationField = (typeof REQUIRED_REGISTRATION_FIELDS)[number];

/** Arabic labels — used in messages, the link page and the audit trail. */
export const REGISTRATION_FIELD_LABELS: Record<RegistrationField, string> = {
  commercialRegister: "رقم السجل التجاري",
  taxRegistration: "رقم التسجيل الضريبي",
  bankName: "اسم البنك",
  bankAccountHolder: "اسم صاحب الحساب كما هو مسجَّل لدى البنك",
  bankAccountNumber: "رقم الحساب البنكي",
  iban: "رقم IBAN",
  swiftCode: "السويف كود (SWIFT/BIC)",
  bankBranch: "اسم الفرع",
};

/** Fields that carry a bank value where a numeric format can be checked. */
export const REGISTRATION_FIELD_HINTS: Record<RegistrationField, string> = {
  commercialRegister: "أرقام فقط، مثال: 123456",
  taxRegistration: "أرقام فقط، مثال: 432972587",
  bankName: "اسم البنك كما هو مكتوب على الحساب",
  bankAccountHolder: "يجب أن يطابق الاسم المسجَّل لدى البنك تمامًا",
  bankAccountNumber: "6 إلى 30 رقمًا، بدون مسافات أو شرطات",
  iban: "يبدأ بـ EG ويتكون من 29 خانة، مثال: EG380019000500000000263180002",
  swiftCode: "8 أو 11 خانة، حروف وأرقام لاتينية",
  bankBranch: "اسم الفرع الذي به الحساب",
};

/** A supplier row, reduced to the fields this module reasons about. */
export interface RegistrationHolder {
  commercialRegister?: string | null;
  taxRegistration?: string | null;
  bankName?: string | null;
  bankAccountHolder?: string | null;
  bankAccountNumber?: string | null;
  iban?: string | null;
  swiftCode?: string | null;
  bankBranch?: string | null;
}

/** A submitted/held value map, keyed by field name. */
export type RegistrationValues = Partial<Record<RegistrationField, string | null>>;

/** Trim; an all-whitespace value is absent, never a value. */
export function cleanValue(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/**
 * Which required fields are still missing.
 *
 * IBAN and the account number are alternatives in Egyptian banking (a local
 * account may have no IBAN yet, and an IBAN alone identifies the account), so
 * the rule is: at least ONE of them, plus every other field. Requiring both
 * would block a supplier whose bank only issued one — a false refusal, and the
 * operator cannot argue with a form.
 */
export function missingRegistrationFields(supplier: RegistrationHolder): RegistrationField[] {
  const missing: RegistrationField[] = [];
  for (const field of REQUIRED_REGISTRATION_FIELDS) {
    if (field === "iban" || field === "bankAccountNumber") continue;
    if (!cleanValue(supplier[field])) missing.push(field);
  }
  if (!cleanValue(supplier.bankAccountNumber) && !cleanValue(supplier.iban)) {
    // Report the account number as the missing one — it is the field the
    // supplier is most likely to have, and naming a single field keeps the
    // request form unambiguous.
    missing.push("bankAccountNumber");
  }
  return missing;
}

/** True when the supplier has everything needed to be paid. */
export function isSupplierRegistrationComplete(supplier: RegistrationHolder): boolean {
  return missingRegistrationFields(supplier).length === 0;
}

/** The held data snapshot the supplier is shown read-only on the link page. */
export function heldDataSnapshot(supplier: RegistrationHolder): RegistrationValues {
  return {
    commercialRegister: cleanValue(supplier.commercialRegister) || null,
    taxRegistration: cleanValue(supplier.taxRegistration) || null,
    bankName: cleanValue(supplier.bankName) || null,
    bankAccountHolder: cleanValue(supplier.bankAccountHolder) || null,
    bankAccountNumber: cleanValue(supplier.bankAccountNumber) || null,
    iban: cleanValue(supplier.iban) || null,
    swiftCode: cleanValue(supplier.swiftCode) || null,
    bankBranch: cleanValue(supplier.bankBranch) || null,
  };
}

/** Validate one field's format. Returns an Arabic error, or null when fine. */
export function validateRegistrationValue(
  field: RegistrationField,
  raw: string | null | undefined,
): string | null {
  const value = cleanValue(raw);
  if (!value) return "هذا الحقل مطلوب";

  switch (field) {
    case "iban": {
      const compact = value.replace(/\s+/g, "").toUpperCase();
      if (!/^EG\d{27}$/.test(compact)) {
        return "رقم IBAN غير صحيح — يجب أن يبدأ بـ EG ويتكون من 29 خانة";
      }
      return null;
    }
    case "bankAccountNumber": {
      const digits = value.replace(/[\s-]/g, "");
      if (!/^\d{6,30}$/.test(digits)) {
        return "رقم الحساب البنكي يجب أن يكون من 6 إلى 30 رقمًا";
      }
      return null;
    }
    case "swiftCode": {
      const code = value.replace(/\s+/g, "").toUpperCase();
      if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(code)) {
        return "السويف كود غير صحيح — 8 أو 11 خانة (حروف وأرقام)";
      }
      return null;
    }
    case "commercialRegister":
    case "taxRegistration": {
      if (!/\d/.test(value)) return "يجب أن يحتوي على أرقام";
      return null;
    }
    default:
      return null;
  }
}

/**
 * Validate a whole submission. `required` lets the caller ask for only the
 * missing fields (a partial top-up) while a full registration asks for all.
 */
export function validateRegistrationSubmission(
  values: RegistrationValues,
  required: readonly RegistrationField[],
): { ok: true; data: Record<string, string> } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const data: Record<string, string> = {};

  for (const field of required) {
    const err = validateRegistrationValue(field, values[field]);
    if (err) errors[field] = err;
    else data[field] = cleanValue(values[field]);
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, data };
}

/**
 * Compare two entries of the same form, field by field.
 *
 * This is the double-entry confirmation the operator asked for: the supplier
 * types the data twice and a mismatch is refused. Comparison is deliberately
 * forgiving about *presentation* and strict about *content* — case, spacing and
 * separators are ignored (a supplier retyping `EG38 0019 0005…` and
 * `EG3800190005000…` means the same account), while any difference in the
 * digits or letters themselves is a mismatch. A comparison that was too strict
 * would refuse a correct confirmation, which is the worse failure: the supplier
 * would be stuck with no way forward.
 */
export function compareRegistrationEntries(
  first: RegistrationValues,
  second: RegistrationValues,
  fields: readonly RegistrationField[],
): RegistrationField[] {
  const mismatched: RegistrationField[] = [];
  for (const field of fields) {
    if (normalizeForCompare(field, first[field]) !== normalizeForCompare(field, second[field])) {
      mismatched.push(field);
    }
  }
  return mismatched;
}

/** Presentation-insensitive form of a value, per field. */
export function normalizeForCompare(
  field: RegistrationField,
  raw: string | null | undefined,
): string {
  const value = cleanValue(raw);
  if (!value) return "";
  switch (field) {
    case "iban":
    case "swiftCode":
      return value.replace(/\s+/g, "").toUpperCase();
    case "bankAccountNumber":
      return value.replace(/[\s-]/g, "");
    case "commercialRegister":
    case "taxRegistration":
      return value.replace(/[\s-]/g, "");
    default:
      // Names and free text: collapse runs of whitespace, case-insensitive, so
      // «شركة  النور » and «شركة النور» are the same company name.
      return value.replace(/\s+/g, " ").toLowerCase();
  }
}

/** Arabic sentence naming the fields, for the mismatch notice. */
export function describeFields(fields: readonly RegistrationField[]): string {
  return fields.map((f) => REGISTRATION_FIELD_LABELS[f]).join("، ");
}

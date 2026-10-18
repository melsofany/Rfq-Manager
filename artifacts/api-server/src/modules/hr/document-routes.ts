/**
 * Employee documents.
 *   GET  /hr/employees/:id/documents/:key   → printable A4 HTML for one employee
 *   GET  /hr/employees/:id/document-fields  → saved fields and what each document still needs
 *   PUT  /hr/employees/:id/document-fields  → save the employee's fields
 * Keys: contract, internalRules, annex1, annex2, receiptA, receiptB.
 * Company values come from Settings (document_company).
 */
import { Router, type IRouter } from "express";
import {
  db,
  hrEmployeesTable,
  hrEmployeeProfilesTable,
  hrContractsTable,
  hrEmployeeDocumentFieldsTable,
  hrSettingsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import { decryptField, isHrKeyConfigured } from "../../shared/hr-crypto";
import { withoutAutoLinks } from "./card-logic";
import {
  DOCUMENT_KEYS,
  DOCUMENT_TITLES,
  defaultFieldValues,
  effectiveFieldValues,
  isDocumentKey,
  missingFields,
  overridesFrom,
  renderDocument,
  type DocumentData,
} from "./document-logic";
import { COMPANY_DOC_FIELDS, EMPLOYEE_DOC_FIELDS, sanitizeFields } from "./document-fields";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

const DOC_HEADERS = {
  "Cache-Control": "private, no-store",
  // Documents never run scripts; the page loads only the images embedded in it.
  "Content-Security-Policy":
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:",
};

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function companyValues(): Promise<Record<string, string>> {
  const [row] = await db
    .select()
    .from(hrSettingsTable)
    .where(eq(hrSettingsTable.key, "document_company"))
    .limit(1);
  const value = row?.value as Record<string, string> | null | undefined;
  return value ?? {};
}

/** Everything a document needs for one employee; null when the employee does not exist. */
async function loadDocumentData(id: number): Promise<DocumentData | null> {
  const [emp] = await db
    .select()
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, id))
    .limit(1);
  if (!emp) return null;
  const [profile] = await db
    .select({
      nationalIdEnc: hrEmployeeProfilesTable.nationalIdEnc,
      address: hrEmployeeProfilesTable.address,
    })
    .from(hrEmployeeProfilesTable)
    .where(eq(hrEmployeeProfilesTable.employeeId, id))
    .limit(1);
  const [contract] = await db
    .select()
    .from(hrContractsTable)
    .where(and(eq(hrContractsTable.employeeId, id), eq(hrContractsTable.isCurrent, true)))
    .limit(1);
  const [saved] = await db
    .select()
    .from(hrEmployeeDocumentFieldsTable)
    .where(eq(hrEmployeeDocumentFieldsTable.employeeId, id))
    .limit(1);
  // The national ID is printed only when the HR encryption key is configured.
  const nationalId =
    profile?.nationalIdEnc && isHrKeyConfigured() ? decryptField(profile.nationalIdEnc) : null;
  return {
    fullName: emp.fullName,
    nationalId,
    address: profile?.address ?? null,
    phone: emp.phone,
    jobTitle: emp.jobTitle,
    department: emp.department,
    hireDate: emp.hireDate,
    contractType: contract?.contractType ?? null,
    // Contract number is generated from the contract record: CT-<start year>-<id>.
    contractNo: contract
      ? `CT-${contract.startDate.slice(0, 4)}-${String(contract.id).padStart(5, "0")}`
      : null,
    contractEndDate: contract?.endDate ?? null,
    probationEndDate: contract?.probationEndDate ?? null,
    basicSalary: contract?.basicSalary ?? null,
    allowances: contract?.allowances ?? null,
    incentive: contract?.incentive ?? null,
    fields: (saved?.fields as Record<string, string> | undefined) ?? {},
    company: await companyValues(),
  };
}

router.get("/hr/employees/:id/documents/:key", async (req, res): Promise<void> => {
  const id = parseId(String(req.params.id));
  const key = String(req.params.key);
  if (id === null) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  if (!isDocumentKey(key)) {
    res.status(404).json({ error: "المستند غير موجود" });
    return;
  }
  const data = await loadDocumentData(id);
  if (!data) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  for (const [h, v] of Object.entries(DOC_HEADERS)) res.setHeader(h, v);
  res.send(withoutAutoLinks(renderDocument(key, data)));
});

router.get("/hr/document-definitions", (_req, res): void => {
  res.json({
    keys: DOCUMENT_KEYS,
    titles: DOCUMENT_TITLES,
    employee: EMPLOYEE_DOC_FIELDS,
    company: COMPANY_DOC_FIELDS,
  });
});

router.get("/hr/employees/:id/document-fields", async (req, res): Promise<void> => {
  const id = parseId(String(req.params.id));
  if (id === null) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  const data = await loadDocumentData(id);
  if (!data) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  const missing = Object.fromEntries(DOCUMENT_KEYS.map((k) => [k, missingFields(k, data)]));
  res.json({
    defaults: defaultFieldValues(data),
    fields: data.fields,
    effective: effectiveFieldValues(data),
    company: data.company,
    missing,
  });
});

router.put("/hr/employees/:id/document-fields", async (req, res): Promise<void> => {
  const id = parseId(String(req.params.id));
  if (id === null) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  const [emp] = await db
    .select({ id: hrEmployeesTable.id })
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, id))
    .limit(1);
  if (!emp) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  const checked = sanitizeFields(EMPLOYEE_DOC_FIELDS, req.body?.fields);
  if ("error" in checked) {
    res.status(400).json({ error: checked.error });
    return;
  }
  // Store only what differs from the system default, so untouched fields keep following the record.
  const data = await loadDocumentData(id);
  if (!data) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  const overrides = overridesFrom(defaultFieldValues(data), checked.value);
  await db
    .insert(hrEmployeeDocumentFieldsTable)
    .values({ employeeId: id, fields: overrides })
    .onConflictDoUpdate({
      target: hrEmployeeDocumentFieldsTable.employeeId,
      set: { fields: overrides, updatedAt: new Date() },
    });
  res.json({ fields: overrides });
});

export default router;

/**
 * Employee documents output.
 *   GET /hr/employees/:id/documents/:key → printable A4 HTML for one employee
 * Keys: contract, internalRules, annex1, annex2, receiptA, receiptB.
 */
import { Router, type IRouter } from "express";
import { db, hrEmployeesTable, hrEmployeeProfilesTable, hrContractsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import { decryptField, isHrKeyConfigured } from "../../shared/hr-crypto";
import { withoutAutoLinks } from "./card-logic";
import { isDocumentKey, renderDocument, type DocumentData } from "./document-logic";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

router.get("/hr/employees/:id/documents/:key", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const key = String(req.params.key);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  if (!isDocumentKey(key)) {
    res.status(404).json({ error: "المستند غير موجود" });
    return;
  }
  const [emp] = await db
    .select()
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, id))
    .limit(1);
  if (!emp) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
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
  // The national ID is printed only when the HR encryption key is configured.
  const nationalId =
    profile?.nationalIdEnc && isHrKeyConfigured() ? decryptField(profile.nationalIdEnc) : null;
  const data: DocumentData = {
    fullName: emp.fullName,
    nationalId,
    address: profile?.address ?? null,
    phone: emp.phone,
    jobTitle: emp.jobTitle,
    department: emp.department,
    hireDate: emp.hireDate,
    contractType: contract?.contractType ?? null,
    contractEndDate: contract?.endDate ?? null,
    probationEndDate: contract?.probationEndDate ?? null,
    basicSalary: contract?.basicSalary ?? null,
    allowances: contract?.allowances ?? null,
    incentive: contract?.incentive ?? null,
  };
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  // Documents never run scripts; the page loads only the images embedded in it.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:",
  );
  res.send(withoutAutoLinks(renderDocument(key, data)));
});

export default router;

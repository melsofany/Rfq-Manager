/**
 * Employee card output.
 *   GET /hr/employees/:id/card/front  → printable HTML for the front side
 *   GET /hr/employees/:id/card/back   → printable HTML for the back side
 * Designs come from Settings (card_front / card_back); the built-in default is used when none is set.
 */
import { Router, type IRouter } from "express";
import {
  db,
  hrEmployeesTable,
  hrEmployeePhotosTable,
  hrEmployeeProfilesTable,
  hrContractsTable,
  hrSettingsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import { decryptField, isHrKeyConfigured } from "../../shared/hr-crypto";
import {
  DEFAULT_CARD_BACK,
  DEFAULT_CARD_FRONT,
  renderCardHtml,
  withoutAutoLinks,
  formatCardDate,
  PRINT_CARD_SIZE,
  previewCardSize,
  scaleForPrint,
  type CardData,
} from "./card-logic";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

async function designFor(side: "front" | "back"): Promise<{ html: string; uploaded: boolean }> {
  const key = side === "front" ? "card_front" : "card_back";
  const [row] = await db
    .select()
    .from(hrSettingsTable)
    .where(eq(hrSettingsTable.key, key))
    .limit(1);
  const value = row?.value as { html?: string } | null | undefined;
  if (value?.html) return { html: value.html, uploaded: true };
  return { html: side === "front" ? DEFAULT_CARD_FRONT : DEFAULT_CARD_BACK, uploaded: false };
}

router.get("/hr/employees/:id/card/:side", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const side = String(req.params.side);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  if (side !== "front" && side !== "back") {
    res.status(404).json({ error: "وش البطاقة غير معروف" });
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
  const [photo] = await db
    .select()
    .from(hrEmployeePhotosTable)
    .where(eq(hrEmployeePhotosTable.employeeId, id))
    .limit(1);
  // The national ID is printed only when the HR encryption key is configured and the profile has one.
  const [profile] = await db
    .select({ nationalIdEnc: hrEmployeeProfilesTable.nationalIdEnc })
    .from(hrEmployeeProfilesTable)
    .where(eq(hrEmployeeProfilesTable.employeeId, id))
    .limit(1);
  const nationalId =
    profile?.nationalIdEnc && isHrKeyConfigured() ? decryptField(profile.nationalIdEnc) : null;
  const [managerRow] = await db
    .select()
    .from(hrSettingsTable)
    .where(eq(hrSettingsTable.key, "card_manager"))
    .limit(1);
  const manager = managerRow?.value as { name?: string; signature?: string | null } | null;
  // "Valid until" is the current contract's end date; open-ended contracts show "غير محدد".
  const [contract] = await db
    .select({ endDate: hrContractsTable.endDate })
    .from(hrContractsTable)
    .where(and(eq(hrContractsTable.employeeId, id), eq(hrContractsTable.isCurrent, true)))
    .limit(1);
  const validUntil = contract ? (formatCardDate(contract.endDate) ?? "غير محدد") : null;
  const data: CardData = {
    validUntil,
    managerName: manager?.name ?? "",
    managerSignature: manager?.signature ?? null,
    fullName: emp.fullName,
    nationalId,
    employeeNo: emp.employeeNo,
    jobTitle: emp.jobTitle,
    department: emp.department,
    hireDate: emp.hireDate,
    photo: photo ? `data:${photo.mimeType};base64,${photo.dataB64}` : null,
  };
  const design = await designFor(side);
  const rendered = renderCardHtml(design.html, data);
  // ?width=<px> asks for an on-screen preview that fits that width; without it the card is print-sized.
  const requested = Number(req.query.width);
  const size =
    Number.isFinite(requested) && requested > 0 ? previewCardSize(requested) : PRINT_CARD_SIZE;
  const html = withoutAutoLinks(design.uploaded ? scaleForPrint(rendered, size) : rendered);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  // Printed cards never run scripts and load only the images embedded in the page.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:",
  );
  res.send(html);
});

export default router;

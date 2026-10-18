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
  hrSettingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import { decryptField, isHrKeyConfigured } from "../../shared/hr-crypto";
import { DEFAULT_CARD_BACK, DEFAULT_CARD_FRONT, renderCardHtml, type CardData } from "./card-logic";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

/** Uploaded designs are drawn at 1060px wide; this scales them to the 85.6 × 54 mm card size. */
const UPLOADED_CARD_ZOOM = 0.3052;

function scaleForPrint(html: string): string {
  const style = `<style>html,body{margin:0!important;padding:0!important;background:#fff!important}html{zoom:${UPLOADED_CARD_ZOOM}}</style>`;
  return html.includes("</head>") ? html.replace("</head>", `${style}</head>`) : style + html;
}

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
  const data: CardData = {
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
  const html = design.uploaded ? scaleForPrint(rendered) : rendered;
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

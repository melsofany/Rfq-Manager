import { Router } from "express";
import multer from "multer";
import {
  db,
  rfqAttachmentsTable,
  offerAttachmentsTable,
  sentLogTable,
  offersTable,
  auditLogTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import type { Request } from "express";

const router = Router();

const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/octet-stream",
]);

const ALLOWED_EXTS = /\.(pdf|jpg|jpeg|png|webp|gif|xlsx|xls|docx|doc|dwg|dxf|step|stp|iges|igs|svg)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 5 }, // 20 MB per file, 5 files max
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype) || ALLOWED_EXTS.test(file.originalname)) {
      cb(null, false); // will do the actual accept below — multer quirk: false = reject
      cb(null, true);
    } else {
      cb(new Error("نوع الملف غير مدعوم. الأنواع المقبولة: PDF، صور، Excel، Word، DWG"));
    }
  },
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─────────────────────────────────────────────────────────────────────────────
// RFQ Attachments  (authenticated employees)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /rfq/:id/attachments — list */
router.get("/rfq/:id/attachments", requireAuth, async (req, res): Promise<void> => {
  const rfqId = parseInt(req.params.id, 10);
  if (isNaN(rfqId)) { res.status(400).json({ error: "Invalid rfqId" }); return; }

  const rows = await db
    .select({
      id: rfqAttachmentsTable.id,
      originalName: rfqAttachmentsTable.originalName,
      mimeType: rfqAttachmentsTable.mimeType,
      size: rfqAttachmentsTable.size,
      uploadedBy: rfqAttachmentsTable.uploadedBy,
      createdAt: rfqAttachmentsTable.createdAt,
    })
    .from(rfqAttachmentsTable)
    .where(eq(rfqAttachmentsTable.rfqId, rfqId));

  res.json(rows.map(a => ({
    ...a,
    sizeLabel: formatSize(a.size),
    createdAt: a.createdAt.toISOString(),
    downloadUrl: `/api/rfq/attachments/${a.id}/download`,
  })));
});

/** POST /rfq/:id/attachments — upload (one file) */
router.post("/rfq/:id/attachments", requireAuth, upload.single("file"), async (req: Request & { session?: { employeeId?: number } }, res): Promise<void> => {
  const rfqId = parseInt(req.params.id, 10);
  if (isNaN(rfqId)) { res.status(400).json({ error: "Invalid rfqId" }); return; }
  if (!req.file) { res.status(400).json({ error: "لم يتم اختيار ملف" }); return; }

  const [att] = await db
    .insert(rfqAttachmentsTable)
    .values({
      rfqId,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      content: req.file.buffer.toString("base64"),
      uploadedBy: req.session?.employeeId ?? null,
    })
    .returning({
      id: rfqAttachmentsTable.id,
      originalName: rfqAttachmentsTable.originalName,
      mimeType: rfqAttachmentsTable.mimeType,
      size: rfqAttachmentsTable.size,
      createdAt: rfqAttachmentsTable.createdAt,
    });

  await db.insert(auditLogTable).values({
    action: "rfq.attachment.uploaded",
    entityType: "rfq",
    entityId: rfqId,
    employeeId: req.session?.employeeId ?? null,
    description: `Uploaded attachment "${req.file.originalname}" (${formatSize(req.file.size)}) to RFQ #${rfqId}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.status(201).json({
    ...att,
    sizeLabel: formatSize(att.size),
    createdAt: att.createdAt.toISOString(),
    downloadUrl: `/api/rfq/attachments/${att.id}/download`,
  });
});

/** GET /rfq/attachments/:id/download — serve file to employee */
router.get("/rfq/attachments/:id/download", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [att] = await db.select().from(rfqAttachmentsTable).where(eq(rfqAttachmentsTable.id, id));
  if (!att) { res.status(404).json({ error: "الملف غير موجود" }); return; }

  const buf = Buffer.from(att.content, "base64");
  res.setHeader("Content-Type", att.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(att.originalName)}`);
  res.setHeader("Content-Length", buf.length);
  res.send(buf);
});

/** DELETE /rfq/attachments/:id — delete */
router.delete("/rfq/attachments/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  await db.delete(rfqAttachmentsTable).where(eq(rfqAttachmentsTable.id, id));
  res.status(204).send();
});

// ─────────────────────────────────────────────────────────────────────────────
// Offer Attachments — employee-side (authenticated)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /offers/:id/attachments */
router.get("/offers/:id/attachments", requireAuth, async (req, res): Promise<void> => {
  const offerId = parseInt(req.params.id, 10);
  if (isNaN(offerId)) { res.status(400).json({ error: "Invalid offerId" }); return; }

  const rows = await db
    .select({
      id: offerAttachmentsTable.id,
      originalName: offerAttachmentsTable.originalName,
      mimeType: offerAttachmentsTable.mimeType,
      size: offerAttachmentsTable.size,
      createdAt: offerAttachmentsTable.createdAt,
    })
    .from(offerAttachmentsTable)
    .where(eq(offerAttachmentsTable.offerId, offerId));

  res.json(rows.map(a => ({
    ...a,
    sizeLabel: formatSize(a.size),
    createdAt: a.createdAt.toISOString(),
    downloadUrl: `/api/offer/attachments/${a.id}/download`,
  })));
});

/** GET /offer/attachments/:id/download */
router.get("/offer/attachments/:id/download", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [att] = await db.select().from(offerAttachmentsTable).where(eq(offerAttachmentsTable.id, id));
  if (!att) { res.status(404).json({ error: "الملف غير موجود" }); return; }

  const buf = Buffer.from(att.content, "base64");
  res.setHeader("Content-Type", att.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(att.originalName)}`);
  res.setHeader("Content-Length", buf.length);
  res.send(buf);
});

/** DELETE /offer/attachments/:id */
router.delete("/offer/attachments/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  await db.delete(offerAttachmentsTable).where(eq(offerAttachmentsTable.id, id));
  res.status(204).send();
});

// ─────────────────────────────────────────────────────────────────────────────
// Supplier-facing routes  (token-based, NO auth)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /pricing/:token/rfq-attachments — supplier views RFQ specs */
router.get("/pricing/:token/rfq-attachments", async (req, res): Promise<void> => {
  const [log] = await db
    .select({ rfqId: sentLogTable.rfqId })
    .from(sentLogTable)
    .where(eq(sentLogTable.token, req.params.token));
  if (!log) { res.status(404).json({ error: "Token not found" }); return; }

  const rows = await db
    .select({
      id: rfqAttachmentsTable.id,
      originalName: rfqAttachmentsTable.originalName,
      mimeType: rfqAttachmentsTable.mimeType,
      size: rfqAttachmentsTable.size,
      createdAt: rfqAttachmentsTable.createdAt,
    })
    .from(rfqAttachmentsTable)
    .where(eq(rfqAttachmentsTable.rfqId, log.rfqId));

  res.json(rows.map(a => ({
    ...a,
    sizeLabel: formatSize(a.size),
    createdAt: a.createdAt.toISOString(),
    downloadUrl: `/api/pricing/${req.params.token}/rfq-attachments/${a.id}/download`,
  })));
});

/** GET /pricing/:token/rfq-attachments/:attId/download — supplier downloads spec */
router.get("/pricing/:token/rfq-attachments/:attId/download", async (req, res): Promise<void> => {
  const [log] = await db
    .select({ rfqId: sentLogTable.rfqId })
    .from(sentLogTable)
    .where(eq(sentLogTable.token, req.params.token));
  if (!log) { res.status(404).json({ error: "Token not found" }); return; }

  const id = parseInt(req.params.attId, 10);
  const [att] = await db
    .select()
    .from(rfqAttachmentsTable)
    .where(and(eq(rfqAttachmentsTable.id, id), eq(rfqAttachmentsTable.rfqId, log.rfqId)));
  if (!att) { res.status(404).json({ error: "الملف غير موجود" }); return; }

  const buf = Buffer.from(att.content, "base64");
  res.setHeader("Content-Type", att.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(att.originalName)}`);
  res.setHeader("Content-Length", buf.length);
  res.send(buf);
});

/** POST /pricing/:token/offer-attachments — supplier uploads attachment with their offer */
router.post("/pricing/:token/offer-attachments", upload.single("file"), async (req, res): Promise<void> => {
  const [log] = await db
    .select({ rfqId: sentLogTable.rfqId, supplierId: sentLogTable.supplierId })
    .from(sentLogTable)
    .where(eq(sentLogTable.token, req.params.token));
  if (!log) { res.status(404).json({ error: "Token not found" }); return; }

  const [offer] = await db
    .select({ id: offersTable.id })
    .from(offersTable)
    .where(and(eq(offersTable.rfqId, log.rfqId), eq(offersTable.supplierId, log.supplierId)));
  if (!offer) {
    res.status(400).json({ error: "قدّم عرض السعر أولاً قبل إرفاق الملفات" });
    return;
  }
  if (!req.file) { res.status(400).json({ error: "لم يتم اختيار ملف" }); return; }

  const [att] = await db
    .insert(offerAttachmentsTable)
    .values({
      offerId: offer.id,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      content: req.file.buffer.toString("base64"),
    })
    .returning({
      id: offerAttachmentsTable.id,
      originalName: offerAttachmentsTable.originalName,
      mimeType: offerAttachmentsTable.mimeType,
      size: offerAttachmentsTable.size,
      createdAt: offerAttachmentsTable.createdAt,
    });

  res.status(201).json({
    ...att,
    sizeLabel: formatSize(att.size),
    createdAt: att.createdAt.toISOString(),
  });
});

export default router;

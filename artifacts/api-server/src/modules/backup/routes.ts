/**
 * Backup routes:
 *   GET  /backup/status  → scheduler config + last run result (any employee)
 *   POST /backup/run     → trigger a backup now (admin/manager)
 */
import { Router, type IRouter } from "express";
import { requireAuth, requireRole } from "../../middlewares/auth";
import {
  getBackupStatus,
  isBackupConfigured,
  runDatabaseBackup,
} from "./service";

const router: IRouter = Router();

router.get("/backup/status", requireAuth, (_req, res) => {
  res.json(getBackupStatus());
});

router.post("/backup/run", requireAuth, requireRole("admin", "manager"), async (_req, res) => {
  if (!isBackupConfigured()) {
    res.status(400).json({ error: "النسخ الاحتياطي غير مُفعَّل (يلزم DATABASE_URL + GOOGLE_ACCOUNT_BASE_64)" });
    return;
  }
  try {
    const result = await runDatabaseBackup();
    res.json({ ok: true, ...result });
  } catch (err) {
    _req.log?.error({ err }, "Manual DB backup failed");
    res.status(500).json({ error: `فشل النسخ الاحتياطي: ${String((err as Error)?.message ?? err)}` });
  }
});

export default router;

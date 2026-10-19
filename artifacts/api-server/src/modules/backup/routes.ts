/**
 * Backup routes:
 *   GET  /backup/status          → scheduler config + durable run history
 *   POST /backup/run             → trigger a backup now (admin/manager)
 *   POST /backup/test-connection → verify Service Account access to the folder
 *   GET  /backup/settings        → alert recipients + retention/schedule
 *   PUT  /backup/settings        → update settings (admin/manager)
 */
import { Router, type IRouter } from "express";
import { db, auditLogTable, type BackupRecipient } from "@workspace/db";
import { requireAuth, requireRole } from "../../middlewares/auth";
import {
  getBackupStatus,
  isBackupConfigured,
  backupConfigProblems,
  runDatabaseBackup,
  testBackupConnection,
  BackupAlreadyDoneToday,
} from "./service";
import { loadBackupSettings, updateBackupSettings } from "./store";

const router: IRouter = Router();

router.get("/backup/status", requireAuth, async (_req, res) => {
  try {
    res.json(await getBackupStatus());
  } catch (err) {
    _req.log?.error({ err }, "Backup status failed");
    res.status(500).json({ error: "تعذّر جلب حالة النسخ الاحتياطي" });
  }
});

router.post(
  "/backup/test-connection",
  requireAuth,
  requireRole("admin", "manager"),
  async (_req, res) => {
    const result = await testBackupConnection();
    res.status(result.ok ? 200 : 502).json(result);
  },
);

router.post("/backup/run", requireAuth, requireRole("admin", "manager"), async (_req, res) => {
  if (!isBackupConfigured()) {
    res.status(400).json({
      error: `النسخ الاحتياطي غير مُفعَّل: ${backupConfigProblems().join("، ")}`,
    });
    return;
  }
  try {
    const result = await runDatabaseBackup("manual");
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof BackupAlreadyDoneToday) {
      res.status(409).json({ error: err.message });
      return;
    }
    _req.log?.error({ err }, "Manual DB backup failed");
    res
      .status(500)
      .json({ error: `فشل النسخ الاحتياطي: ${String((err as Error)?.message ?? err)}` });
  }
});

router.get("/backup/settings", requireAuth, async (_req, res) => {
  try {
    const s = await loadBackupSettings();
    res.json({
      recipients: s.recipients,
      retentionDays: s.retentionDays,
      hourUtc: s.hourUtc,
      alertsEnabled: s.alertsEnabled,
      lastAlertAt: s.lastAlertAt,
    });
  } catch (err) {
    _req.log?.error({ err }, "Backup settings read failed");
    res.status(500).json({ error: "تعذّر جلب إعدادات النسخ الاحتياطي" });
  }
});

router.put("/backup/settings", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  try {
    const body = req.body ?? {};
    const patch: {
      recipients?: BackupRecipient[];
      retentionDays?: number;
      hourUtc?: number;
      alertsEnabled?: boolean;
    } = {};
    if (Array.isArray(body.recipients)) {
      patch.recipients = body.recipients
        .map((r: any) => ({
          employeeId: Number(r?.employeeId),
          email: r?.email ? String(r.email) : null,
          phone: r?.phone ? String(r.phone) : null,
          whatsapp: r?.whatsapp !== false,
        }))
        .filter((r: BackupRecipient) => Number.isFinite(r.employeeId));
    }
    if (body.retentionDays != null) {
      const n = Number(body.retentionDays);
      if (!Number.isFinite(n) || n < 1 || n > 3650) {
        res.status(400).json({ error: "مدة الاحتفاظ يجب أن تكون بين 1 و 3650 يومًا" });
        return;
      }
      patch.retentionDays = Math.floor(n);
    }
    if (body.hourUtc != null) {
      const h = Number(body.hourUtc);
      if (!Number.isFinite(h) || h < 0 || h > 23) {
        res.status(400).json({ error: "ساعة التشغيل يجب أن تكون بين 0 و 23" });
        return;
      }
      patch.hourUtc = Math.floor(h);
    }
    if (typeof body.alertsEnabled === "boolean") patch.alertsEnabled = body.alertsEnabled;

    await updateBackupSettings(patch);
    try {
      await db.insert(auditLogTable).values({
        action: "backup.settings_updated",
        entityType: "backup",
        employeeId: req.session.employeeId,
        description: "تحديث إعدادات النسخ الاحتياطي",
      });
    } catch {
      // audit is best-effort
    }
    const s = await loadBackupSettings();
    res.json({
      recipients: s.recipients,
      retentionDays: s.retentionDays,
      hourUtc: s.hourUtc,
      alertsEnabled: s.alertsEnabled,
      lastAlertAt: s.lastAlertAt,
    });
  } catch (err) {
    req.log?.error({ err }, "Backup settings update failed");
    res.status(500).json({ error: "تعذّر تحديث إعدادات النسخ الاحتياطي" });
  }
});

export default router;

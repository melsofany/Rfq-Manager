/**
 * Backup failure alerts — التنبيهات.
 *
 * A backup that stops silently is the failure this whole module exists to
 * prevent: the previous implementation logged to `logger.error` and nothing
 * else, so the daily backup could stop for a month unnoticed. On failure we
 * notify the configured recipients over the channels the project already has
 * (shared SMTP + WhatsApp), with two hard rules:
 *
 *   1. A repeated failure of the same kind must not spam — one alert per
 *      fingerprint per `ALERT_DEDUP_MS`.
 *   2. A failure to SEND the alert must never affect the backup or the service
 *      (every channel is best-effort and swallows its own error).
 */
import { db, employeesTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { logger } from "../../shared/logger";
import { sendAlertEmail } from "../../shared/email";
import { loadBackupSettings, updateBackupSettings, type BackupRunRow } from "./store";

export const BACKUP_ALERTS_PERM = "backup:alerts";
/** Recipients with this role always receive alerts. */
const ROLE_DEFAULT: Record<string, boolean> = { admin: true, manager: true };
const ALERT_DEDUP_MS = 6 * 60 * 60 * 1000;

interface ResolvedRecipient {
  name: string;
  email: string | null;
  phone: string | null;
  whatsapp: boolean;
}

/**
 * Turn the settings rows into concrete recipients, keeping only employees that
 * still hold `backup:alerts` (or are admin/manager) and are active — so
 * revoking the permission stops the alerts without editing the settings row.
 */
export async function resolveAlertRecipients(): Promise<ResolvedRecipient[]> {
  const settings = await loadBackupSettings();
  if (!settings.alertsEnabled) return [];
  const ids = settings.recipients.map((r) => r.employeeId).filter((n) => Number.isFinite(n));
  if (!ids.length) return [];

  const rows = await db
    .select({
      id: employeesTable.id,
      name: employeesTable.name,
      email: employeesTable.email,
      phone: employeesTable.phone,
      role: employeesTable.role,
      permissions: employeesTable.permissions,
      isActive: employeesTable.isActive,
    })
    .from(employeesTable)
    .where(inArray(employeesTable.id, ids));

  const out: ResolvedRecipient[] = [];
  for (const emp of rows) {
    if (emp.isActive === false) continue;
    const explicit = emp.permissions as Record<string, boolean> | null | undefined;
    const permitted =
      explicit && Object.keys(explicit).length
        ? explicit[BACKUP_ALERTS_PERM] === true
        : ROLE_DEFAULT[emp.role] === true;
    if (!permitted) continue;
    const cfg = settings.recipients.find((r) => r.employeeId === emp.id);
    out.push({
      name: emp.name,
      email: emp.email ?? cfg?.email ?? null,
      phone: emp.phone ?? cfg?.phone ?? null,
      whatsapp: cfg?.whatsapp !== false,
    });
  }
  return out;
}

/** A stable category for a failure so repeats of the same cause collapse. */
export function failureFingerprint(error: string | null | undefined): string {
  const e = (error ?? "").toLowerCase();
  if (e.includes("invalid_grant") || e.includes("quota") || e.includes("storage"))
    return "drive-auth";
  if (e.includes("file not found") || e.includes("not found")) return "drive-folder";
  if (e.includes("econn") || e.includes("timeout") || e.includes("etimedout")) return "network";
  if (e.includes("permission") || e.includes("forbidden") || e.includes("403"))
    return "drive-permission";
  return "other";
}

function arabicBody(run: BackupRunRow, fingerprint: string): string {
  return [
    "⚠️ فشل النسخ الاحتياطي اليومي لقاعدة البيانات",
    "",
    `الوقت: ${new Date().toISOString()}`,
    `المُشغِّل: ${run.trigger}`,
    `نوع الخطأ: ${fingerprint}`,
    `عدد المحاولات: ${run.attempts}`,
    "",
    "الخطأ:",
    run.error ?? "(غير معروف)",
    "",
    "برجاء مراجعة صفحة «النسخ الاحتياطي» في النظام.",
  ].join("\n");
}

/**
 * Send the failure alert on every available channel. Returns a summary of what
 * was attempted (used by the status endpoint / tests). Never throws.
 */
export async function sendBackupFailureAlert(run: BackupRunRow): Promise<{
  recipients: number;
  emailed: number;
  whatsapped: number;
  skipped: boolean;
}> {
  const summary = { recipients: 0, emailed: 0, whatsapped: 0, skipped: false };
  try {
    const fingerprint = failureFingerprint(run.error);
    const settings = await loadBackupSettings();

    // Dedup: the same failure within the window is not re-sent.
    if (
      settings.lastAlertFingerprint === fingerprint &&
      settings.lastAlertAt &&
      Date.now() - new Date(settings.lastAlertAt).getTime() < ALERT_DEDUP_MS
    ) {
      logger.info({ fingerprint }, "Backup alert suppressed (duplicate within window)");
      summary.skipped = true;
      return summary;
    }

    const recipients = await resolveAlertRecipients();
    summary.recipients = recipients.length;
    if (!recipients.length) {
      logger.warn("Backup failed but no alert recipients are configured");
      return summary;
    }

    const subject = "⚠️ فشل النسخ الاحتياطي لقاعدة بيانات قرطبة";
    const body = arabicBody(run, fingerprint);

    const emails = recipients.map((r) => r.email).filter((e): e is string => Boolean(e));
    if (emails.length) {
      try {
        await sendAlertEmail({ to: emails, subject, body });
        summary.emailed = emails.length;
      } catch (err) {
        logger.warn({ err }, "Backup alert email failed (non-fatal)");
      }
    }

    const phones = recipients
      .filter((r) => r.whatsapp)
      .map((r) => r.phone)
      .filter((p): p is string => Boolean(p));
    if (phones.length) {
      try {
        const { sendWhatsAppText } = await import("../communications/service");
        for (const phone of phones) {
          try {
            await sendWhatsAppText(phone, body);
            summary.whatsapped++;
          } catch (err) {
            logger.warn({ err }, "Backup alert WhatsApp failed (non-fatal)");
          }
        }
      } catch (err) {
        logger.warn({ err }, "Backup alert WhatsApp module unavailable (non-fatal)");
      }
    }

    // Record the fingerprint even if a channel failed: the point is to stop a
    // storm of identical alerts, not to retry each one.
    await updateBackupSettings({
      lastAlertAt: new Date(),
      lastAlertFingerprint: fingerprint,
    });
    logger.info(summary, "Backup failure alert dispatched");
  } catch (err) {
    logger.warn({ err }, "Backup alert dispatch failed (non-fatal)");
  }
  return summary;
}

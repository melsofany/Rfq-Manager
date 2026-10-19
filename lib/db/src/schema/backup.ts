import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * Durable log of every backup attempt — نسخ احتياطي: السجل الدائم.
 *
 * The previous implementation kept its only state in a module variable
 * (`lastRun`), so a restart erased the evidence and nothing could tell whether
 * today's backup had run. This table is the source of truth for the status
 * endpoint, the compensation check and the alerts: a backup that is not written
 * here did not happen.
 *
 * One row is INSERTED at the start of an attempt (`status = 'RUNNING'`) and
 * UPDATED at the end, so a crash mid-run is visible as a stuck RUNNING row
 * rather than as silence.
 */
export const dbBackupRunsTable = pgTable("db_backup_runs", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** RUNNING | SUCCESS | FAILED */
  status: text("status").notNull().default("RUNNING"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  fileName: text("file_name"),
  driveFileId: text("drive_file_id"),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  /** schedule | manual | compensation | test */
  trigger: text("trigger").notNull().default("schedule"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Backup configuration that an admin can change at runtime — recipients of the
 * failure alerts, retention window and the schedule hour. A single row keyed
 * `default`, seeded by `init-db.ts` (never by drizzle-kit push).
 *
 * `recipients` is a JSON array of `{ employeeId, email?, phone?, whatsapp? }`.
 * An employee is a recipient only while it holds the `backup:alerts` permission
 * (or is an admin/manager), so revoking the permission stops the alerts without
 * editing this row.
 */
export interface BackupRecipient {
  employeeId: number;
  email?: string | null;
  phone?: string | null;
  whatsapp?: boolean;
}

export const dbBackupSettingsTable = pgTable("db_backup_settings", {
  key: text("key").primaryKey(),
  recipients: jsonb("recipients").$type<BackupRecipient[]>().default([]),
  retentionDays: integer("retention_days").notNull().default(30),
  hourUtc: integer("hour_utc").notNull().default(3),
  alertsEnabled: boolean("alerts_enabled").notNull().default(true),
  /** Suppress a repeated alert for the same failure fingerprint. */
  lastAlertAt: timestamp("last_alert_at", { withTimezone: true }),
  lastAlertFingerprint: text("last_alert_fingerprint"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DbBackupRun = typeof dbBackupRunsTable.$inferSelect;
export type DbBackupSettings = typeof dbBackupSettingsTable.$inferSelect;

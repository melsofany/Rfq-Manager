/**
 * Durable store for the backup system — السجل الدائم + القفل.
 *
 * Everything the old implementation kept in a module variable lives here in
 * Postgres: the log of every attempt, the settings row, and the advisory lock
 * that stops two backups from running at once (including across two instances
 * of the service).
 */
import {
  db,
  pool,
  dbBackupRunsTable,
  dbBackupSettingsTable,
  type BackupRecipient,
} from "@workspace/db";
import { eq, desc, and, sql } from "drizzle-orm";

export const BACKUP_LOCK_KEY = 7391059;

export interface BackupSettings {
  recipients: BackupRecipient[];
  retentionDays: number;
  hourUtc: number;
  alertsEnabled: boolean;
  lastAlertAt: Date | null;
  lastAlertFingerprint: string | null;
}

const DEFAULT_SETTINGS: BackupSettings = {
  recipients: [],
  retentionDays: 30,
  hourUtc: 3,
  alertsEnabled: true,
  lastAlertAt: null,
  lastAlertFingerprint: null,
};

/** Load the single settings row; falls back to defaults if the row is absent. */
export async function loadBackupSettings(): Promise<BackupSettings> {
  const [row] = await db
    .select()
    .from(dbBackupSettingsTable)
    .where(eq(dbBackupSettingsTable.key, "default"));
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    recipients: Array.isArray(row.recipients) ? row.recipients : [],
    retentionDays: row.retentionDays ?? 30,
    hourUtc: row.hourUtc ?? 3,
    alertsEnabled: row.alertsEnabled !== false,
    lastAlertAt: row.lastAlertAt ?? null,
    lastAlertFingerprint: row.lastAlertFingerprint ?? null,
  };
}

export async function updateBackupSettings(patch: {
  recipients?: BackupRecipient[];
  retentionDays?: number;
  hourUtc?: number;
  alertsEnabled?: boolean;
  lastAlertAt?: Date;
  lastAlertFingerprint?: string | null;
}): Promise<void> {
  await db
    .insert(dbBackupSettingsTable)
    .values({ key: "default", ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: dbBackupSettingsTable.key,
      set: { ...patch, updatedAt: new Date() },
    });
}

export interface BackupRunRow {
  id: number;
  startedAt: Date;
  finishedAt: Date | null;
  status: string;
  sizeBytes: number | null;
  fileName: string | null;
  driveFileId: string | null;
  error: string | null;
  attempts: number;
  trigger: string;
}

/** Insert a RUNNING row at the start of an attempt; returns its id. */
export async function startBackupRun(trigger: string): Promise<number> {
  const [row] = await db
    .insert(dbBackupRunsTable)
    .values({ status: "RUNNING", trigger, attempts: 1 })
    .returning({ id: dbBackupRunsTable.id });
  return row.id;
}

/** Mark a run SUCCESS/FAILED. `finished_at` is always set. */
export async function finishBackupRun(
  id: number,
  patch: {
    status: "SUCCESS" | "FAILED";
    sizeBytes?: number | null;
    fileName?: string | null;
    driveFileId?: string | null;
    error?: string | null;
  },
): Promise<void> {
  await db
    .update(dbBackupRunsTable)
    .set({
      status: patch.status,
      finishedAt: new Date(),
      sizeBytes: patch.sizeBytes ?? null,
      fileName: patch.fileName ?? null,
      driveFileId: patch.driveFileId ?? null,
      error: patch.error ?? null,
    })
    .where(eq(dbBackupRunsTable.id, id));
}

/** Best-effort attempt counter bump (retries within one logical backup). */
export async function bumpBackupAttempts(id: number): Promise<void> {
  await db
    .update(dbBackupRunsTable)
    .set({ attempts: sql`${dbBackupRunsTable.attempts} + 1` })
    .where(eq(dbBackupRunsTable.id, id));
}

export async function getLastBackup(): Promise<BackupRunRow | null> {
  const [row] = await db
    .select()
    .from(dbBackupRunsTable)
    .orderBy(desc(dbBackupRunsTable.startedAt))
    .limit(1);
  return (row as BackupRunRow) ?? null;
}

export async function getLastSuccessfulBackup(): Promise<BackupRunRow | null> {
  const [row] = await db
    .select()
    .from(dbBackupRunsTable)
    .where(eq(dbBackupRunsTable.status, "SUCCESS"))
    .orderBy(desc(dbBackupRunsTable.finishedAt))
    .limit(1);
  return (row as BackupRunRow) ?? null;
}

export async function getBackupCounts(): Promise<{ success: number; failed: number }> {
  const rows = await db
    .select({ status: dbBackupRunsTable.status, n: sql<number>`count(*)::int` })
    .from(dbBackupRunsTable)
    .groupBy(dbBackupRunsTable.status);
  let success = 0;
  let failed = 0;
  for (const r of rows) {
    if (r.status === "SUCCESS") success = Number(r.n);
    else if (r.status === "FAILED") failed = Number(r.n);
  }
  return { success, failed };
}

export async function listRecentBackups(limit = 30): Promise<BackupRunRow[]> {
  const rows = await db
    .select()
    .from(dbBackupRunsTable)
    .orderBy(desc(dbBackupRunsTable.startedAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows as BackupRunRow[];
}

/**
 * Session-level advisory lock held for the whole backup. Returns a release
 * function, or null when another backup already holds it. Session-level (not
 * transaction-level) because a backup spans a long stream + upload, far longer
 * than a transaction should stay open.
 */
export async function tryAcquireBackupLock(): Promise<(() => Promise<void>) | null> {
  const client = await pool.connect();
  try {
    const res = await client.query(`SELECT pg_try_advisory_lock(${BACKUP_LOCK_KEY}) AS ok`);
    if (!res.rows?.[0]?.ok) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query(`SELECT pg_advisory_unlock(${BACKUP_LOCK_KEY})`);
    } finally {
      client.release();
    }
  };
}

/**
 * Has a SUCCESS run already finished today (UTC)? Used by the boot
 * compensation so a restart never triggers a second backup for the same day.
 */
export async function hasSuccessfulBackupToday(now = new Date()): Promise<boolean> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await db
    .select({ id: dbBackupRunsTable.id })
    .from(dbBackupRunsTable)
    .where(
      and(
        eq(dbBackupRunsTable.status, "SUCCESS"),
        sql`${dbBackupRunsTable.finishedAt} >= ${start}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

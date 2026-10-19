/**
 * Daily database backup → Google Shared Drive (Service Account).
 *
 * Dumps every table in the `public` schema to a gzipped JSON file and uploads
 * it to a folder inside a Google **Shared Drive**.
 *
 * Auth — Service Account ONLY:
 *   GOOGLE_ACCOUNT_BASE_64   base64 of the service-account JSON key.
 *   The account must be a member of the Shared Drive (Content Manager).
 *   OAuth user tokens are deliberately NOT supported any more: the previous
 *   implementation preferred an OAuth refresh token, which expired
 *   (`invalid_grant`) and silently stopped every backup. A service account has
 *   no personal storage quota, so it must target a Shared Drive — which is why
 *   every Drive call passes `supportsAllDrives: true`.
 *
 * Env:
 *   GOOGLE_DRIVE_BACKUP_FOLDER_ID  Shared Drive (or folder in it) to upload into.
 *                                  REQUIRED — there is no default, because a
 *                                  wrong/absent id must fail loudly rather than
 *                                  upload somewhere unexpected.
 *   BACKUP_HOUR_UTC                Hour of day (UTC) to run, 0-23 (default 3).
 *   BACKUP_RETENTION_DAYS          Keep backups newer than this (default 30).
 *
 * State (status, retention window, alert recipients) lives in Postgres — see
 * ./store.ts — so a restart never erases the record of whether a backup ran.
 */
import { google, type drive_v3 } from "googleapis";
import { createGzip, type Gzip } from "zlib";
import { PassThrough } from "stream";
import { pool } from "@workspace/db";
import { logger } from "../../shared/logger";
import {
  finishBackupRun,
  getBackupCounts,
  getLastBackup,
  getLastSuccessfulBackup,
  hasSuccessfulBackupToday,
  listRecentBackups,
  loadBackupSettings,
  startBackupRun,
  tryAcquireBackupLock,
  type BackupRunRow,
} from "./store";
import { sendBackupFailureAlert } from "./alerts";

const FILE_PREFIX = "rfq-db-backup-";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export type BackupTrigger = "schedule" | "manual" | "compensation" | "test";

/** Shared Drive id or folder id to upload into. Empty when unset. */
export function backupFolderId(): string {
  return process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID?.trim() || "";
}

/** The Shared Drive id the folder lives in, when known (optional; improves listing). */
export function backupDriveId(): string {
  return process.env.GOOGLE_DRIVE_BACKUP_DRIVE_ID?.trim() || "";
}

export async function backupRetentionDays(): Promise<number> {
  const env = parseInt(process.env.BACKUP_RETENTION_DAYS ?? "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  try {
    const s = await loadBackupSettings();
    return s.retentionDays > 0 ? s.retentionDays : 30;
  } catch {
    return 30;
  }
}

export async function backupHourUtc(): Promise<number> {
  const env = parseInt(process.env.BACKUP_HOUR_UTC ?? "", 10);
  if (Number.isFinite(env) && env >= 0 && env <= 23) return env;
  try {
    const s = await loadBackupSettings();
    return s.hourUtc >= 0 && s.hourUtc <= 23 ? s.hourUtc : 3;
  } catch {
    return 3;
  }
}

/**
 * Backup is configured when we can read the DB, have a service-account key and
 * know where to upload. A missing folder id is a configuration error, not a
 * reason to guess — the whole point of this fix is to stop silent wrong uploads.
 */
export function isBackupConfigured(): boolean {
  return Boolean(
    process.env.DATABASE_URL && process.env.GOOGLE_ACCOUNT_BASE_64 && backupFolderId(),
  );
}

/** Reasons the backup cannot run, for a precise admin message. */
export function backupConfigProblems(): string[] {
  const problems: string[] = [];
  if (!process.env.DATABASE_URL) problems.push("DATABASE_URL غير مضبوط");
  if (!process.env.GOOGLE_ACCOUNT_BASE_64) problems.push("GOOGLE_ACCOUNT_BASE_64 غير مضبوط");
  if (!backupFolderId()) problems.push("GOOGLE_DRIVE_BACKUP_FOLDER_ID غير مضبوط");
  return problems;
}

function parseServiceAccount(): Record<string, unknown> {
  const base64 = process.env.GOOGLE_ACCOUNT_BASE_64;
  if (!base64) throw new Error("GOOGLE_ACCOUNT_BASE_64 not set");
  try {
    return JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
  } catch {
    throw new Error("GOOGLE_ACCOUNT_BASE_64 is not valid base64 JSON");
  }
}

/** The service-account email (safe to show — it is a public identifier). */
export function backupServiceAccountEmail(): string | null {
  try {
    return (parseServiceAccount().client_email as string) ?? null;
  } catch {
    return null;
  }
}

/** Drive client authenticated as the service account. No OAuth fallback. */
export function getDrive(): drive_v3.Drive {
  const credentials = parseServiceAccount();
  const auth = new google.auth.GoogleAuth({ credentials, scopes: [DRIVE_SCOPE] });
  return google.drive({ version: "v3", auth });
}

/** Options required for every call that touches a Shared Drive. */
function sharedDriveListParams(): drive_v3.Params$Resource$Files$List {
  const driveId = backupDriveId();
  const base: drive_v3.Params$Resource$Files$List = {
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  };
  if (driveId) {
    base.corpora = "drive";
    base.driveId = driveId;
  }
  return base;
}

async function writeChunk(gz: Gzip, chunk: string): Promise<void> {
  if (gz.destroyed) throw new Error("backup stream closed before the dump finished");
  if (!gz.write(chunk)) {
    // A destroyed stream never emits `drain`, so waiting on it alone hangs the
    // dump forever once the upload has stopped it. Wake on `close` too.
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => done(resolve);
      const onClose = () =>
        done(() => reject(new Error("backup stream closed before the dump finished")));
      const done = (fn: () => void) => {
        gz.off("drain", onDrain);
        gz.off("close", onClose);
        fn();
      };
      gz.once("drain", onDrain);
      gz.once("close", onClose);
    });
  }
}

async function listTables(): Promise<string[]> {
  const res = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  return res.rows.map((r: { table_name: string }) => r.table_name);
}

/** Stream a gzipped JSON dump of all tables into `gz`. Returns per-table row counts. */
export async function dumpDatabaseToStream(gz: Gzip): Promise<Record<string, number>> {
  const tables = await listTables();
  const counts: Record<string, number> = {};

  await writeChunk(gz, `{"createdAt":${JSON.stringify(new Date().toISOString())},"tables":{`);
  for (let t = 0; t < tables.length; t++) {
    const table = tables[t];
    const res = await pool.query(`SELECT * FROM "public"."${table}"`);
    const rows: unknown[] = res.rows ?? [];
    counts[table] = rows.length;
    await writeChunk(
      gz,
      `${t === 0 ? "" : ","}${JSON.stringify(table)}:{"rowCount":${rows.length},"rows":[`,
    );
    for (let i = 0; i < rows.length; i++) {
      await writeChunk(gz, `${i === 0 ? "" : ","}${JSON.stringify(rows[i])}`);
    }
    await writeChunk(gz, "]}");
  }
  await writeChunk(gz, "}}");
  gz.end();
  return counts;
}

/**
 * Verify the freshly uploaded file is actually there and non-empty — an upload
 * that returns an id but leaves a 0-byte or missing file is not a backup. This
 * is the "never call it a success just because the HTTP call returned" rule.
 */
async function verifyUploadedFile(drive: drive_v3.Drive, fileId: string): Promise<number> {
  const meta = await drive.files.get({
    fileId,
    supportsAllDrives: true,
    fields: "id,name,size,trashed",
  });
  if (!meta.data.id || meta.data.trashed) throw new Error("الملف المرفوع غير موجود أو محذوف");
  const size = Number(meta.data.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) throw new Error("حجم الملف المرفوع صفر");
  return size;
}

/**
 * Retention: move backups older than the window to the trash. We TRASH rather
 * than permanently delete because a service account on a Shared Drive cannot
 * hard-delete (the API returns `File not found`), and trashing is reversible —
 * an accidental short retention window must never destroy the only copy. Only
 * files carrying our own prefix are ever touched.
 */
export async function cleanupOldBackups(
  drive: drive_v3.Drive,
  retentionDays: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const res = await drive.files.list({
    ...sharedDriveListParams(),
    q: `'${backupFolderId()}' in parents and name contains '${FILE_PREFIX}' and trashed = false`,
    fields: "files(id,name,createdTime)",
    pageSize: 1000,
  });
  let removed = 0;
  for (const file of res.data.files ?? []) {
    if (!file.id || !file.createdTime) continue;
    // Belt and braces: never touch a file that does not carry our prefix, even
    // if the query somehow returned it.
    if (!file.name?.startsWith(FILE_PREFIX)) continue;
    if (new Date(file.createdTime) < cutoff) {
      await drive.files.update({
        fileId: file.id,
        supportsAllDrives: true,
        requestBody: { trashed: true },
      });
      removed++;
    }
  }
  return removed;
}

export interface BackupResult {
  fileId: string;
  name: string;
  sizeBytes: number;
  tables: Record<string, number>;
  removedOld: number;
}

export interface BackupStatus {
  configured: boolean;
  configProblems: string[];
  folderId: string;
  driveId: string;
  serviceAccountEmail: string | null;
  retentionDays: number;
  scheduleHourUtc: number;
  running: boolean;
  lastRun: BackupRunRow | null;
  lastSuccess: BackupRunRow | null;
  counts: { success: number; failed: number };
  compensationNeeded: boolean;
  recent: BackupRunRow[];
}

/** True while a backup holds the advisory lock (in this process). */
let running = false;

export function isBackupRunning(): boolean {
  return running;
}

async function acquireLockWithRetry(attempts = 3): Promise<(() => Promise<void>) | null> {
  const retryMs = parseInt(process.env.BACKUP_LOCK_RETRY_MS ?? "", 10);
  const delay = Number.isFinite(retryMs) && retryMs >= 0 ? retryMs : 1000;
  for (let i = 0; i < attempts; i++) {
    const release = await tryAcquireBackupLock();
    if (release) return release;
    if (i < attempts - 1 && delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
  return null;
}

/**
 * Run one backup. Guards:
 *   - the advisory lock stops two backups (even across instances) at once;
 *   - `skipIfDoneToday` (schedule/compensation) refuses a second success for
 *     the same UTC day, so a restart storm cannot pile up uploads;
 *   - failures are logged, alerted (deduped) and re-thrown.
 */
export async function runDatabaseBackup(
  trigger: BackupTrigger = "manual",
  opts: { skipIfDoneToday?: boolean } = {},
): Promise<BackupResult> {
  const problems = backupConfigProblems();
  if (problems.length) throw new Error(`النسخ الاحتياطي غير مُهيّأ: ${problems.join("، ")}`);

  const release = await acquireLockWithRetry();
  if (!release) {
    throw new Error("يوجد نسخ احتياطي آخر قيد التنفيذ بالفعل");
  }

  running = true;
  let runId: number | null = null;
  try {
    if (opts.skipIfDoneToday && (await hasSuccessfulBackupToday())) {
      throw new BackupAlreadyDoneToday();
    }

    runId = await startBackupRun(trigger);
    const drive = getDrive();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `${FILE_PREFIX}${stamp}.json.gz`;

    const gz = createGzip({ level: 9 });
    const body = new PassThrough();
    let sizeBytes = 0;
    gz.on("data", (c: Buffer) => (sizeBytes += c.length));
    gz.pipe(body);

    const createPromise = drive.files.create({
      requestBody: { name, parents: [backupFolderId()] },
      media: { mimeType: "application/gzip", body },
      supportsAllDrives: true,
      fields: "id,name",
    });
    // Observe the upload NOW, not after the dump: the upload runs while the dump
    // is still streaming, so a refused token rejected a promise nobody awaited
    // yet (an unhandled rejection). Stop the dump too — nowhere left to send it.
    let uploadError: unknown = null;
    createPromise.catch((err: unknown) => {
      uploadError = err;
      gz.destroy();
      body.destroy();
    });

    let tables: Record<string, number>;
    try {
      tables = await dumpDatabaseToStream(gz);
    } catch (err) {
      gz.destroy();
      body.destroy(err as Error);
      throw uploadError ?? err;
    }
    const created = await createPromise;
    const fileId = created.data.id;
    if (!fileId) throw new Error("Drive upload returned no file id");

    // Prove the file exists and is non-empty before calling this a success.
    const verifiedSize = await verifyUploadedFile(drive, fileId);
    const finalSize = verifiedSize || sizeBytes;

    // Only now is it safe to age out old copies.
    const removedOld = await cleanupOldBackups(drive, await backupRetentionDays());

    const result: BackupResult = { fileId, name, sizeBytes: finalSize, tables, removedOld };
    await finishBackupRun(runId, {
      status: "SUCCESS",
      sizeBytes: finalSize,
      fileName: name,
      driveFileId: fileId,
    });
    logger.info(
      { fileId, name, sizeBytes: finalSize, tables: Object.keys(tables).length, removedOld },
      "DB backup uploaded to Drive",
    );
    return result;
  } catch (err) {
    if (err instanceof BackupAlreadyDoneToday) throw err;
    const message = String((err as Error)?.message ?? err);
    if (runId != null) {
      try {
        await finishBackupRun(runId, { status: "FAILED", error: message });
      } catch (e) {
        logger.error({ err: e }, "Failed to record backup failure");
      }
      const run = {
        id: runId,
        startedAt: new Date(),
        finishedAt: new Date(),
        status: "FAILED",
        sizeBytes: null,
        fileName: null,
        driveFileId: null,
        error: message,
        attempts: 1,
        trigger,
      } as BackupRunRow;
      void sendBackupFailureAlert(run);
    }
    throw err;
  } finally {
    running = false;
    await release();
  }
}

/** Thrown when a scheduled/compensation run finds today already succeeded. */
export class BackupAlreadyDoneToday extends Error {
  constructor() {
    super("تم تنفيذ نسخة احتياطية ناجحة اليوم بالفعل");
    this.name = "BackupAlreadyDoneToday";
  }
}

/** Retry a failed backup once. Best-effort; re-throws the second failure. */
export async function runDatabaseBackupWithRetry(
  trigger: BackupTrigger,
  opts: { skipIfDoneToday?: boolean } = {},
): Promise<BackupResult> {
  try {
    return await runDatabaseBackup(trigger, opts);
  } catch (err) {
    if (err instanceof BackupAlreadyDoneToday) throw err;
    logger.warn({ err, trigger }, "Backup failed — retrying once");
    return await runDatabaseBackup(trigger, opts);
  }
}

/** Is a compensation backup required (no success today and the hour has passed)? */
export async function isCompensationNeeded(now = new Date()): Promise<boolean> {
  if (!isBackupConfigured()) return false;
  const hour = await backupHourUtc();
  const due = now.getUTCHours() >= hour;
  if (!due) return false;
  return !(await hasSuccessfulBackupToday(now));
}

export async function getBackupStatus(): Promise<BackupStatus> {
  const [lastRun, lastSuccess, counts, settings] = await Promise.all([
    getLastBackup(),
    getLastSuccessfulBackup(),
    getBackupCounts(),
    loadBackupSettings(),
  ]);
  let compensationNeeded = false;
  try {
    compensationNeeded = await isCompensationNeeded();
  } catch {
    compensationNeeded = false;
  }
  let recent: BackupRunRow[] = [];
  try {
    recent = await listRecentBackups(20);
  } catch {
    recent = [];
  }
  return {
    configured: isBackupConfigured(),
    configProblems: backupConfigProblems(),
    folderId: backupFolderId(),
    driveId: backupDriveId(),
    serviceAccountEmail: backupServiceAccountEmail(),
    retentionDays: settings.retentionDays,
    scheduleHourUtc: settings.hourUtc,
    running,
    lastRun,
    lastSuccess,
    counts,
    compensationNeeded,
    recent,
  };
}

function msUntilNextRun(hourUtc: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Schedule the daily backup and run a compensation check on startup.
 *
 * The timer is in-process, so a redeploy near the run hour would skip a day.
 * That is why the startup path checks whether today already succeeded and, if
 * not (and the hour has passed), runs the missed backup once — guarded by the
 * advisory lock so several instances starting together do not all run it.
 */
export function scheduleDailyBackup(): void {
  if (!isBackupConfigured()) {
    logger.info(
      { problems: backupConfigProblems() },
      "Daily DB backup not configured — skipping scheduler",
    );
    return;
  }

  const kickOff = (trigger: BackupTrigger, skipIfDoneToday: boolean) => {
    runDatabaseBackupWithRetry(trigger, { skipIfDoneToday }).catch((err) => {
      if (err instanceof BackupAlreadyDoneToday) return;
      logger.error({ err }, "Scheduled DB backup failed");
    });
  };

  // Compensation: only runs when today's backup is genuinely missing.
  void (async () => {
    try {
      if (await isCompensationNeeded()) {
        logger.warn("No successful backup today — running a compensation backup");
        kickOff("compensation", true);
      }
    } catch (err) {
      logger.warn({ err }, "Backup compensation check failed");
    }
  })();

  void (async () => {
    const hour = await backupHourUtc();
    setTimeout(() => {
      kickOff("schedule", true);
      setInterval(() => kickOff("schedule", true), 24 * 60 * 60 * 1000);
    }, msUntilNextRun(hour));
    logger.info({ hourUtc: hour, folderId: backupFolderId() }, "Daily DB backup scheduled");
  })();
}

/**
 * Non-destructive connection test: prove the service account can see the target
 * folder inside the Shared Drive. Returns a structured result; never throws.
 */
export async function testBackupConnection(): Promise<{
  ok: boolean;
  serviceAccountEmail: string | null;
  folderId: string;
  folderName?: string;
  error?: string;
}> {
  const base = {
    serviceAccountEmail: backupServiceAccountEmail(),
    folderId: backupFolderId(),
  };
  const problems = backupConfigProblems();
  if (problems.length) return { ok: false, ...base, error: problems.join("، ") };
  try {
    const drive = getDrive();
    const folder = await drive.files.get({
      fileId: backupFolderId(),
      supportsAllDrives: true,
      fields: "id,name,mimeType",
    });
    return { ok: true, ...base, folderName: folder.data.name ?? undefined };
  } catch (err) {
    return { ok: false, ...base, error: String((err as Error)?.message ?? err) };
  }
}

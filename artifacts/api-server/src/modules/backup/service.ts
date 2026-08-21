/**
 * Daily database backup → Google Drive.
 *
 * Dumps every table in the `public` schema to a gzipped JSON file and uploads
 * it to a Google Drive folder.
 *
 * Env:
 *   GOOGLE_DRIVE_BACKUP_FOLDER_ID  Drive folder to upload into
 *                                  (default: the shared Cortoba backups folder)
 *   BACKUP_HOUR_UTC                Hour of day (UTC) to run, 0-23 (default 3)
 *   BACKUP_RETENTION_DAYS          Delete backups older than this (default 30)
 *
 * Auth (two options, OAuth preferred):
 *   A) OAuth user token (uploads as the user, works with personal My Drive):
 *      GOOGLE_DRIVE_OAUTH_CLIENT_ID + GOOGLE_DRIVE_OAUTH_CLIENT_SECRET +
 *      GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN  (scope: drive.file)
 *   B) Service account (GOOGLE_ACCOUNT_BASE_64, drive.file scope) — NOTE:
 *      service accounts have NO storage quota on personal Drive; they only
 *      work with a Shared Drive (Google Workspace). If both are set, OAuth
 *      wins.
 */
import { google } from "googleapis";
import { createGzip, type Gzip } from "zlib";
import { PassThrough } from "stream";
import { once } from "events";
import { pool } from "@workspace/db";
import { logger } from "../../shared/logger";

const DEFAULT_FOLDER_ID = "1o8uhyrMNcGAh4mVR9ddYPgT-969tyby4";
const FILE_PREFIX = "rfq-db-backup-";

export function backupFolderId(): string {
  return process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID?.trim() || DEFAULT_FOLDER_ID;
}

export function backupRetentionDays(): number {
  const n = parseInt(process.env.BACKUP_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export function backupHourUtc(): number {
  const n = parseInt(process.env.BACKUP_HOUR_UTC ?? "", 10);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 3;
}

function useOAuth(): boolean {
  return Boolean(
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID &&
      process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET &&
      process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN,
  );
}

export function isBackupConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL && (useOAuth() || process.env.GOOGLE_ACCOUNT_BASE_64));
}

function getDrive() {
  if (useOAuth()) {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET,
    );
    auth.setCredentials({ refresh_token: process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN });
    return google.drive({ version: "v3", auth });
  }
  const base64 = process.env.GOOGLE_ACCOUNT_BASE_64;
  if (!base64) throw new Error("GOOGLE_ACCOUNT_BASE_64 not set");
  const credentials = JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  return google.drive({ version: "v3", auth });
}

async function writeChunk(gz: Gzip, chunk: string): Promise<void> {
  if (!gz.write(chunk)) await once(gz, "drain");
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
async function dumpDatabaseToStream(gz: Gzip): Promise<Record<string, number>> {
  const tables = await listTables();
  const counts: Record<string, number> = {};

  await writeChunk(gz, `{"createdAt":${JSON.stringify(new Date().toISOString())},"tables":{`);
  for (let t = 0; t < tables.length; t++) {
    const table = tables[t];
    const res = await pool.query(`SELECT * FROM "public"."${table}"`);
    const rows: unknown[] = res.rows ?? [];
    counts[table] = rows.length;
    await writeChunk(gz, `${t === 0 ? "" : ","}${JSON.stringify(table)}:{"rowCount":${rows.length},"rows":[`);
    for (let i = 0; i < rows.length; i++) {
      await writeChunk(gz, `${i === 0 ? "" : ","}${JSON.stringify(rows[i])}`);
    }
    await writeChunk(gz, "]}");
  }
  await writeChunk(gz, "}}");
  gz.end();
  return counts;
}

async function cleanupOldBackups(drive: ReturnType<typeof getDrive>): Promise<number> {
  const cutoff = new Date(Date.now() - backupRetentionDays() * 24 * 60 * 60 * 1000);
  const res = await drive.files.list({
    q: `'${backupFolderId()}' in parents and name contains '${FILE_PREFIX}' and trashed = false`,
    fields: "files(id,name,createdTime)",
    pageSize: 1000,
  });
  let deleted = 0;
  for (const file of res.data.files ?? []) {
    if (!file.id || !file.createdTime) continue;
    if (new Date(file.createdTime) < cutoff) {
      await drive.files.delete({ fileId: file.id });
      deleted++;
    }
  }
  return deleted;
}

export interface BackupResult {
  fileId: string;
  name: string;
  sizeBytes: number;
  tables: Record<string, number>;
  deletedOld: number;
}

export interface BackupStatus {
  configured: boolean;
  folderId: string;
  retentionDays: number;
  scheduleHourUtc: number;
  lastRun: { ranAt: string; ok: boolean; error?: string; result?: BackupResult } | null;
}

let lastRun: BackupStatus["lastRun"] = null;

export function getBackupStatus(): BackupStatus {
  return {
    configured: isBackupConfigured(),
    folderId: backupFolderId(),
    retentionDays: backupRetentionDays(),
    scheduleHourUtc: backupHourUtc(),
    lastRun,
  };
}

export async function runDatabaseBackup(): Promise<BackupResult> {
  try {
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
      fields: "id,name",
    });

    let tables: Record<string, number>;
    try {
      tables = await dumpDatabaseToStream(gz);
    } catch (err) {
      gz.destroy();
      body.destroy(err as Error);
      await createPromise.catch(() => {});
      throw err;
    }
    const created = await createPromise;
    const fileId = created.data.id;
    if (!fileId) throw new Error("Drive upload returned no file id");

    const deletedOld = await cleanupOldBackups(drive);
    const result: BackupResult = { fileId, name, sizeBytes, tables, deletedOld };
    lastRun = { ranAt: new Date().toISOString(), ok: true, result };
    logger.info({ fileId, name, sizeBytes, tables: Object.keys(tables).length, deletedOld }, "DB backup uploaded to Drive");
    return result;
  } catch (err) {
    lastRun = { ranAt: new Date().toISOString(), ok: false, error: String((err as Error)?.message ?? err) };
    throw err;
  }
}

function msUntilNextRun(): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(backupHourUtc(), 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/** Run the backup every day at BACKUP_HOUR_UTC. Failures are logged, never fatal. */
export function scheduleDailyBackup(): void {
  if (!isBackupConfigured()) {
    logger.info("Daily DB backup not configured (needs DATABASE_URL + GOOGLE_ACCOUNT_BASE_64) — skipping scheduler");
    return;
  }
  const kickOff = () => {
    runDatabaseBackup().catch((err) => logger.error({ err }, "Scheduled DB backup failed"));
  };
  setTimeout(() => {
    kickOff();
    setInterval(kickOff, 24 * 60 * 60 * 1000);
  }, msUntilNextRun());
  logger.info({ hourUtc: backupHourUtc(), folderId: backupFolderId() }, "Daily DB backup scheduled");
}

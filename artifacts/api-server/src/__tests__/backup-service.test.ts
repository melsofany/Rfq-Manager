import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Service-level behaviour that the route tests cannot reach: the compensation
 * check, the once-a-day guard and the retry. The Drive + store are doubled so
 * no network or database is touched.
 */

const driveFiles = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
}));
vi.mock("googleapis", () => ({
  google: {
    auth: { GoogleAuth: class {} },
    drive: vi.fn(() => ({ files: driveFiles })),
  },
}));

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@workspace/db", () => ({ pool: { query: queryMock, connect: vi.fn() }, db: {} }));

const store = vi.hoisted(() => ({
  startBackupRun: vi.fn(async () => 1),
  finishBackupRun: vi.fn(async () => {}),
  bumpBackupAttempts: vi.fn(),
  getLastBackup: vi.fn(async () => null),
  getLastSuccessfulBackup: vi.fn(async () => null),
  getBackupCounts: vi.fn(async () => ({ success: 0, failed: 0 })),
  listRecentBackups: vi.fn(async () => []),
  hasSuccessfulBackupToday: vi.fn(async () => false),
  loadBackupSettings: vi.fn(async () => ({
    recipients: [],
    retentionDays: 30,
    hourUtc: 3,
    alertsEnabled: true,
    lastAlertAt: null,
    lastAlertFingerprint: null,
  })),
  updateBackupSettings: vi.fn(),
  tryAcquireBackupLock: vi.fn(async () => async () => {}),
}));
vi.mock("../modules/backup/store", () => store);

const alertMock = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../modules/backup/alerts", () => ({
  sendBackupFailureAlert: alertMock,
  BACKUP_ALERTS_PERM: "backup:alerts",
  resolveAlertRecipients: vi.fn(async () => []),
  failureFingerprint: vi.fn(() => "other"),
}));

import {
  runDatabaseBackup,
  runDatabaseBackupWithRetry,
  isCompensationNeeded,
  BackupAlreadyDoneToday,
} from "../modules/backup/service";

describe("backup service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgres://x/y";
    process.env.GOOGLE_ACCOUNT_BASE_64 = Buffer.from(
      JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com" }),
    ).toString("base64");
    process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID = "0APNCUmMhL81RUk9PVA";
    process.env.BACKUP_LOCK_RETRY_MS = "0";
    delete process.env.BACKUP_HOUR_UTC;

    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.tables")) return { rows: [{ table_name: "t1" }] };
      return { rows: [{ id: 1 }] };
    });
    driveFiles.create.mockImplementation(async (args: any) => {
      for await (const _ of args.media.body) {
        /* drain */
      }
      return { data: { id: "f1" } };
    });
    driveFiles.get.mockResolvedValue({ data: { id: "f1", size: "10", trashed: false } });
    driveFiles.list.mockResolvedValue({ data: { files: [] } });
    driveFiles.update.mockResolvedValue({ data: {} });
  });

  it("skips (without uploading) when a successful backup already ran today", async () => {
    store.hasSuccessfulBackupToday.mockResolvedValue(true);
    await expect(runDatabaseBackup("schedule", { skipIfDoneToday: true })).rejects.toBeInstanceOf(
      BackupAlreadyDoneToday,
    );
    expect(driveFiles.create).not.toHaveBeenCalled();
  });

  it("does not alert on the benign already-done-today skip", async () => {
    store.hasSuccessfulBackupToday.mockResolvedValue(true);
    await runDatabaseBackup("schedule", { skipIfDoneToday: true }).catch(() => {});
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("retries a failed backup once, then succeeds", async () => {
    driveFiles.create.mockRejectedValueOnce(new Error("transient 503"));
    const result = await runDatabaseBackupWithRetry("schedule");
    expect(result.fileId).toBe("f1");
    expect(driveFiles.create).toHaveBeenCalledTimes(2);
  });

  it("reports compensation needed when the hour passed with no success today", async () => {
    const late = new Date(Date.UTC(2026, 9, 19, 5, 0, 0)); // 05:00 UTC, hour default 3
    store.hasSuccessfulBackupToday.mockResolvedValue(false);
    expect(await isCompensationNeeded(late)).toBe(true);
  });

  it("does not report compensation before the scheduled hour", async () => {
    const early = new Date(Date.UTC(2026, 9, 19, 1, 0, 0)); // 01:00 UTC, hour default 3
    expect(await isCompensationNeeded(early)).toBe(false);
  });

  it("does not report compensation when today already succeeded", async () => {
    const late = new Date(Date.UTC(2026, 9, 19, 5, 0, 0));
    store.hasSuccessfulBackupToday.mockResolvedValue(true);
    expect(await isCompensationNeeded(late)).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// Live (03:00 UTC daily): the Drive upload was refused while the database dump
// was still streaming. The upload promise rejected before anything awaited it,
// which surfaced as an unhandled promise rejection — and the dump had to stop,
// not run to completion against a destination that already refused it.

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

const dbQueries = vi.hoisted(() => [] as string[]);
vi.mock("@workspace/db", () => ({
  pool: {
    query: async (sql: string) => {
      dbQueries.push(sql);
      // Slow on purpose, so the upload fails while the dump is still running.
      await new Promise((r) => setTimeout(r, 40));
      if (sql.includes("information_schema")) {
        return { rows: [{ table_name: "suppliers" }, { table_name: "rfq" }] };
      }
      return { rows: [{ id: 1 }] };
    },
    connect: async () => ({
      query: async () => ({ rows: [{ ok: true }] }),
      release: () => {},
    }),
  },
}));

vi.mock("../modules/backup/store", () => ({
  startBackupRun: vi.fn(async () => 1),
  finishBackupRun: vi.fn(async () => {}),
  bumpBackupAttempts: vi.fn(),
  hasSuccessfulBackupToday: vi.fn(async () => false),
  loadBackupSettings: vi.fn(async () => ({
    retentionDays: 30,
    hourUtc: 3,
    alertsEnabled: true,
    recipients: [],
  })),
  tryAcquireBackupLock: vi.fn(async () => async () => {}),
}));

vi.mock("../modules/backup/alerts", () => ({ sendBackupFailureAlert: vi.fn(async () => ({})) }));

vi.mock("../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runDatabaseBackup } from "../modules/backup/service";

describe("backup upload failure", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://test");
    vi.stubEnv("GOOGLE_ACCOUNT_BASE_64", Buffer.from("{}").toString("base64"));
    vi.stubEnv("GOOGLE_DRIVE_BACKUP_FOLDER_ID", "0APNCUmMhL81RUk9PVA");
    vi.stubEnv("BACKUP_LOCK_RETRY_MS", "0");
    driveFiles.create.mockReset();
  });

  it("stops dumping the database once the upload has been refused", async () => {
    dbQueries.length = 0;
    // Rejects after a tick — well before the dump's table reads finish.
    driveFiles.create.mockImplementation(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error("invalid_grant"), { code: 400 })), 5),
        ),
    );
    await expect(runDatabaseBackup()).rejects.toThrow("invalid_grant");
    // No table was read after the upload was refused: the dump is aborted, not run to the end.
    const tableReads = dbQueries.filter((q) => q.includes("SELECT * FROM"));
    expect(tableReads).toHaveLength(0);
  });
});

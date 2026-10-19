import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { gunzipSync } from "zlib";

let sessionState: any = { employeeId: 7, role: "admin", employeeName: "Sara" };
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!sessionState.employeeId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.session = { ...sessionState };
    next();
  },
  requireRole:
    (...roles: string[]) =>
    (req: any, res: any, next: any) => {
      if (!sessionState.employeeId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (!roles.includes(sessionState.role)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    },
}));

// Drive: only the Service Account path exists now (no OAuth).
const driveFiles = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
const googleAuthCtor = vi.hoisted(() => vi.fn());
vi.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: class {
        constructor(opts: unknown) {
          googleAuthCtor(opts);
        }
      },
    },
    drive: vi.fn(() => ({ files: driveFiles })),
  },
}));

// DB: pool.query serves the dump; the store tables are stubbed separately.
const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@workspace/db", () => ({
  pool: { query: queryMock, connect: vi.fn() },
  db: {},
  auditLogTable: {},
  dbBackupRunsTable: {},
  dbBackupSettingsTable: {},
  employeesTable: {},
}));

// Store: a light in-memory double so we can assert the durable lifecycle.
const store = vi.hoisted(() => {
  const runs: any[] = [];
  return {
    runs,
    startBackupRun: vi.fn(async (trigger: string) => {
      const id = runs.length + 1;
      runs.push({ id, trigger, status: "RUNNING" });
      return id;
    }),
    finishBackupRun: vi.fn(async (id: number, patch: any) => {
      const r = runs.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
    }),
    bumpBackupAttempts: vi.fn(),
    getLastBackup: vi.fn(async () => runs[runs.length - 1] ?? null),
    getLastSuccessfulBackup: vi.fn(async () => runs.find((r) => r.status === "SUCCESS") ?? null),
    getBackupCounts: vi.fn(async () => ({
      success: runs.filter((r) => r.status === "SUCCESS").length,
      failed: runs.filter((r) => r.status === "FAILED").length,
    })),
    listRecentBackups: vi.fn(async () => [...runs].reverse()),
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
  };
});
vi.mock("../../modules/backup/store", () => store);

const alertMock = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../../modules/backup/alerts", () => ({
  sendBackupFailureAlert: alertMock,
  BACKUP_ALERTS_PERM: "backup:alerts",
  resolveAlertRecipients: vi.fn(async () => []),
  failureFingerprint: vi.fn(() => "other"),
}));

import backupRouter from "../../modules/backup/routes";
import {
  runDatabaseBackup,
  backupConfigProblems,
  testBackupConnection,
} from "../../modules/backup/service";

const tableRows: Record<string, any[]> = {
  employees: [{ id: 1, name: "Sara" }],
  suppliers: [
    { id: 10, name: "ACME" },
    { id: 11, name: "Beta" },
  ],
};

const FOLDER = "0APNCUmMhL81RUk9PVA";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    next();
  });
  app.use(backupRouter);
  return app;
}

describe("backup routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.runs.length = 0;
    sessionState = { employeeId: 7, role: "admin", employeeName: "Sara" };
    process.env.DATABASE_URL = "postgres://user:pass@host/db";
    process.env.GOOGLE_ACCOUNT_BASE_64 = Buffer.from(
      JSON.stringify({
        client_email: "svc@example.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----\n",
      }),
    ).toString("base64");
    process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID = FOLDER;
    delete process.env.BACKUP_RETENTION_DAYS;
    delete process.env.BACKUP_HOUR_UTC;
    process.env.BACKUP_LOCK_RETRY_MS = "0";
    delete process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN;

    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return { rows: [{ table_name: "employees" }, { table_name: "suppliers" }] };
      }
      const m = sql.match(/FROM "public"\."(\w+)"/);
      return { rows: tableRows[m?.[1] ?? ""] ?? [] };
    });

    driveFiles.create.mockImplementation(async (args: any) => {
      const chunks: Buffer[] = [];
      for await (const c of args.media.body) chunks.push(c as Buffer);
      (driveFiles.create as any).capturedBody = Buffer.concat(chunks);
      (driveFiles.create as any).lastArgs = args;
      return { data: { id: "file-1", name: args.requestBody.name } };
    });
    driveFiles.get.mockResolvedValue({
      data: { id: "file-1", name: "x", size: "123", trashed: false },
    });
    driveFiles.list.mockResolvedValue({ data: { files: [] } });
    driveFiles.update.mockResolvedValue({ data: {} });
    driveFiles.delete.mockResolvedValue({});
  });

  it("GET /backup/status returns the durable status when authenticated", async () => {
    const res = await request(buildApp()).get("/backup/status");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.folderId).toBe(FOLDER);
    expect(res.body.retentionDays).toBe(30);
    expect(res.body.scheduleHourUtc).toBe(3);
    expect(res.body.serviceAccountEmail).toBe("svc@example.iam.gserviceaccount.com");
  });

  it("GET /backup/status requires auth", async () => {
    sessionState.employeeId = null;
    const res = await request(buildApp()).get("/backup/status");
    expect(res.status).toBe(401);
  });

  it("POST /backup/run uploads a gzipped dump and marks the run SUCCESS", async () => {
    const res = await request(buildApp()).post("/backup/run");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.fileId).toBe("file-1");
    expect(res.body.name).toMatch(/^rfq-db-backup-.*\.json\.gz$/);
    expect(res.body.tables).toEqual({ employees: 1, suppliers: 2 });

    const createArgs = (driveFiles.create as any).lastArgs;
    expect(createArgs.requestBody.parents).toEqual([FOLDER]);
    expect(createArgs.supportsAllDrives).toBe(true);

    const dump = JSON.parse(gunzipSync((driveFiles.create as any).capturedBody).toString("utf-8"));
    expect(dump.tables.employees.rows).toEqual(tableRows.employees);
    expect(store.runs[0].status).toBe("SUCCESS");
    expect(store.runs[0].driveFileId).toBe("file-1");
  });

  it("uses the Service Account (no OAuth) even when OAuth env vars are present", async () => {
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN = "refresh-token";
    const res = await request(buildApp()).post("/backup/run");
    expect(res.status).toBe(200);
    // The GoogleAuth ctor received service-account credentials + a drive scope.
    const opts = googleAuthCtor.mock.calls[0][0] as any;
    expect(opts.scopes).toContain("https://www.googleapis.com/auth/drive");
    expect(opts.credentials.client_email).toBe("svc@example.iam.gserviceaccount.com");
  });

  it("fails the run (not a false success) when the uploaded file is empty", async () => {
    driveFiles.get.mockResolvedValue({ data: { id: "file-1", size: "0", trashed: false } });
    const res = await request(buildApp()).post("/backup/run");
    expect(res.status).toBe(500);
    expect(store.runs[0].status).toBe("FAILED");
    expect(alertMock).toHaveBeenCalled();
  });

  it("trashes (never hard-deletes) backups older than the retention window", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    driveFiles.list.mockResolvedValue({
      data: {
        files: [
          { id: "old-1", name: "rfq-db-backup-old.json.gz", createdTime: old },
          { id: "new-1", name: "rfq-db-backup-new.json.gz", createdTime: recent },
        ],
      },
    });
    const res = await request(buildApp()).post("/backup/run");
    expect(res.status).toBe(200);
    expect(res.body.removedOld).toBe(1);
    expect(driveFiles.update).toHaveBeenCalledTimes(1);
    expect(driveFiles.update).toHaveBeenCalledWith({
      fileId: "old-1",
      supportsAllDrives: true,
      requestBody: { trashed: true },
    });
    expect(driveFiles.delete).not.toHaveBeenCalled();
  });

  it("never touches a file that does not carry the backup prefix", async () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    driveFiles.list.mockResolvedValue({
      data: { files: [{ id: "other", name: "important-report.pdf", createdTime: old }] },
    });
    const res = await request(buildApp()).post("/backup/run");
    expect(res.status).toBe(200);
    expect(res.body.removedOld).toBe(0);
    expect(driveFiles.update).not.toHaveBeenCalled();
  });

  it("POST /backup/run rejects non-admin/manager roles", async () => {
    sessionState.role = "viewer";
    const res = await request(buildApp()).post("/backup/run");
    expect(res.status).toBe(403);
    expect(driveFiles.create).not.toHaveBeenCalled();
  });

  it("POST /backup/run returns 400 when the folder id is missing", async () => {
    delete process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID;
    const res = await request(buildApp()).post("/backup/run");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("GOOGLE_DRIVE_BACKUP_FOLDER_ID");
    expect(driveFiles.create).not.toHaveBeenCalled();
  });

  it("POST /backup/run returns 500 when the Drive upload fails and alerts", async () => {
    driveFiles.create.mockRejectedValue(new Error("storage quota exceeded"));
    const res = await request(buildApp()).post("/backup/run");
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("storage quota exceeded");
    expect(store.runs[0].status).toBe("FAILED");
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a second run while one holds the lock (no concurrent backups)", async () => {
    (store.tryAcquireBackupLock as any).mockResolvedValue(null);
    await expect(runDatabaseBackup("manual")).rejects.toThrow(/قيد التنفيذ/);
    expect(driveFiles.create).not.toHaveBeenCalled();
  });

  it("POST /backup/test-connection reports the folder name on success", async () => {
    driveFiles.get.mockResolvedValue({
      data: { id: FOLDER, name: "Backup Datebase", mimeType: "application/vnd.google-apps.folder" },
    });
    const res = await request(buildApp()).post("/backup/test-connection");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.folderName).toBe("Backup Datebase");
  });

  it("POST /backup/test-connection reports a structured failure", async () => {
    driveFiles.get.mockRejectedValue(new Error("File not found"));
    const res = await request(buildApp()).post("/backup/test-connection");
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("File not found");
  });

  it("GET /backup/settings returns the stored settings", async () => {
    const res = await request(buildApp()).get("/backup/settings");
    expect(res.status).toBe(200);
    expect(res.body.retentionDays).toBe(30);
    expect(res.body.hourUtc).toBe(3);
  });

  it("PUT /backup/settings validates retention and hour", async () => {
    const bad1 = await request(buildApp()).put("/backup/settings").send({ retentionDays: 0 });
    expect(bad1.status).toBe(400);
    const bad2 = await request(buildApp()).put("/backup/settings").send({ hourUtc: 99 });
    expect(bad2.status).toBe(400);
  });

  it("PUT /backup/settings persists valid values and audits", async () => {
    const res = await request(buildApp())
      .put("/backup/settings")
      .send({
        retentionDays: 45,
        hourUtc: 5,
        alertsEnabled: false,
        recipients: [{ employeeId: 3 }],
      });
    expect(res.status).toBe(200);
    expect(store.updateBackupSettings).toHaveBeenCalledWith(
      expect.objectContaining({ retentionDays: 45, hourUtc: 5, alertsEnabled: false }),
    );
  });

  it("backupConfigProblems names every missing variable", () => {
    delete process.env.DATABASE_URL;
    delete process.env.GOOGLE_ACCOUNT_BASE_64;
    delete process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID;
    const problems = backupConfigProblems();
    expect(problems.join(" ")).toContain("DATABASE_URL");
    expect(problems.join(" ")).toContain("GOOGLE_ACCOUNT_BASE_64");
    expect(problems.join(" ")).toContain("GOOGLE_DRIVE_BACKUP_FOLDER_ID");
  });

  it("testBackupConnection fails safely when not configured", async () => {
    delete process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID;
    const r = await testBackupConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("GOOGLE_DRIVE_BACKUP_FOLDER_ID");
  });
});

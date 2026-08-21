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
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) => {
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

const driveFiles = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("googleapis", () => ({
  google: {
    auth: { GoogleAuth: class {}, OAuth2: class { setCredentials() {} } },
    drive: vi.fn(() => ({ files: driveFiles })),
  },
}));

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@workspace/db", () => ({ pool: { query: queryMock } }));

import backupRouter from "../../modules/backup/routes";

const tableRows: Record<string, any[]> = {
  employees: [{ id: 1, name: "Sara" }],
  suppliers: [{ id: 10, name: "ACME" }, { id: 11, name: "Beta" }],
};

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
    sessionState = { employeeId: 7, role: "admin", employeeName: "Sara" };
    process.env.DATABASE_URL = "postgres://user:pass@host/db";
    process.env.GOOGLE_ACCOUNT_BASE_64 = Buffer.from(
      JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com" }),
    ).toString("base64");
    delete process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID;
    delete process.env.BACKUP_RETENTION_DAYS;
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
      return { data: { id: "file-1", name: args.requestBody.name } };
    });
    driveFiles.list.mockResolvedValue({ data: { files: [] } });
    driveFiles.delete.mockResolvedValue({});
  });

  it("GET /backup/status returns config when authenticated", async () => {
    const res = await request(buildApp()).get("/backup/status");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.folderId).toBe("1o8uhyrMNcGAh4mVR9ddYPgT-969tyby4");
    expect(res.body.retentionDays).toBe(30);
    expect(res.body.scheduleHourUtc).toBe(3);
  });

  it("GET /backup/status requires auth", async () => {
    sessionState.employeeId = null;
    const res = await request(buildApp()).get("/backup/status");
    expect(res.status).toBe(401);
  });

  it("POST /backup/run uploads a gzipped dump of all tables to the Drive folder", async () => {
    const res = await request(buildApp()).post("/backup/run");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.fileId).toBe("file-1");
    expect(res.body.name).toMatch(/^rfq-db-backup-.*\.json\.gz$/);
    expect(res.body.tables).toEqual({ employees: 1, suppliers: 2 });

    const createArgs = driveFiles.create.mock.calls[0][0] as any;
    expect(createArgs.requestBody.parents).toEqual(["1o8uhyrMNcGAh4mVR9ddYPgT-969tyby4"]);
    expect(createArgs.media.mimeType).toBe("application/gzip");

    const dump = JSON.parse(gunzipSync((driveFiles.create as any).capturedBody).toString("utf-8"));
    expect(dump.tables.employees.rows).toEqual(tableRows.employees);
    expect(dump.tables.suppliers.rows).toEqual(tableRows.suppliers);
  });

  it("POST /backup/run deletes backups older than the retention window", async () => {
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
    expect(res.body.deletedOld).toBe(1);
    expect(driveFiles.delete).toHaveBeenCalledTimes(1);
    expect(driveFiles.delete).toHaveBeenCalledWith({ fileId: "old-1" });
  });

  it("POST /backup/run rejects non-admin/manager roles", async () => {
    sessionState.role = "viewer";
    const res = await request(buildApp()).post("/backup/run");
    expect(res.status).toBe(403);
    expect(driveFiles.create).not.toHaveBeenCalled();
  });

  it("POST /backup/run requires auth", async () => {
    sessionState.employeeId = null;
    const res = await request(buildApp()).post("/backup/run");
    expect(res.status).toBe(401);
  });

  it("POST /backup/run returns 400 when backup is not configured", async () => {
    delete process.env.GOOGLE_ACCOUNT_BASE_64;
    const res = await request(buildApp()).post("/backup/run");
    expect(res.status).toBe(400);
    expect(driveFiles.create).not.toHaveBeenCalled();
  });

  it("POST /backup/run prefers OAuth credentials over the service account", async () => {
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN = "refresh-token";
    const res = await request(buildApp()).post("/backup/run");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(driveFiles.create).toHaveBeenCalledTimes(1);
  });

  it("POST /backup/run returns 500 when the Drive upload fails", async () => {
    driveFiles.create.mockRejectedValue(new Error("drive quota exceeded"));
    const res = await request(buildApp()).post("/backup/run");
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("drive quota exceeded");
  });
});

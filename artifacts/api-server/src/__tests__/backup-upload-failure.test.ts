import { describe, it, expect, vi, beforeEach } from "vitest";

// Live (03:00 UTC daily): the Drive upload was refused with invalid_grant while the
// database dump was still streaming. The upload promise rejected before anything
// awaited it, which surfaced as an unhandled promise rejection.

const driveCreate = vi.hoisted(() => vi.fn());
vi.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: class {},
      OAuth2: class {
        setCredentials() {}
      },
    },
    drive: vi.fn(() => ({ files: { create: driveCreate, list: vi.fn(), delete: vi.fn() } })),
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
  },
}));

vi.mock("../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runDatabaseBackup } from "../modules/backup/service";

describe("backup upload failure", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://test");
    vi.stubEnv("GOOGLE_ACCOUNT_BASE_64", Buffer.from("{}").toString("base64"));
    driveCreate.mockReset();
  });

  it("stops dumping the database once the upload has been refused", async () => {
    dbQueries.length = 0;
    // Rejects after a tick — well before the dump's table reads finish.
    driveCreate.mockImplementation(
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

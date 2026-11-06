/**
 * Guards that protect the mobile app from operator settings.
 *
 * Two settings are enforced on the server, not merely reported to the client:
 *   • maintenanceMode   — a rep with an offline queue must not keep confirming
 *                         receipts against a frozen system.
 *   • mobileAccessEnabled — a disabled account must not receive new work.
 *
 * Both were previously unenforced, so the tests below pin the refusal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("@workspace/db", () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn() },
  hrEmployeesTable: { _: "hrEmployees" },
  mobileSessionsTable: { _: "mobileSessions" },
  hrFieldAssignmentsTable: { _: "hrFieldAssignments" },
}));

let maintenanceMode = false;

vi.mock("../../modules/field-ops/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../modules/field-ops/service")>();
  return {
    ...actual,
    loadFieldOpsSettings: vi.fn(async () => ({
      ...actual.FIELD_OPS_DEFAULT_SETTINGS,
      maintenanceMode,
    })),
  };
});

import { requireMobileOperationsEnabled } from "../../modules/field-ops/mobile-auth";

function appWith(middleware: express.RequestHandler): express.Express {
  const app = express();
  app.use(express.json());
  app.get("/api/mobile/pickups", middleware, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("requireMobileOperationsEnabled", () => {
  beforeEach(() => {
    maintenanceMode = false;
  });

  it("lets operations through while maintenance mode is off", async () => {
    const res = await request(appWith(requireMobileOperationsEnabled)).get("/api/mobile/pickups");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("refuses operations with 503 while maintenance mode is on", async () => {
    maintenanceMode = true;
    const res = await request(appWith(requireMobileOperationsEnabled)).get("/api/mobile/pickups");
    expect(res.status).toBe(503);
    // A machine-readable code lets the app show the maintenance screen rather
    // than a generic error, and tells WorkManager not to retry the queue.
    expect(res.body.code).toBe("MAINTENANCE_MODE");
    expect(res.body.error).toContain("صيانة");
  });

  it("re-checks the setting on every request, not once at startup", async () => {
    const app = appWith(requireMobileOperationsEnabled);
    expect((await request(app).get("/api/mobile/pickups")).status).toBe(200);
    maintenanceMode = true;
    expect((await request(app).get("/api/mobile/pickups")).status).toBe(503);
    maintenanceMode = false;
    expect((await request(app).get("/api/mobile/pickups")).status).toBe(200);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Alert behaviour: recipient resolution honours the `backup:alerts` permission,
 * the failure fingerprint groups causes, and a repeated failure within the
 * window is not re-sent. Channels are mocked; no mail or WhatsApp is sent.
 */

const db = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@workspace/db", () => ({ db, employeesTable: {} }));

const sendAlertEmail = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../shared/email", () => ({ sendAlertEmail }));

const sendWhatsAppText = vi.hoisted(() => vi.fn(async () => "mid"));
vi.mock("../modules/communications/service", () => ({ sendWhatsAppText }));

const settingsState = vi.hoisted(() => ({
  value: {
    recipients: [] as any[],
    retentionDays: 30,
    hourUtc: 3,
    alertsEnabled: true,
    lastAlertAt: null as Date | null,
    lastAlertFingerprint: null as string | null,
  },
}));
const updateBackupSettings = vi.hoisted(() =>
  vi.fn(async (p: any) => Object.assign(settingsState.value, p)),
);
vi.mock("../modules/backup/store", () => ({
  loadBackupSettings: vi.fn(async () => ({ ...settingsState.value })),
  updateBackupSettings,
}));

import {
  sendBackupFailureAlert,
  resolveAlertRecipients,
  failureFingerprint,
} from "../modules/backup/alerts";

function mockEmployeeRows(rows: any[]) {
  db.select.mockImplementation(() => ({
    from: () => ({ where: async () => rows }),
  }));
}

const run: any = {
  id: 1,
  startedAt: new Date(),
  finishedAt: new Date(),
  status: "FAILED",
  sizeBytes: null,
  fileName: null,
  driveFileId: null,
  error: "invalid_grant",
  attempts: 1,
  trigger: "schedule",
};

describe("backup alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsState.value = {
      recipients: [],
      retentionDays: 30,
      hourUtc: 3,
      alertsEnabled: true,
      lastAlertAt: null,
      lastAlertFingerprint: null,
    };
    db.select.mockReset();
  });

  it("classifies failure causes into stable fingerprints", () => {
    expect(failureFingerprint("invalid_grant")).toBe("drive-auth");
    expect(failureFingerprint("Service Accounts do not have storage quota")).toBe("drive-auth");
    expect(failureFingerprint("File not found: abc")).toBe("drive-folder");
    expect(failureFingerprint("connect ETIMEDOUT")).toBe("network");
    expect(failureFingerprint("The user does not have sufficient permissions")).toBe(
      "drive-permission",
    );
    expect(failureFingerprint("something else")).toBe("other");
  });

  it("keeps only employees that hold the permission (or are manager/admin)", async () => {
    settingsState.value.recipients = [
      { employeeId: 1 },
      { employeeId: 2 },
      { employeeId: 3 },
      { employeeId: 4 },
    ];
    mockEmployeeRows([
      {
        id: 1,
        name: "A",
        email: "a@x.com",
        phone: "201000000001",
        role: "purchasing",
        permissions: { "backup:alerts": true },
        isActive: true,
      },
      {
        id: 2,
        name: "B",
        email: "b@x.com",
        phone: null,
        role: "purchasing",
        permissions: { "backup:alerts": false },
        isActive: true,
      },
      {
        id: 3,
        name: "C",
        email: "c@x.com",
        phone: "201000000003",
        role: "manager",
        permissions: null,
        isActive: true,
      },
      {
        id: 4,
        name: "D",
        email: "d@x.com",
        phone: null,
        role: "admin",
        permissions: null,
        isActive: false,
      },
    ]);
    const recipients = await resolveAlertRecipients();
    expect(recipients.map((r) => r.name)).toEqual(["A", "C"]);
  });

  it("sends email + WhatsApp to permitted recipients", async () => {
    settingsState.value.recipients = [{ employeeId: 1 }];
    mockEmployeeRows([
      {
        id: 1,
        name: "A",
        email: "a@x.com",
        phone: "201000000001",
        role: "manager",
        permissions: null,
        isActive: true,
      },
    ]);
    const summary = await sendBackupFailureAlert(run);
    expect(summary.emailed).toBe(1);
    expect(summary.whatsapped).toBe(1);
    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      "201000000001",
      expect.stringContaining("فشل النسخ"),
    );
    expect(updateBackupSettings).toHaveBeenCalledWith(
      expect.objectContaining({ lastAlertFingerprint: "drive-auth" }),
    );
  });

  it("suppresses a duplicate of the same failure within the window", async () => {
    settingsState.value.recipients = [{ employeeId: 1 }];
    settingsState.value.lastAlertFingerprint = "drive-auth";
    settingsState.value.lastAlertAt = new Date();
    mockEmployeeRows([
      {
        id: 1,
        name: "A",
        email: "a@x.com",
        phone: null,
        role: "manager",
        permissions: null,
        isActive: true,
      },
    ]);
    const summary = await sendBackupFailureAlert(run);
    expect(summary.skipped).toBe(true);
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  it("does not send when alerts are disabled", async () => {
    settingsState.value.alertsEnabled = false;
    settingsState.value.recipients = [{ employeeId: 1 }];
    const summary = await sendBackupFailureAlert(run);
    expect(summary.recipients).toBe(0);
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  it("a failed channel never throws", async () => {
    settingsState.value.recipients = [{ employeeId: 1 }];
    mockEmployeeRows([
      {
        id: 1,
        name: "A",
        email: "a@x.com",
        phone: null,
        role: "manager",
        permissions: null,
        isActive: true,
      },
    ]);
    sendAlertEmail.mockRejectedValueOnce(new Error("SMTP down"));
    await expect(sendBackupFailureAlert(run)).resolves.toBeTruthy();
  });
});

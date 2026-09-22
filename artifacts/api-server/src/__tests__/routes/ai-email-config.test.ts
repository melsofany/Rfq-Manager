import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "IMAP_HOST",
  "IMAP_PORT",
  "IMAP_USER",
  "IMAP_PASS",
  "IMAP_SECURE",
] as const;

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("AI assistant mailbox config (email.ts)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("derives the IMAP host from the SMTP host", async () => {
    const { deriveImapHost } = await import("../../modules/ai-assistant/email");
    expect(deriveImapHost("smtp.gmail.com")).toBe("imap.gmail.com");
    expect(deriveImapHost("SMTP.GMAIL.COM")).toBe("imap.gmail.com");
    expect(deriveImapHost("mail.cortoba-supplies.com")).toBe("imap.cortoba-supplies.com");
    expect(deriveImapHost("smtp.office365.com")).toBe("imap.office365.com");
    // Unknown shapes are passed through rather than guessed.
    expect(deriveImapHost("imap.example.com")).toBe("imap.example.com");
    expect(deriveImapHost("")).toBeUndefined();
    expect(deriveImapHost(undefined)).toBeUndefined();
  });

  it("reuses the SMTP credentials for reading when no IMAP_* vars are set", async () => {
    process.env.SMTP_HOST = "smtp.gmail.com";
    process.env.SMTP_USER = "info@cortoba-supplies.com";
    process.env.SMTP_PASS = "app-password";
    const { imapConfig, isEmailReadConfigured } = await import("../../modules/ai-assistant/email");

    const cfg = imapConfig();
    expect(cfg.host).toBe("imap.gmail.com");
    expect(cfg.user).toBe("info@cortoba-supplies.com");
    expect(cfg.pass).toBe("app-password");
    expect(cfg.port).toBe(993);
    expect(cfg.secure).toBe(true);
    expect(isEmailReadConfigured()).toBe(true);
  });

  it("lets explicit IMAP_* vars override the SMTP-derived values", async () => {
    process.env.SMTP_HOST = "smtp.gmail.com";
    process.env.SMTP_USER = "info@cortoba-supplies.com";
    process.env.SMTP_PASS = "app-password";
    process.env.IMAP_HOST = "imap.other-host.com";
    process.env.IMAP_USER = "other@cortoba-supplies.com";
    process.env.IMAP_PASS = "other-pass";
    process.env.IMAP_PORT = "143";
    process.env.IMAP_SECURE = "false";
    const { imapConfig } = await import("../../modules/ai-assistant/email");

    const cfg = imapConfig();
    expect(cfg.host).toBe("imap.other-host.com");
    expect(cfg.user).toBe("other@cortoba-supplies.com");
    expect(cfg.pass).toBe("other-pass");
    expect(cfg.port).toBe(143);
    expect(cfg.secure).toBe(false);
  });

  it("reports reading as unconfigured when no mail account is set", async () => {
    const { isEmailReadConfigured } = await import("../../modules/ai-assistant/email");
    expect(isEmailReadConfigured()).toBe(false);
  });

  it("reports reading as unconfigured when only a host is known (no user)", async () => {
    process.env.SMTP_HOST = "smtp.gmail.com";
    const { isEmailReadConfigured } = await import("../../modules/ai-assistant/email");
    expect(isEmailReadConfigured()).toBe(false);
  });
});

/**
 * Gmail service-account impersonation.
 *
 * Verifies the two things that actually matter here: the token is requested for
 * the RIGHT user (`subject` is what selects whose mailbox is read) and it is
 * cached rather than minted on every request. Also pins the admin-facing error
 * message, because a misconfigured delegation is the most likely production
 * failure and the operator must be told which two admin steps are missing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const authorize = vi.fn();
const jwtCtor = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    auth: {
      JWT: class {
        constructor(opts: unknown) {
          jwtCtor(opts);
        }
        authorize = authorize;
      },
    },
  },
}));

const { gmailAccessToken, clearTokenCache, isDelegationConfigured, GmailAuthError } =
  await import("../../modules/ai-assistant/gmail-auth");

const SERVICE_ACCOUNT = {
  client_email: "rfq-bot@project.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
};

beforeEach(() => {
  clearTokenCache();
  vi.clearAllMocks();
  process.env.GOOGLE_ACCOUNT_BASE_64 = Buffer.from(JSON.stringify(SERVICE_ACCOUNT)).toString(
    "base64",
  );
  authorize.mockResolvedValue({ access_token: "tok-1", expiry_date: Date.now() + 3600_000 });
});

afterEach(() => {
  delete process.env.GOOGLE_ACCOUNT_BASE_64;
  delete process.env.GOOGLE_MAIL_SERVICE_ACCOUNT_BASE_64;
  clearTokenCache();
});

describe("mail service account selection", () => {
  const MAIL_SA = {
    client_email: "cortoba-ai-mail-assistant@cortoba-ai-mail-assistant.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nmail\n-----END PRIVATE KEY-----\n",
  };

  it("prefers the dedicated MAIL service account over the shared one", async () => {
    // The shared credential backs Sheets/Drive/ERP. If mail used it, granting
    // the mail scope would widen every one of those integrations.
    process.env.GOOGLE_MAIL_SERVICE_ACCOUNT_BASE_64 = Buffer.from(JSON.stringify(MAIL_SA)).toString(
      "base64",
    );
    await gmailAccessToken("finance@cortoba-supplies.com");
    expect(jwtCtor.mock.calls[0][0].email).toBe(MAIL_SA.client_email);
  });

  it("falls back to the shared credential when no mail-specific one is set", async () => {
    await gmailAccessToken("info@cortoba-supplies.com");
    expect(jwtCtor.mock.calls[0][0].email).toBe(SERVICE_ACCOUNT.client_email);
  });

  it("treats delegation as configured when only the mail credential exists", () => {
    delete process.env.GOOGLE_ACCOUNT_BASE_64;
    process.env.GOOGLE_MAIL_SERVICE_ACCOUNT_BASE_64 = Buffer.from(JSON.stringify(MAIL_SA)).toString(
      "base64",
    );
    expect(isDelegationConfigured()).toBe(true);
  });
});

describe("gmailAccessToken", () => {
  it("reports delegation as configured only when credentials exist", () => {
    expect(isDelegationConfigured()).toBe(true);
    delete process.env.GOOGLE_ACCOUNT_BASE_64;
    expect(isDelegationConfigured()).toBe(false);
  });

  it("impersonates the requested mailbox via `subject`", async () => {
    const token = await gmailAccessToken("info@cortoba-supplies.com");
    expect(token).toBe("tok-1");
    expect(jwtCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        email: SERVICE_ACCOUNT.client_email,
        subject: "info@cortoba-supplies.com",
        scopes: ["https://mail.google.com/"],
      }),
    );
  });

  it("uses a DIFFERENT subject per mailbox — the crux of multi-mailbox reading", async () => {
    await gmailAccessToken("info@cortoba-supplies.com");
    await gmailAccessToken("sales@cortoba-supplies.com");
    expect(jwtCtor.mock.calls[0][0].subject).toBe("info@cortoba-supplies.com");
    expect(jwtCtor.mock.calls[1][0].subject).toBe("sales@cortoba-supplies.com");
  });

  it("caches the token instead of minting one per call", async () => {
    await gmailAccessToken("info@cortoba-supplies.com");
    authorize.mockResolvedValue({ access_token: "tok-2", expiry_date: Date.now() + 3600_000 });
    const second = await gmailAccessToken("info@cortoba-supplies.com");
    expect(second).toBe("tok-1");
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("renews a token that is about to expire", async () => {
    authorize.mockResolvedValue({ access_token: "tok-old", expiry_date: Date.now() + 1000 });
    const first = await gmailAccessToken("info@cortoba-supplies.com");
    expect(first).toBe("tok-old");

    authorize.mockResolvedValue({ access_token: "tok-new", expiry_date: Date.now() + 3600_000 });
    const second = await gmailAccessToken("info@cortoba-supplies.com");
    expect(second).toBe("tok-new");
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("caches each mailbox separately", async () => {
    await gmailAccessToken("info@cortoba-supplies.com");
    await gmailAccessToken("info@cortoba-supplies.com");
    await gmailAccessToken("sales@cortoba-supplies.com");
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("explains the two missing admin steps when delegation is refused", async () => {
    authorize.mockRejectedValue(new Error("unauthorized_client"));
    await expect(gmailAccessToken("info@cortoba-supplies.com")).rejects.toThrow(
      /Domain-wide Delegation/,
    );
    await expect(gmailAccessToken("info@cortoba-supplies.com")).rejects.toThrow(
      /mail\.google\.com/,
    );
  });

  it("recognizes Google's other delegation phrasings", async () => {
    for (const msg of ["invalid_grant", "admin_policy_enforced", "invalid delegation policy"]) {
      clearTokenCache();
      authorize.mockRejectedValue(new Error(msg));
      await expect(gmailAccessToken("info@cortoba-supplies.com")).rejects.toThrow(
        /Domain-wide Delegation/,
      );
    }
  });

  it("surfaces a plain auth failure without the delegation hint", async () => {
    authorize.mockRejectedValue(new Error("socket hang up"));
    await expect(gmailAccessToken("info@cortoba-supplies.com")).rejects.toThrow(/socket hang up/);
    await expect(gmailAccessToken("info@cortoba-supplies.com")).rejects.not.toThrow(
      /Domain-wide Delegation/,
    );
  });

  it("fails clearly when credentials are absent", async () => {
    delete process.env.GOOGLE_ACCOUNT_BASE_64;
    await expect(gmailAccessToken("info@cortoba-supplies.com")).rejects.toThrow(GmailAuthError);
  });

  it("rejects credentials that are not valid base64 JSON", async () => {
    process.env.GOOGLE_ACCOUNT_BASE_64 = "!!!not-base64-json!!!";
    await expect(gmailAccessToken("info@cortoba-supplies.com")).rejects.toThrow(
      /GOOGLE_ACCOUNT_BASE_64/,
    );
  });

  it("rejects credentials that parse but lack a key", async () => {
    process.env.GOOGLE_ACCOUNT_BASE_64 = Buffer.from(
      JSON.stringify({ client_email: "x@y.com" }),
    ).toString("base64");
    await expect(gmailAccessToken("info@cortoba-supplies.com")).rejects.toThrow(
      /GOOGLE_ACCOUNT_BASE_64/,
    );
  });

  it("rejects an authorize() that returns no token", async () => {
    authorize.mockResolvedValue({ expiry_date: Date.now() + 3600_000 });
    await expect(gmailAccessToken("info@cortoba-supplies.com")).rejects.toThrow(/رمز وصول/);
  });
});

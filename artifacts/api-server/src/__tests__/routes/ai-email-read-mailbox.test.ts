/**
 * Reading ONE message by UID across multiple mailboxes.
 *
 * A UID is only unique inside one folder of one mailbox, so `read_email` /
 * `get_email_attachment` take the mailbox the search tagged. Two failure modes
 * made a message that plainly exists look unreadable, which the operator saw as
 * a technical error on the Jaz Almaza order mail:
 *   1. the read paths accepted a `mailbox` argument and silently dropped it,
 *      falling back to the DEFAULT mailbox (the search-side comment warns about
 *      exactly this bug, and the read side did not follow the rule);
 *   2. with 3 mailboxes, a message in a non-default inbox then answered
 *      "Email UID … not found".
 * Both are covered here by asserting WHICH mailbox was authenticated as.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

interface FakeServer {
  /** Keyed by `<user>|<folder path>` — different content per mailbox. */
  messages: Record<string, { uid: number; source: Buffer }[]>;
  /** Mailbox addresses this fake server was asked to authenticate as. */
  authentications: string[];
  failConnect?: boolean;
}

const server: FakeServer = { messages: {}, authentications: [] };

vi.mock("dns", () => ({
  promises: { resolve4: vi.fn().mockResolvedValue(["127.0.0.1"]) },
}));

// Mock the delegation boundary, not `googleapis` — the token exchange has its
// own suite and mocking lower would let this one reach the network.
vi.mock("../../modules/ai-assistant/gmail-auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  gmailAccessToken: vi.fn(async (mailbox: string) => `token-for-${mailbox}`),
  isDelegationConfigured: () => Boolean(process.env.GOOGLE_ACCOUNT_BASE_64),
}));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    private user: string;
    constructor(opts: { auth: { user: string } }) {
      this.user = opts.auth.user;
      server.authentications.push(opts.auth.user);
    }
    async connect() {
      if (server.failConnect) throw new Error("auth failed");
    }
    async logout() {}
    async list() {
      return [];
    }
    async getMailboxLock() {
      return { release: vi.fn() };
    }
    async fetchOne(uid: string) {
      const hit = (server.messages[`${this.user}|INBOX`] ?? []).find((m) => String(m.uid) === uid);
      return hit ? { uid: hit.uid, source: hit.source } : false;
    }
  },
}));

/** A minimal MIME message with one PDF attachment, labelled by `tag`. */
function mimeWithPdf(tag: string): Buffer {
  return Buffer.from(
    [
      "From: purchasing.crystal@jazhotels.com",
      "To: info@cortoba-supplies.com",
      "Subject: Cordoba Order - Jaz Almaza Matrouh",
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "برجاء تجهيز الأوردر.",
      "--B",
      'Content-Type: application/pdf; name="order.pdf"',
      'Content-Disposition: attachment; filename="order.pdf"',
      "",
      tag,
      "--B--",
      "",
    ].join("\r\n"),
  );
}

const { readEmail, readEmailAttachment } = await import("../../modules/ai-assistant/email");
const { clearMailboxCache } = await import("../../modules/ai-assistant/mailboxes");

const MAILBOXES = "info@cortoba-supplies.com,sales@cortoba-supplies.com,ops@cortoba-supplies.com";

describe("reading a message by UID across mailboxes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    server.authentications = [];
    server.messages = {};
    server.failConnect = false;

    process.env.AI_MAILBOXES = MAILBOXES;
    // Delegation on: each mailbox authenticates as itself, so the fake server
    // can tell which one was read.
    process.env.GOOGLE_ACCOUNT_BASE_64 = "x";
    process.env.SMTP_HOST = "smtp.gmail.com";
    clearMailboxCache();
  });

  afterEach(() => {
    for (const k of ["AI_MAILBOXES", "GOOGLE_ACCOUNT_BASE_64", "SMTP_HOST"]) {
      delete process.env[k];
    }
    clearMailboxCache();
  });

  it("reports which mailbox was read, so the UID can be quoted back", async () => {
    server.messages = {
      "info@cortoba-supplies.com|INBOX": [{ uid: 3977, source: mimeWithPdf("info-copy") }],
    };
    // The default mailbox is the first configured one, so this is the cheap path.
    const detail = await readEmail(3977, "info@cortoba-supplies.com");
    expect(detail.mailbox).toBe("info@cortoba-supplies.com");
    expect(server.authentications).toEqual(["info@cortoba-supplies.com"]);
  });

  it("reads the message from the mailbox it actually lives in (UID 3977)", async () => {
    // Jaz Almaza's order sits in the SECOND inbox, not the default one.
    server.messages = {
      "sales@cortoba-supplies.com|INBOX": [{ uid: 3977, source: mimeWithPdf("sales-copy") }],
    };

    const detail = await readEmail(3977, "sales@cortoba-supplies.com");
    expect(detail.uid).toBe(3977);
    expect(detail.subject).toBe("Cordoba Order - Jaz Almaza Matrouh");
    expect(detail.hasAttachments).toBe(true);
    // The bug: it authenticated as the DEFAULT mailbox and reported not-found.
    expect(server.authentications[0]).toBe("sales@cortoba-supplies.com");
  });

  it("finds the UID in another mailbox when none was named", async () => {
    server.messages = {
      "ops@cortoba-supplies.com|INBOX": [{ uid: 3977, source: mimeWithPdf("ops-copy") }],
    };

    // A bare call must not fail just because the UID is not in the default box.
    const detail = await readEmail(3977);
    expect(detail.uid).toBe(3977);
    expect(detail.mailbox).toBe("ops@cortoba-supplies.com");
  });

  it("finds the UID when the model guesses the wrong mailbox", async () => {
    server.messages = {
      "ops@cortoba-supplies.com|INBOX": [{ uid: 3977, source: mimeWithPdf("ops-copy") }],
    };

    // Still resolves rather than erroring on the model's wrong guess.
    const detail = await readEmail(3977, "sales@cortoba-supplies.com");
    expect(detail.mailbox).toBe("ops@cortoba-supplies.com");
  });

  it("downloads the attachment from the mailbox the message lives in", async () => {
    server.messages = {
      "sales@cortoba-supplies.com|INBOX": [{ uid: 3977, source: mimeWithPdf("sales-copy") }],
    };

    const att = await readEmailAttachment(
      3977,
      { filename: "order" },
      "sales@cortoba-supplies.com",
    );
    expect(att.filename).toBe("order.pdf");
    expect(att.content).toBeInstanceOf(Buffer);
    expect(att.content!.toString("utf8")).toContain("sales-copy");
    expect(server.authentications[0]).toBe("sales@cortoba-supplies.com");
  });

  it("still reports a UID that exists in no mailbox", async () => {
    server.messages = {};
    // Every candidate is tried, then the genuine not-found surfaces.
    await expect(readEmail(999_999)).rejects.toThrow(/not found/);
    expect(server.authentications.length).toBe(3);
  });

  it("does not retry a config/auth failure across every mailbox", async () => {
    // A connection fault fails identically everywhere; retrying it three times
    // would only spend the operator's latency budget on the same error.
    server.failConnect = true;
    await expect(readEmail(3977)).rejects.toThrow(/auth failed/);
    expect(server.authentications.length).toBe(1);
    server.failConnect = false;
  });
});

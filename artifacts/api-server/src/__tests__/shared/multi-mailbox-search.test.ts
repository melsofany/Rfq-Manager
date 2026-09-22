/**
 * Multi-mailbox search: fan-out, merge, and folder selection.
 *
 * Uses a fake IMAP server (no network) to verify the behaviour that is easy to
 * get wrong:
 *  - a bare search reads EVERY configured mailbox, not just the first;
 *  - results are tagged with their mailbox AND folder, so the UID is usable;
 *  - the Sent folder is found by its `\Sent` attribute, not a hardcoded name
 *    (Gmail localizes it — «[Gmail]/البريد المرسل» — so a hardcoded path reads
 *    nothing at all on this domain);
 *  - results from several mailboxes merge newest-first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

/** One fake message, as ImapFlow's `fetch` would yield it. */
interface FakeMsg {
  uid: number;
  from: { name?: string; address?: string }[];
  to: { address?: string }[];
  subject: string;
  date: Date;
  source: Buffer;
  seen?: boolean;
}

/** The per-connection script: which mailboxes exist and what they contain. */
interface FakeServer {
  boxes: { path: string; specialUse?: string }[];
  /** Keyed by `<user>|<folder path>`. */
  messages: Record<string, FakeMsg[]>;
  failConnect?: boolean;
  /** Mailbox addresses this server was asked to authenticate as. */
  authentications: string[];
  /** Folders that were opened. */
  opened: string[];
}

const server: FakeServer = { boxes: [], messages: {}, authentications: [], opened: [] };

vi.mock("dns", () => ({
  promises: { resolve4: vi.fn().mockResolvedValue(["127.0.0.1"]) },
}));

// Mock the delegation boundary, not `googleapis`: the token exchange is covered
// in gmail-auth.test.ts, and mocking lower would let this suite make real
// network calls to Google.
vi.mock("../../modules/ai-assistant/gmail-auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  gmailAccessToken: vi.fn(async (mailbox: string) => `token-for-${mailbox}`),
  isDelegationConfigured: () => Boolean(process.env.GOOGLE_ACCOUNT_BASE_64),
}));

/**
 * The mock ImapFlow. `auth.user` identifies WHICH mailbox is being read, so the
 * same fake server can hold different messages per address — that is what lets
 * these tests prove a bare search touches all three.
 */
vi.mock("imapflow", () => ({
  ImapFlow: class {
    private user: string;
    constructor(opts: { auth: { user: string; pass?: string; accessToken?: string } }) {
      this.user = opts.auth.user;
      server.authentications.push(opts.auth.user);
    }
    async connect() {
      if (server.failConnect) throw new Error("auth failed");
    }
    async logout() {}
    async list() {
      return server.boxes;
    }
    async getMailboxLock(path: string) {
      server.opened.push(path);
      return { release: vi.fn() };
    }
    async search() {
      const path = server.opened[server.opened.length - 1];
      return (server.messages[`${this.user}|${path}`] ?? []).map((m) => m.uid);
    }
    fetch(uids: number[]) {
      const path = server.opened[server.opened.length - 1];
      const all = server.messages[`${this.user}|${path}`] ?? [];
      const chosen = all.filter((m) => uids.includes(m.uid));
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of chosen) {
            yield {
              uid: m.uid,
              envelope: { from: m.from, to: m.to, subject: m.subject, date: m.date },
              source: m.source,
              flags: new Set(m.seen ? ["\\Seen"] : []),
            };
          }
        },
      };
    }
  },
}));

vi.mock("mailparser", () => ({
  simpleParser: vi.fn(async (src: Buffer) => ({
    text: src.toString("utf8"),
    attachments: [],
    from: { text: "x" },
    to: { text: "y" },
    subject: "s",
    date: new Date(),
  })),
}));

const { searchEmails, pickSentFolderPath } = await import("../../modules/ai-assistant/email");
const { clearMailboxCache } = await import("../../modules/ai-assistant/mailboxes");

function msg(uid: number, subject: string, dateIso: string, body = "hello"): FakeMsg {
  return {
    uid,
    from: [{ name: "Supplier", address: "supplier@example.com" }],
    to: [{ address: "us@cortoba-supplies.com" }],
    subject,
    date: new Date(dateIso),
    source: Buffer.from(body),
  };
}

const A = "procurement@cortoba-supplies.com";
const B = "info@cortoba-supplies.com";
const C = "sales@cortoba-supplies.com";

beforeEach(() => {
  server.boxes = [{ path: "INBOX" }, { path: "[Gmail]/البريد المرسل", specialUse: "\\Sent" }];
  server.messages = {};
  server.authentications = [];
  server.opened = [];
  server.failConnect = false;
  process.env.AI_MAILBOXES = `${A},${B},${C}`;
  // Presence of credentials enables the delegation path (mocked above).
  process.env.GOOGLE_ACCOUNT_BASE_64 = "e30=";
  process.env.SMTP_HOST = "smtp.gmail.com";
  clearMailboxCache();
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.AI_MAILBOXES;
  delete process.env.GOOGLE_ACCOUNT_BASE_64;
  clearMailboxCache();
});

describe("a bare search reads every configured mailbox", () => {
  it("connects as each mailbox and returns all three results", async () => {
    server.messages[`${A}|INBOX`] = [msg(1, "PO from A", "2026-01-03T00:00:00Z")];
    server.messages[`${B}|INBOX`] = [msg(2, "PO from B", "2026-01-02T00:00:00Z")];
    server.messages[`${C}|INBOX`] = [msg(3, "PO from C", "2026-01-01T00:00:00Z")];

    const results = await searchEmails({ mailbox: "*", query: "PO" });
    expect(results.map((r) => r.scope.mailbox).sort()).toEqual([A, B, C].sort());
    expect(results.flatMap((r) => r.emails)).toHaveLength(3);
    expect(server.authentications.sort()).toEqual([A, B, C].sort());
  });

  it("tags each result with its mailbox and folder, so the UID is usable", async () => {
    server.messages[`${B}|INBOX`] = [msg(7, "Only in B", "2026-01-05T00:00:00Z")];
    const [result] = await searchEmails({ mailbox: B, query: "Only" });
    expect(result.emails[0].mailbox).toBe(B);
    expect(result.emails[0].folder).toBe("inbox");
  });

  it("reads only the named mailbox when one is given", async () => {
    server.messages[`${A}|INBOX`] = [msg(1, "A mail", "2026-01-03T00:00:00Z")];
    server.messages[`${B}|INBOX`] = [msg(2, "B mail", "2026-01-02T00:00:00Z")];
    const results = await searchEmails({ mailbox: B, query: "mail" });
    expect(results).toHaveLength(1);
    expect(results[0].scope.mailbox).toBe(B);
    expect(results[0].emails[0].subject).toBe("B mail");
  });

  it("defaults to the first mailbox when none is named", async () => {
    server.messages[`${A}|INBOX`] = [msg(1, "A mail", "2026-01-03T00:00:00Z")];
    const results = await searchEmails({ query: "mail" });
    expect(results[0].scope.mailbox).toBe(A);
  });

  it("reports a scope per scanned mailbox", async () => {
    server.messages[`${A}|INBOX`] = [msg(1, "x", "2026-01-01T00:00:00Z")];
    server.messages[`${B}|INBOX`] = [msg(1, "y", "2026-01-01T00:00:00Z")];
    const results = await searchEmails({ mailbox: "*", query: "x" });
    expect(results.map((r) => r.scope)).toHaveLength(3);
  });
});

describe("Sent folder", () => {
  it("finds the localized Sent folder by its \\Sent attribute", async () => {
    server.messages[`${A}|[Gmail]/البريد المرسل`] = [msg(5, "Re: your PO", "2026-02-01T00:00:00Z")];
    const [result] = await searchEmails({ mailbox: A, folder: "sent", query: "PO" });
    expect(server.opened).toContain("[Gmail]/البريد المرسل");
    expect(result.emails).toHaveLength(1);
    expect(result.emails[0].folder).toBe("sent");
    expect(result.scope.folder).toBe("sent");
  });

  it("does not read the inbox when the sent folder is requested", async () => {
    server.messages[`${A}|INBOX`] = [msg(1, "inbox mail", "2026-01-01T00:00:00Z")];
    const [result] = await searchEmails({ mailbox: A, folder: "sent" });
    expect(result.emails).toHaveLength(0);
    expect(server.opened).not.toContain("INBOX");
  });
});

describe("pickSentFolderPath", () => {
  it("prefers the \\Sent special-use attribute, whatever the language", () => {
    // The leaf name is deliberately unrecognizable, so only the attribute can
    // identify this folder — and it must win over the name-matching one.
    expect(
      pickSentFolderPath([
        { path: "[Gmail]/Sent Mail" },
        { path: "[Gmail]/غير معروف", specialUse: "\\Sent" },
      ]),
    ).toBe("[Gmail]/غير معروف");
  });

  it("matches the \\Sent attribute case-insensitively", () => {
    expect(pickSentFolderPath([{ path: "[Gmail]/Outgoing", specialUse: "\\sent" }])).toBe(
      "[Gmail]/Outgoing",
    );
  });

  it("finds an Arabic Sent folder by name when the attribute is missing", () => {
    expect(pickSentFolderPath([{ path: "INBOX" }, { path: "[Gmail]/البريد المرسل" }])).toBe(
      "[Gmail]/البريد المرسل",
    );
  });

  it("finds English and French Sent folders too", () => {
    expect(pickSentFolderPath([{ path: "[Gmail]/Sent Mail" }])).toBe("[Gmail]/Sent Mail");
    expect(pickSentFolderPath([{ path: "[Gmail]/Messages envoyés" }])).toBe(
      "[Gmail]/Messages envoyés",
    );
  });

  it("does not mistake another folder for Sent", () => {
    // "Sentinel" contains "sent" but is a different folder.
    expect(pickSentFolderPath([{ path: "[Gmail]/Sentinel" }, { path: "INBOX" }])).toBe(
      "[Gmail]/Sent Mail",
    );
  });

  it("falls back to the common Gmail path when nothing matches", () => {
    expect(pickSentFolderPath([{ path: "INBOX" }])).toBe("[Gmail]/Sent Mail");
  });
});

describe("failures", () => {
  it("names the requested mailbox when it is unknown", async () => {
    await expect(searchEmails({ mailbox: "nobody@elsewhere.com" })).rejects.toThrow(
      /nobody@elsewhere\.com/,
    );
  });

  it("still reports the mailbox when nothing matched", async () => {
    const [result] = await searchEmails({ mailbox: A, query: "nothing-matches-this" });
    expect(result.emails).toEqual([]);
    expect(result.scope.mailbox).toBe(A);
    expect(result.scope.scanned).toBe(0);
  });
});

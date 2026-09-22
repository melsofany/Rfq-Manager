import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Email search cost.
 *
 * Live complaint: the assistant was slow. The dominant cost of an email question
 * was the search itself — it fetched `source` for the whole recent window and
 * MIME-parsed every message, on every search, in each of the 3 mailboxes, purely
 * to find matches that the envelope (subject/sender) already identifies.
 *
 * These tests assert the SHAPE of the work: how many messages get their full
 * body fetched. A regression here is invisible to a correctness-only test but
 * shows up as seconds of latency for the operator.
 */

const fetchCalls: Array<{ seq: unknown[]; opts: any }> = [];

/** Envelope-only fetch yields metadata; a source fetch yields a MIME message. */
function makeClient(messages: Array<{ uid: number; subject: string; from: string; body: string }>) {
  return class {
    getMailboxLock() {
      return Promise.resolve({ release() {} });
    }
    connect() {
      return Promise.resolve();
    }
    logout() {
      return Promise.resolve();
    }
    search() {
      return Promise.resolve(messages.map((m) => m.uid));
    }
    fetchOne(seq: string, opts: any) {
      fetchCalls.push({ seq: [seq], opts });
      const m = messages.find((x) => String(x.uid) === String(seq));
      if (!m) return Promise.resolve(undefined);
      return Promise.resolve({ uid: m.uid, source: mime(m) });
    }
    fetch(seqs: number[], opts: any) {
      const selected = messages.filter((m) => seqs.includes(m.uid));
      const self = this;
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of selected) {
            fetchCalls.push({ seq: [m.uid], opts });
            void self;
            yield {
              uid: m.uid,
              envelope: {
                from: [{ name: "", address: m.from }],
                to: [{ address: "info@cortoba-supplies.com" }],
                subject: m.subject,
                date: new Date("2026-09-01T10:00:00Z"),
              },
              source: opts.source ? mime(m) : undefined,
              flags: new Set<string>(),
            };
          }
        },
      };
    }
  };
}

function mime(m: { subject: string; from: string; body: string }): Buffer {
  return Buffer.from(
    [
      `From: ${m.from}`,
      "To: info@cortoba-supplies.com",
      `Subject: ${m.subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      m.body,
    ].join("\r\n"),
  );
}

const MESSAGES = [
  { uid: 1, subject: "عرض سعر من EDC", from: "sales@edc.com.eg", body: "تفاصيل العرض" },
  {
    uid: 2,
    subject: "فاتورة ضريبية",
    from: "billing@other.com",
    body: "المبلغ 5000 PO-2026-000123",
  },
  { uid: 3, subject: "تأكيد طلب", from: "ops@edc.com.eg", body: "تم التنفيذ" },
  { uid: 4, subject: "رسالة عامة", from: "spam@x.com", body: "نص عادي بلا شيء" },
];

let clientClass: any;
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor() {
      return new clientClass();
    }
  },
}));

vi.mock("dns", () => ({ promises: { resolve4: vi.fn(async () => ["127.0.0.1"]) } }));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../modules/ai-assistant/mailboxes", () => ({
  mailboxes: () => [{ email: "info@cortoba-supplies.com", label: "العام", isDefault: true }],
  mailboxListForDisplay: () => "info@cortoba-supplies.com",
  resolveMailbox: (m?: string) =>
    m
      ? { email: m, label: m, isDefault: false }
      : { email: "info@cortoba-supplies.com", label: "العام", isDefault: true },
}));

process.env.SMTP_USER = "info@cortoba-supplies.com";
process.env.SMTP_HOST = "imap.example.com";
process.env.IMAP_HOST = "imap.example.com";
process.env.SMTP_PASS = "secret";

beforeEach(() => {
  fetchCalls.length = 0;
  clientClass = makeClient(MESSAGES);
});

/** How many messages had their full body fetched. */
function bodyFetches(): number[] {
  return fetchCalls.filter((c) => c.opts?.source).map((c) => Number(c.seq[0]));
}

describe("email search cost", () => {
  it("matches from the envelope without fetching message bodies", async () => {
    const { searchEmails } = await import("../../modules/ai-assistant/email");
    const res = await searchEmails({ query: "EDC", sinceDays: 60, limit: 10 });
    const found = res[0].emails.map((e) => e.uid).sort();
    expect(found).toEqual([1, 3]); // the two EDC messages
    // No body fetches in pass 1: subject+sender were enough, and only the two
    // returned messages needed their body read for the snippet.
    expect(bodyFetches().sort()).toEqual([1, 3]);
  });

  it("reads the body only for messages it returns, not the whole window", async () => {
    const { searchEmails } = await import("../../modules/ai-assistant/email");
    // No query: every message matches, but limit is 2.
    const res = await searchEmails({ sinceDays: 60, limit: 2 });
    expect(res[0].emails).toHaveLength(2);
    // The window held 4 messages; only the 2 newest are returned and read.
    expect(bodyFetches()).toHaveLength(2);
  });

  it("still finds a body-only match, within the parse budget", async () => {
    const { searchEmails } = await import("../../modules/ai-assistant/email");
    // "PO-2026-000123" appears only in the body of message 2.
    const res = await searchEmails({ query: "PO-2026-000123", sinceDays: 60, limit: 10 });
    const found = res[0].emails.map((e) => e.uid);
    expect(found).toEqual([2]);
  });
});

/**
 * Persisted scan sessions.
 *
 * The resumable email/item census keeps its cursor and parsed rows in an
 * in-process cache. A restart — a Render deploy, a crash, a recycle — wipes that
 * cache, and the census would then restart a multi-minute scan from zero (or, on
 * a large mailbox, never finish). These tests pin the durability contract: a
 * session is mirrored to Postgres as it advances, and a fresh process restores
 * it and CONTINUES from the saved cursor instead of beginning again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/test";

const scanEmails = vi.fn();
const extractPdfText = vi.fn<(b: Buffer) => Promise<string>>();

vi.mock("../../modules/ai-assistant/email", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanEmails,
  extractPdfText,
}));

/** An in-memory stand-in for the `ai_assistant_scan_sessions` table. */
const saved = new Map<string, unknown>();
const insertSpy = vi.fn();
vi.mock("@workspace/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  aiAssistantScanSessionsTable: { key: "key", session: "session", updatedAt: "updatedAt" },
  db: {
    insert: () => ({
      values: (v: { key: string; session: unknown }) => ({
        onConflictDoUpdate: async () => {
          insertSpy(v);
          saved.set(v.key, v.session);
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (saved.size ? [{ session: [...saved.values()][0] }] : []),
        }),
      }),
    }),
    delete: () => ({ where: async () => undefined }),
  },
}));

const { clearScanCache, scanCacheKey } = await import("../../modules/ai-assistant/email");
const { runItemScan } = await import("../../modules/ai-assistant/item-scan-session");

function census(msgs: Array<{ uid: number; mailbox: string; subject: string }>, matched: number) {
  return {
    matched,
    returned: msgs.length,
    emails: msgs.map((m) => ({
      uid: m.uid,
      mailbox: m.mailbox,
      folder: "inbox",
      from: "noreply@egyptian-drilling.com",
      to: m.mailbox,
      subject: m.subject,
      date: "2026-09-22T10:00:00Z",
      numbers: [],
    })),
    byMailbox: { "info@cortoba-supplies.com": matched },
    byMonth: {},
    bySender: [],
    numbers: [],
    distinctNumbers: 0,
    numbersTruncated: false,
    attachmentCoverage: {
      messages: msgs.length,
      scanned: msgs.length,
      readable: msgs.length,
      unreadable: 0,
      attachments: msgs.length,
      truncated: false,
    },
    attachmentMessages: msgs.map((m) => ({
      uid: m.uid,
      mailbox: m.mailbox,
      folder: "inbox",
      subject: m.subject,
      attachments: [
        { filename: "po.pdf", mimeType: "application/pdf", content: Buffer.from("pdf") },
      ],
    })),
  };
}

describe("persisted scan sessions", () => {
  beforeEach(() => {
    clearScanCache();
    saved.clear();
    insertSpy.mockClear();
    scanEmails.mockReset();
    extractPdfText.mockReset();
    extractPdfText.mockResolvedValue("Quantity UOM Part No Line Item\n1 5 Each X-1 THING\n");
  });

  it("mirrors the session to the database as the census advances", async () => {
    const pool = [1, 2, 3, 4].map((uid) => ({
      uid,
      mailbox: "info@cortoba-supplies.com",
      subject: `EDC PO ${uid}`,
    }));
    scanEmails.mockImplementation(async (opts: { attachmentSkip?: number }) =>
      census(pool.slice(opts.attachmentSkip ?? 0, (opts.attachmentSkip ?? 0) + 2), 4),
    );

    const key = scanCacheKey("items", { mailbox: "*" });
    await runItemScan(key, { mailbox: "*" }, Date.now() + 10_000);
    await Promise.resolve();

    // The saved session carries the CURSOR, not just the rows.
    expect(insertSpy).toHaveBeenCalled();
    const last = insertSpy.mock.calls.at(-1)?.[0] as { key: string; session: { nextSkip: number } };
    expect(last.key).toBe(key);
    expect(last.session.nextSkip).toBeGreaterThan(0);
  });

  it("restores a session after a restart and continues from the saved cursor", async () => {
    const pool = [1, 2, 3, 4].map((uid) => ({
      uid,
      mailbox: "info@cortoba-supplies.com",
      subject: `EDC PO ${uid}`,
    }));
    scanEmails.mockImplementation(async (opts: { attachmentSkip?: number }) =>
      census(pool.slice(opts.attachmentSkip ?? 0, (opts.attachmentSkip ?? 0) + 2), 4),
    );
    const key = scanCacheKey("items", { mailbox: "*" });

    // First pass: two messages read, two remaining.
    // A zero deadline means "one batch this call" — the shape a cut scan has.
    const first = await runItemScan(key, { mailbox: "*" }, 0);
    await Promise.resolve();
    expect(first.session.nextSkip).toBe(2);
    expect(first.session.complete).toBe(false);

    // Simulate a restart: the in-memory cache is gone, Postgres is not.
    clearScanCache();
    const second = await runItemScan(key, { mailbox: "*" }, 0);

    // The restored session CONTINUED (cursor 4) instead of starting from 0.
    expect(second.session.nextSkip).toBe(4);
    expect(second.session.complete).toBe(true);
  });

  it("discards a persisted EMPTY session that never examined a message", async () => {
    // Live failure: while the sender shorthand was unresolved, an empty session
    // (`matched: 0`, `complete: true`, no message ever opened) was persisted.
    // Every later request — across deploys — reloaded it, believed it because it
    // said `complete`, and answered «رسائل مطابقة: 0 — مكتمل» INSTANTLY. A claimed
    // empty census with NO evidence of work is the imprint of a scan that never
    // started, so it must be dropped and re-scanned, never answered from.
    saved.set(
      'items:{"from":"EDC","mailbox":"*"}',
      JSON.stringify({
        census: { matched: 0 },
        items: [],
        messages: [],
        coverage: { messages: 0, lines: 0, attachments: 0 },
        attachmentCoverage: { messages: 0, scanned: 0 },
        nextSkip: 0,
        remaining: 0,
        batches: 0,
        complete: true,
        args: { from: "EDC", mailbox: "*" },
      }),
    );
    const pool = [1, 2, 3].map((uid) => ({
      uid,
      mailbox: "info@cortoba-supplies.com",
      subject: `EDC PO ${uid}`,
    }));
    scanEmails.mockImplementation(async (opts: { attachmentSkip?: number }) =>
      census(pool.slice(opts.attachmentSkip ?? 0, (opts.attachmentSkip ?? 0) + 3), 3),
    );

    const key = scanCacheKey("items", { from: "EDC", mailbox: "*" });
    const out = await runItemScan(key, { from: "EDC", mailbox: "*" }, Date.now() + 10_000);

    // A REAL scan ran: the poisoned zero was not believed.
    expect(scanEmails).toHaveBeenCalled();
    expect(out.session.census.matched).toBe(3);
    expect(out.session.coverage.messages).toBe(3);
    expect(out.session.complete).toBe(true);
  });

  it("does not let a transient zero-match window end a census that already matched", async () => {
    // `census.matched` is the authoritative size of the ask, but a transient IMAP
    // failure narrows a window to zero. Adopting that zero would set
    // `remaining = 0` and mark the census complete on the spot — ending a 3,700-
    // message census after its first window and reporting the sample as the total.
    const pool = [1, 2, 3, 4].map((uid) => ({
      uid,
      mailbox: "info@cortoba-supplies.com",
      subject: `EDC PO ${uid}`,
    }));
    let call = 0;
    scanEmails.mockImplementation(async (opts: { attachmentSkip?: number }) => {
      call += 1;
      // The second window fails transiently and reports nothing.
      if (call === 2) return census([], 0);
      return census(pool.slice(opts.attachmentSkip ?? 0, (opts.attachmentSkip ?? 0) + 2), 4);
    });

    const key = scanCacheKey("items", { mailbox: "*", from: "EDC" });
    const out = await runItemScan(key, { mailbox: "*", from: "EDC" }, Date.now() + 10_000);

    // The known total SURVIVED the bad window: 4, not 0.
    expect(out.session.census.matched).toBe(4);
  });
});

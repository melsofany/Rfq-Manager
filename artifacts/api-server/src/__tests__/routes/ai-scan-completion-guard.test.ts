import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A census must never report `complete` for an event that examined nothing.
 *
 * Production evidence: four background census jobs recorded
 * `{scanned: 0, matched: 0, complete: true}` in under 10 seconds and the
 * assistant told the operator «اكتملت المهمة» — over a request it had not read a
 * single message for. The cursor is trivially at the end of an empty ask
 * (0 of 0), so `remaining === 0` alone proved nothing.
 *
 * The distinction the guard preserves is the one the operator needs: a mailbox
 * that could not be read (0 envelopes examined) is a DIFFERENT problem from a
 * search term that matched nothing in a healthy mailbox (>0 examined), and only
 * the examined count can tell them apart.
 */

let censusFor: (args: any) => any;
let cache = new Map<string, any>();

vi.mock("../../modules/ai-assistant/email", () => ({
  scanEmails: async (args: any) => censusFor(args),
  // The session mirrors itself through `slimCensus`; this suite replaces the
  // whole module, so the helper must exist here too (it only drops the windowed
  // attachment buffers, which this fixture does not carry).
  slimCensus: (c: any) => ({ ...c, attachmentMessages: undefined }),
  getScanCacheEntry: (k: string) => cache.get(k),
  putScanCacheEntry: (k: string, v: any) => cache.set(k, v),
  persistScanSession: () => Promise.resolve(),
  loadPersistedScanSession: () => Promise.resolve(undefined),
}));

vi.mock("../../modules/ai-assistant/email-items", () => ({
  parseItemsFromAttachments: async (msgs: any[]) => ({
    items: [],
    messages: msgs.map((m) => ({ uid: m.uid })),
    coverage: {
      messages: msgs.length,
      readable: msgs.length,
      withItems: 0,
      noItems: 0,
      unreadable: 0,
      noAttachment: 0,
      attachments: 0,
      lines: 0,
      pages: 0,
      poDocuments: 0,
      rfqDocuments: 0,
      unknownDocuments: 0,
    },
  }),
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { runItemScan } = await import("../../modules/ai-assistant/item-scan-session");

/** A census the caller could not read: nothing matched AND nothing examined. */
function unreadableCensus() {
  return {
    matched: 0,
    emails: [],
    byMailbox: {},
    byMonth: {},
    bySender: [],
    numbers: [],
    distinctNumbers: 0,
    scope: { scanned: 0, truncated: false, mailboxes: [], folder: "inbox" },
    attachmentCoverage: { messages: 0, attachments: 0, truncated: false, scanned: 0 },
    attachmentMessages: [],
  };
}

/** A readable mailbox where the filter excluded every message. */
function filterMatchedNothingCensus() {
  return {
    ...unreadableCensus(),
    scope: { scanned: 3978, truncated: false, mailboxes: [], folder: "inbox" },
  };
}

/** A healthy census with real mail to read. */
function normalCensus() {
  return {
    matched: 2,
    emails: [],
    byMailbox: {},
    byMonth: {},
    bySender: [],
    numbers: [],
    distinctNumbers: 0,
    scope: { scanned: 300, truncated: false, mailboxes: [], folder: "inbox" },
    attachmentCoverage: { messages: 2, attachments: 2, truncated: false, scanned: 2 },
    attachmentMessages: [{ uid: 1, mailbox: "info", attachments: [] }],
  };
}

beforeEach(() => {
  cache = new Map();
});

describe("a census never claims completion without examining mail", () => {
  it("is NOT complete when the mailbox was never read (0 examined)", async () => {
    censusFor = () => unreadableCensus();
    const { session } = await runItemScan("k1", { mailbox: "info" }, Date.now() + 5_000);
    expect(session.census.matched).toBe(0);
    expect(session.examinedEnvelopes).toBe(0);
    // The bug: this was true, so the job reported «اكتملت» over a scan that read
    // nothing at all.
    expect(session.complete).toBe(false);
  });

  it("IS complete when a healthy mailbox was read and the filter matched nothing", async () => {
    censusFor = () => filterMatchedNothingCensus();
    const { session } = await runItemScan("k2", { mailbox: "info" }, Date.now() + 5_000);
    expect(session.examinedEnvelopes).toBeGreaterThan(0);
    // Read and finished: there simply were no matches. That is a real answer.
    expect(session.complete).toBe(true);
  });

  it("completes normally when matching mail was opened", async () => {
    censusFor = () => normalCensus();
    const { session } = await runItemScan("k3", { mailbox: "info" }, Date.now() + 5_000);
    expect(session.examinedEnvelopes).toBeGreaterThan(0);
    expect(session.complete).toBe(true);
  });
});

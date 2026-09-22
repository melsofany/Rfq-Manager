/**
 * Email CENSUS (`scan_emails`).
 *
 * Live failure (reported by the operator, reproduced against the real mailbox):
 * they asked the WhatsApp assistant to count/census EDC RFQ numbers for 2026 and
 * compare them with the system. The assistant answered «10 رسائل», then «أكثر من
 * 30»، then declared a hard limit and asked the operator to split the work into
 * months. The truth, measured on the live mailbox:
 *
 *   info@cortoba-supplies.com  — 3,875 messages, 1,582 with subject
 *                                «EDC RFQ No …» (1,581 distinct numbers)
 *   procurement@               — 429 messages, 0 from EDC
 *
 * So the assistant was wrong by two orders of magnitude, and the cause was
 * structural, not a bad prompt:
 *   - `searchEmails` reads a fixed newest-400 window (BODY_SCAN_BUDGET), so the
 *     rest of the year was invisible;
 *   - its `limit` is clamped to 30, so it can never return more than 30 rows;
 *   - there was NO aggregation capability at all — nothing could count.
 *
 * `scanEmails` exists to make a census possible. These tests pin the properties
 * that make its answer trustworthy: the whole mailbox is reachable, the count is
 * exact, coverage is reported, and a partial scan is never passed off as a total.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

/** Envelopes the fake mailbox holds, and how it was searched. */
let envelopes: Array<{ uid: number; subject: string; from: string; date: string }> = [];
let searchCalls: Array<Record<string, unknown>> = [];
let fetched: number[] = [];
/** Max envelopes the fake server will return from one search (budget probe). */
let serverCap = Number.POSITIVE_INFINITY;

function makeClient() {
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
    search(criteria: Record<string, unknown>) {
      searchCalls.push(criteria);
      let rows = envelopes;
      if (typeof criteria.from === "string") {
        const needle = criteria.from.toLowerCase();
        rows = rows.filter((e) => e.from.toLowerCase().includes(needle));
      }
      if (typeof criteria.subject === "string") {
        const needle = criteria.subject.toLowerCase();
        rows = rows.filter((e) => e.subject.toLowerCase().includes(needle));
      }
      if (criteria.since instanceof Date) {
        rows = rows.filter((e) => new Date(e.date) >= (criteria.since as Date));
      }
      if (criteria.before instanceof Date) {
        rows = rows.filter((e) => new Date(e.date) < (criteria.before as Date));
      }
      return Promise.resolve(rows.map((e) => e.uid).slice(0, serverCap));
    }
    fetch(seqs: number[]) {
      const selected = envelopes.filter((e) => seqs.includes(e.uid));
      return {
        async *[Symbol.asyncIterator]() {
          for (const e of selected) {
            fetched.push(e.uid);
            yield {
              uid: e.uid,
              envelope: {
                from: [{ name: "EDC", address: e.from }],
                to: [{ address: "info@cortoba-supplies.com" }],
                subject: e.subject,
                date: new Date(e.date),
              },
              flags: new Set<string>(),
            };
          }
        },
      };
    }
  };
}

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
// Production reads multi-mailbox via domain-wide delegation. Mock the delegation
// boundary (not googleapis — that mock is bypassed by the SDK's dynamic import)
// so the fan-out can be exercised without touching Google.
vi.mock("../../modules/ai-assistant/gmail-auth", () => ({
  isDelegationConfigured: () => true,
  gmailAccessToken: vi.fn(async () => "fake-token"),
  clearTokenCache: vi.fn(),
}));
vi.mock("../../modules/ai-assistant/mailboxes", () => {
  const all = [
    { email: "procurement@cortoba-supplies.com", label: "المشتريات", isDefault: true },
    { email: "info@cortoba-supplies.com", label: "العام", isDefault: false },
  ];
  return {
    mailboxes: () => all,
    mailboxListForDisplay: () => all.map((m) => m.email).join(", "),
    // Mirrors the real resolver: a full address, a bare local part ("info@" or
    // "info"), or the label all resolve to a configured mailbox.
    resolveMailbox: (ref?: string) => {
      if (!ref || !ref.trim()) return all[0];
      const needle = ref.trim().toLowerCase().replace(/@+$/, "");
      return (
        all.find((m) => m.email === needle) ||
        all.find((m) => m.email.split("@")[0] === needle) ||
        all.find((m) => m.label.toLowerCase() === needle)
      );
    },
  };
});

process.env.SMTP_USER = "info@cortoba-supplies.com";
process.env.SMTP_HOST = "imap.example.com";
process.env.IMAP_HOST = "imap.example.com";
process.env.SMTP_PASS = "secret";
process.env.AI_MAILBOXES = "info@cortoba-supplies.com|العام";

/** A year of EDC RFQ mail, far more than the old 400-message window. */
function buildYear(count = 900): typeof envelopes {
  const out: typeof envelopes = [];
  for (let i = 0; i < count; i++) {
    const month = String((i % 9) + 1).padStart(2, "0");
    const day = String((i % 27) + 1).padStart(2, "0");
    out.push({
      uid: i + 1,
      subject: `EDC RFQ No 26R${String(100000 + i)}`,
      from: "noreply@egyptian-drilling.com",
      date: `2026-${month}-${day}T08:00:00Z`,
    });
  }
  return out;
}

beforeEach(() => {
  envelopes = buildYear();
  searchCalls = [];
  fetched = [];
  serverCap = Number.POSITIVE_INFINITY;
  clientClass = makeClient();
  vi.clearAllMocks();
});

describe("extractNumbers", () => {
  it("pulls the document numbers this business keys on out of a subject", async () => {
    const { extractNumbers, DEFAULT_NUMBER_PATTERNS: patterns } =
      await import("../../modules/ai-assistant/email");
    const found = extractNumbers("EDC RFQ No 26R011936 / PO P26E11407 / RFQ-6152439", [
      ...patterns,
    ]);
    expect(found).toContain("26R011936");
    expect(found).toContain("P26E11407");
    expect(found).toContain("RFQ-6152439");
  });

  it("ignores an invalid pattern instead of failing the scan", async () => {
    const { extractNumbers } = await import("../../modules/ai-assistant/email");
    expect(extractNumbers("26R011936", ["([unclosed", "\\b\\d{2}R\\d{5,9}\\b"])).toEqual([
      "26R011936",
    ]);
  });

  it("reports the bare address for a display-name sender", async () => {
    const { senderAddress } = await import("../../modules/ai-assistant/email");
    expect(senderAddress("EDC noreply@egyptian-drilling.com")).toBe(
      "noreply@egyptian-drilling.com",
    );
    expect(senderAddress("EDC - Egyptian Drilling Company <purchasing@edc.com.eg>")).toBe(
      "purchasing@edc.com.eg",
    );
  });
});

describe("scanEmails census", () => {
  it("covers EVERY configured mailbox when none is named", async () => {
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const res = await scanEmails({ from: "egyptian-drilling" });
    // Reading only the default inbox would report a partial count while the note
    // claimed completeness — the exact silent-partial failure this fixes.
    expect(Object.keys(res.byMailbox).sort()).toEqual([
      "info@cortoba-supplies.com",
      "procurement@cortoba-supplies.com",
    ]);
    expect(res.scope.mailboxes).toHaveLength(2);
  });

  it("narrows to one mailbox only when one is explicitly named", async () => {
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const res = await scanEmails({ from: "egyptian-drilling", mailbox: "info@" });
    expect(Object.keys(res.byMailbox)).toEqual(["info@cortoba-supplies.com"]);
  });

  it("counts the WHOLE mailbox, not a recent window (the 400-message bug)", async () => {
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const res = await scanEmails({
      from: "egyptian-drilling",
      sinceDate: "2026-01-01",
      mailbox: "info@",
    });

    // 900 real EDC messages. The old path could only ever see 400 of them.
    expect(res.matched).toBe(900);
    expect(res.matched).toBeGreaterThan(400);
    expect(res.scope.scanned).toBeGreaterThanOrEqual(900);
    expect(res.scope.truncated).toBe(false);
    expect(res.distinctNumbers).toBe(900);
  });

  it("reports the count as a TOTAL only when the scan was complete", async () => {
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const res = await scanEmails({ from: "egyptian-drilling", mailbox: "info@" });
    expect(res.note).toContain("إجمالي");
    expect(res.note).not.toContain("حدّ أدنى");
  });

  it("says a truncated scan is a LOWER BOUND instead of presenting it as a total", async () => {
    // A mailbox larger than the envelope budget: the scan cannot cover it all.
    process.env.AI_CENSUS_ENVELOPE_BUDGET = "500";
    try {
      const { scanEmails } = await import("../../modules/ai-assistant/email");
      const res = await scanEmails({ from: "egyptian-drilling", mailbox: "info@" });
      expect(res.matched).toBe(500);
      expect(res.scope.truncated).toBe(true);
      expect(res.note).toContain("حدّ أدنى");
      expect(res.note).not.toContain("إجمالي وليس عيّنة");
    } finally {
      delete process.env.AI_CENSUS_ENVELOPE_BUDGET;
    }
  });

  it("narrows SERVER-SIDE so the whole mailbox is reachable", async () => {
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    await scanEmails({ from: "egyptian-drilling", sinceDate: "2026-01-01", mailbox: "info@" });
    // The IMAP search itself must carry the narrowing — fetching every envelope
    // of a large mailbox is what made a full census too slow to attempt.
    const narrowed = searchCalls.find((c) => c.from === "egyptian-drilling");
    expect(narrowed).toBeTruthy();
    expect(narrowed!.since).toBeInstanceOf(Date);
  });

  it("aggregates by month and by sender rather than returning a page to add up", async () => {
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const res = await scanEmails({ from: "egyptian-drilling", mailbox: "info@" });
    const months = Object.keys(res.byMonth);
    expect(months.length).toBeGreaterThan(1);
    const total = Object.values(res.byMonth).reduce((a, b) => a + b, 0);
    expect(total).toBe(res.matched);
    expect(res.bySender[0].from).toBe("noreply@egyptian-drilling.com");
  });

  it("returns an exact total while capping only the returned list", async () => {
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const res = await scanEmails({ from: "egyptian-drilling", limit: 5, mailbox: "info@" });
    // The old tool clamped `limit` and the COUNT followed it. The count is the
    // answer; the list is a sample.
    expect(res.matched).toBe(900);
    expect(res.emails).toHaveLength(5);
    expect(res.returned).toBe(5);
  });

  it("supports splitting a census by date range", async () => {
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const q1 = await scanEmails({
      from: "egyptian-drilling",
      sinceDate: "2026-01-01",
      beforeDate: "2026-04-01",
      mailbox: "info@",
    });
    const q2 = await scanEmails({
      from: "egyptian-drilling",
      sinceDate: "2026-04-01",
      beforeDate: "2026-07-01",
      mailbox: "info@",
    });
    // Each part covers only its window, and the parts sum to the whole.
    expect(q1.matched + q2.matched).toBeLessThan(900);
    expect(q1.matched).toBeGreaterThan(0);
    expect(q2.matched).toBeGreaterThan(0);
  });

  it("does not fetch bodies — a census is envelope-only", async () => {
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    await scanEmails({ from: "egyptian-drilling", mailbox: "info@" });
    // Every scanned message yields an envelope; no `source` fetch is requested.
    expect(fetched.length).toBe(900);
  });

  it("falls back to the whole mailbox when the server-side narrowing finds nothing", async () => {
    // Some servers mangle a display-name search; a census must not report zero.
    clientClass = class extends makeClient() {
      search(criteria: Record<string, unknown>) {
        if (typeof criteria.from === "string") return Promise.resolve([]);
        return super.search({ all: true });
      }
    };
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const res = await scanEmails({ from: "EDC - Egyptian Drilling", mailbox: "info@" });
    expect(res.matched).toBeGreaterThan(0);
    // The fallback must be disclosed — it means the server did not narrow, so the
    // whole box was read and filtered here.
    expect(res.scope.mailboxes[0].serverNarrowed).toBe(false);
  });

  it("still honours the date range when the server narrowing falls back", async () => {
    // The fallback path re-reads the whole mailbox. If the dates are not
    // re-verified client-side, a month slice silently returns the whole year —
    // observed live as a March 2026 slice reporting 3,710 messages.
    clientClass = class extends makeClient() {
      search(criteria: Record<string, unknown>) {
        if (typeof criteria.from === "string") return Promise.resolve([]);
        return super.search({ all: true });
      }
    };
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const march = await scanEmails({
      from: "egyptian-drilling",
      sinceDate: "2026-03-01",
      beforeDate: "2026-04-01",
      mailbox: "info@",
    });
    const all = await scanEmails({ from: "egyptian-drilling", mailbox: "info@" });
    expect(march.matched).toBeGreaterThan(0);
    // Strictly fewer than the full set: the window was actually applied.
    expect(march.matched).toBeLessThan(all.matched);
  });

  it("reports every criterion as verified when the server narrowed normally", async () => {
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const res = await scanEmails({ from: "egyptian-drilling", mailbox: "info@" });
    expect(res.scope.mailboxes[0].serverNarrowed).toBe(true);
  });
});

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
/**
 * The sender's DISPLAY name in the envelope. Live EDC mail carries only the
 * address (`noreply@egyptian-drilling.com`) with no company name, which is why a
 * `from:"EDC"` filter matches nothing and the shorthand resolver exists. Tests
 * that model that case set this; the rest keep a name for readability.
 */
let senderDisplayName = "EDC";
/** Mailboxes whose login must FAIL, modelling a missing delegation grant. */
let unreadableMailboxes = new Set<string>();

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
                from: [{ name: senderDisplayName, address: e.from }],
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
    constructor(_opts: any) {
      const opts = _opts as { auth?: { user?: string } };
      // Model the LIVE failure: `info@` has no Workspace delegation grant, so its
      // login is refused, while `procurement@` authenticates with the app
      // password. Without this, a test cannot tell "one box failed" from "the
      // whole census failed".
      if (unreadableMailboxes.has(String(opts?.auth?.user ?? "").toLowerCase())) {
        throw new Error("unauthorized_client: Client is unauthorized to retrieve access tokens");
      }
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

beforeEach(async () => {
  envelopes = buildYear();
  searchCalls = [];
  fetched = [];
  serverCap = Number.POSITIVE_INFINITY;
  senderDisplayName = "EDC";
  unreadableMailboxes = new Set<string>();
  clientClass = makeClient();
  vi.clearAllMocks();
  // The scan result cache is module-level and would leak a previous test's mail
  // into the next one; each case here models a DIFFERENT mailbox.
  const { clearScanCache } = await import("../../modules/ai-assistant/email");
  clearScanCache();
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

  it("keeps the mailboxes it CAN read when one mailbox is unreadable (the live EDC outage)", async () => {
    // Live: `info@` had no Workspace delegation grant while `procurement@`
    // answered fine. `Promise.all` rejected on the first failure, so the whole
    // census threw its admin instructions and the readable mail was discarded —
    // the operator got «تعذّر قراءة البريد» over a mailbox that worked.
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    unreadableMailboxes = new Set(["info@cortoba-supplies.com"]);
    const res = await scanEmails({ from: "egyptian-drilling" });

    // The readable box is still counted...
    expect(Object.keys(res.byMailbox)).toEqual(["procurement@cortoba-supplies.com"]);
    expect(res.matched).toBe(900);
    // ...and the unreadable one is NAMED rather than silently dropped, so the
    // count is not mistaken for a complete census.
    expect(res.mailboxErrors).toHaveLength(1);
    expect(res.mailboxErrors?.[0].mailbox).toBe("info@cortoba-supplies.com");
    expect(res.note).toContain("تعذّرت قراءة");
    expect(res.note).toContain("لا تقل إنه لا توجد رسائل منه");
  });

  it("still fails when NO mailbox could be read (a partial answer needs a readable box)", async () => {
    // Nothing was read, so there is no partial result to hand over — reporting
    // zero matches here would be a false negative about the whole mailbox.
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    unreadableMailboxes = new Set([
      "info@cortoba-supplies.com",
      "procurement@cortoba-supplies.com",
    ]);
    await expect(scanEmails({ from: "egyptian-drilling" })).rejects.toThrow(/unauthorized_client/);
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

  it("marks a truncated ATTACHMENT pass in the census scope, not just the envelope scan", async () => {
    // The live bug: the envelope scan covered every match, so `scope.truncated`
    // read false while the attachment pass had opened a fraction of them. The
    // census must fold the attachment coverage into its own truncation flag.
    process.env.AI_ATTACHMENT_SCAN_BUDGET = "500";
    try {
      const { scanEmails } = await import("../../modules/ai-assistant/email");
      const res = await scanEmails({
        from: "egyptian-drilling",
        mailbox: "info@",
        includeAttachments: true,
      });
      expect(res.matched).toBe(900);
      // The envelope scan itself read all 900 — this is NOT the truncation.
      expect(res.scope.mailboxes[0].truncated).toBe(false);
      expect(res.attachmentCoverage?.truncated).toBe(true);
      expect(res.scope.truncated).toBe(true);
      expect(res.note).toContain("حدّ أدنى");
    } finally {
      delete process.env.AI_ATTACHMENT_SCAN_BUDGET;
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

describe("scanEmails sender shorthand resolution", () => {
  /**
   * Live (24/09): the operator asked for the POs «الواردة من EDC». «EDC» appears
   * in the SUBJECTS (`EDC PO No P26E14708`) but in no address — the real sender
   * is `noreply@egyptian-drilling.com`. Filtering `from:"EDC"` matched nothing
   * and the assistant announced there were no EDC documents at all.
   */
  beforeEach(() => {
    // Live shape: the display name is ABSENT and the address contains no «EDC» —
    // the word is only in the subject. Anything else would let the client-side
    // filter match and hide the bug the resolver exists for.
    senderDisplayName = "Egyptian Drilling Company";
    // A mailbox where the shorthand reaches messages from two addresses, plus a
    // tiny slice from an unrelated domain.
    envelopes = [
      ...Array.from({ length: 300 }, (_, i) => ({
        uid: i + 1,
        subject: `EDC PO No P26E${14000 + i}`,
        from: "noreply@egyptian-drilling.com",
        date: "2026-09-01T08:00:00Z",
      })),
      ...Array.from({ length: 40 }, (_, i) => ({
        uid: 1000 + i,
        subject: `EDC PO No P26E${15000 + i}`,
        from: "purchasing.manager@egyptian-drilling.com",
        date: "2026-09-02T08:00:00Z",
      })),
      {
        uid: 2000,
        subject: "EDC PO No P26E19999",
        from: "workspace-noreply@google.com",
        date: "2026-09-03T08:00:00Z",
      },
    ];
  });

  it("resolves a shorthand sender to the real address instead of reporting zero", async () => {
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const res = await scanEmails({ from: "EDC", mailbox: "info@" });
    expect(res.senderResolution?.requested).toBe("EDC");
    expect(res.senderResolution?.resolved).toBe("noreply@egyptian-drilling.com");
    expect(res.senderResolution?.domain).toBe("egyptian-drilling.com");
    // 340 = the whole COMPANY: 300 from `noreply@` + 40 from a colleague's
    // mailbox. The one Google message that also says «EDC» is a different domain
    // and correctly excluded. Filtering the single address would have dropped the
    // colleague's 40 real orders.
    expect(res.matched).toBe(340);
    // The disclosed resolution is what lets the model name the address it
    // actually searched, rather than leaving the operator with «لا توجد رسائل».
    expect(res.note).toContain("noreply@egyptian-drilling.com");
    expect(res.note).toContain("egyptian-drilling.com");
    expect(res.note).toContain("EDC");
  });

  it("counts the whole company, not one mailbox on its domain", async () => {
    // The operator names a COMPANY («EDC»). Its orders arrive from `noreply@` AND
    // from individual buyers; keeping only the busiest address would silently drop
    // real orders from the census — a partial answer presented as the company's.
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const res = await scanEmails({ from: "EDC", mailbox: "info@" });
    expect(res.matched).toBe(340);
    const senders = res.bySender.map((s) => s.from);
    expect(senders).toContain("noreply@egyptian-drilling.com");
    expect(senders).toContain("purchasing.manager@egyptian-drilling.com");
    // …and no unrelated domain is dragged in by a subject-only coincidence.
    expect(senders).not.toContain("workspace-noreply@google.com");
  });

  it("leaves a real address alone (no needless resolution)", async () => {
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const res = await scanEmails({ from: "noreply@egyptian-drilling.com", mailbox: "info@" });
    expect(res.matched).toBe(300);
    expect(res.senderResolution ?? null).toBeNull();
  });

  it("keeps the OTHER criteria while it resolves a sender", async () => {
    // Resolving the sender must not widen the census: a `subject` filter the
    // operator gave is part of the question, not an accident of the retry.
    senderDisplayName = "Egyptian Drilling Company";
    envelopes = [
      ...Array.from({ length: 20 }, (_, i) => ({
        uid: i + 1,
        subject: `EDC PO No P26E${14000 + i}`,
        from: "noreply@egyptian-drilling.com",
        date: "2026-09-01T08:00:00Z",
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        uid: 100 + i,
        subject: `EDC Quotation 26R${200000 + i}`,
        from: "noreply@egyptian-drilling.com",
        date: "2026-09-01T08:00:00Z",
      })),
    ];
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const res = await scanEmails({ from: "EDC", subject: "PO No", mailbox: "info@" });
    expect(res.senderResolution?.resolved).toBe("noreply@egyptian-drilling.com");
    // 20 (the PO subjects) — the 7 quotation messages must not be pulled in.
    expect(res.matched).toBe(20);
  });

  it("discloses the senders it saw when it cannot resolve the shorthand", async () => {
    // Two companies at comparable volume: choosing would answer about the wrong
    // one, so the census refuses and hands back the candidates to ask about.
    senderDisplayName = "Egyptian Drilling Company";
    envelopes = [
      ...Array.from({ length: 100 }, (_, i) => ({
        uid: i + 1,
        subject: `EDC PO No P26E${16000 + i}`,
        from: "sales@egyptian-drilling.com",
        date: "2026-09-01T08:00:00Z",
      })),
      ...Array.from({ length: 90 }, (_, i) => ({
        uid: 500 + i,
        subject: `EDC PO No P26E${17000 + i}`,
        // NOTE: the address must not itself contain «edc», or the original
        // server-side filter would match and the resolution path never runs —
        // which would make this test pass without exercising the refusal.
        from: "info@delta-supplies.com",
        date: "2026-09-01T08:00:00Z",
      })),
    ];
    const { scanEmails } = await import("../../modules/ai-assistant/email");
    const res = await scanEmails({ from: "EDC", mailbox: "info@" });
    expect(res.senderResolution?.requested).toBe("EDC");
    expect(res.senderResolution?.resolved).toBeNull();
    expect(res.senderResolution?.candidates.length).toBeGreaterThanOrEqual(2);
    // The note must not read as «no EDC mail»: that is the reported failure.
    expect(res.note).toContain("لم يطابق أي مُرسل");
    expect(res.note).toContain("لا تقل «لا توجد رسائل من هذا المُرسل»");
    expect(res.note).toContain("info@delta-supplies.com");
  });
  /**
   * The resume cursor must advance over a CONTIGUOUS PREFIX, never over a sum.
   *
   * The attachment fetch opens one connection per mailbox concurrently, so a
   * mailbox that finishes its whole group and one that stops early on the clock
   * together produce a count that says nothing about WHICH messages were read.
   * Advancing `nextSkip` by that sum skips the tail of the mailbox that stopped —
   * mail that was never opened gets recorded as done, so a resumed census can
   * miss it silently. That is the same false-negative class as the RFQ discard.
   */
  it("advances the cursor over a contiguous prefix, not across a mailbox that stopped early", async () => {
    const { contiguousPrefix } = await import("../../modules/ai-assistant/email");

    // Window interleaves info@, procurement@, finance@. Only info@ and
    // procurement@ were read; finance@ stopped on the clock.
    const considered = [
      { mailbox: "info@" },
      { mailbox: "procurement@" },
      { mailbox: "finance@" }, // <- first unread message
      { mailbox: "info@" },
      { mailbox: "procurement@" },
    ];
    const scanned = new Map([
      ["info@", 2],
      ["procurement@", 2],
      ["finance@", 0],
    ]);

    // The naive sum (4) would skip message index 3 and 4, though index 2 was
    // never opened and index 3 may belong to a mailbox read only past a gap.
    const naiveSum = [...scanned.values()].reduce((a, b) => a + b, 0);
    expect(naiveSum).toBe(4);
    expect(contiguousPrefix(considered, scanned)).toBe(2);

    // Every mailbox fully read => the whole window is safely skipped.
    expect(
      contiguousPrefix(
        considered,
        new Map([
          ["info@", 2],
          ["procurement@", 2],
          ["finance@", 1],
        ]),
      ),
    ).toBe(5);

    // A mailbox absent from the map has no reads: the prefix stops at the FIRST
    // message of a mailbox that was not read — here `procurement@` at index 1,
    // so only the leading `info@` message is safe to skip past.
    expect(contiguousPrefix(considered, new Map([["info@", 2]]))).toBe(1);
    expect(contiguousPrefix([], new Map())).toBe(0);
  });
});

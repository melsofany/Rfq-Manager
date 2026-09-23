/**
 * The two live defects behind the reported failure, pinned as regression tests.
 *
 * 1. TIMEOUT — a follow-up question about the same mail re-ran the whole
 *    scan+parse. `scan_email_items` took 35-43s per call against the real
 *    mailbox, so «ليه السخانات الأريستون مش في التقرير؟» — asked immediately
 *    after the first scan — blew the agent's 150s budget and answered with a
 *    timeout notice. The scan+parse is now memoized on the scan arguments, so
 *    the follow-up is instant.
 *
 * 2. MISSING OLDER ORDERS — the census window covers only the newest N
 *    messages, so a brand that appears in OLDER orders was absent from the
 *    report while the note read as if the whole mailbox had been searched. The
 *    `contains` filter answers a brand lookup directly, and the note now says
 *    plainly which window was searched and that older mail was NOT.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

const scanEmails = vi.fn();
const extractPdfText = vi.fn<(b: Buffer) => Promise<string>>();

vi.mock("../../modules/ai-assistant/email", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanEmails,
  searchEmails: vi.fn(),
  extractPdfText,
  isEmailReadConfigured: () => true,
}));

vi.mock("@workspace/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }) },
}));

vi.mock("../../modules/ai-assistant/pdf", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generateAssistantPdf: vi.fn(async () => Buffer.from("%PDF-fake")),
}));

/** Extracted text carrying an Ariston water heater line, as the parser sees it. */
const ARISTON_TEXT = `Line
No.
Quantity UOM Part No Line Item Delivery Date Unit Price Total (EGP)
1 12 Piece 05-OCT-2026 75.00 900.00
0666.001.ARSTON.0004
WATER HEATER ARISTON RUBIS PRO 40 V EG , MAKER : ARISTON`;

const PLAIN_TEXT = `Line
No.
Quantity UOM Part No Line Item Delivery Date Unit Price Total (EGP)
1 5 Piece 05-OCT-2026 10.00 50.00
5720.015.GENRAL.0016
خرطوم لفة ملي 16`;

function censusWith(texts: string[], truncated: boolean, matched = texts.length) {
  return {
    matched,
    numbers: [],
    byMonth: {},
    bySender: {},
    distinctNumbers: [],
    scanned: matched,
    truncated,
    isTotal: !truncated,
    byMailbox: {},
    attachmentMessages: texts.map((t, i) => ({
      mailbox: "edc",
      folder: "INBOX",
      uid: 100 + i,
      to: "procurement@x",
      numbers: [],
      attachments: [
        { filename: `po-${i}.pdf`, mimeType: "application/pdf", content: Buffer.from(`pdf-${i}`) },
      ],
    })),
    attachmentCoverage: {
      messages: texts.length,
      attachments: texts.length,
      truncated,
      unreadable: 0,
    },
  };
}

const { executeTool } = await import("../../modules/ai-assistant/tools");
const { clearScanCache } = await import("../../modules/ai-assistant/email");

function makeCtx() {
  return {
    settings: {
      enabled: true,
      model: "test",
      baseUrl: null,
      systemPrompt: null,
      language: "ar",
      allowEmail: true,
      allowDatabase: true,
      allowPdf: false,
    },
    phone: "2010",
    outbox: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearScanCache();
  const byFilename: Record<string, string> = { "pdf-0": PLAIN_TEXT, "pdf-1": ARISTON_TEXT };
  extractPdfText.mockImplementation(async (b: Buffer) => byFilename[b.toString()] ?? PLAIN_TEXT);
});

describe("scan_email_items memoization (timeout fix)", () => {
  it("does NOT re-scan when a follow-up asks about the same mail", async () => {
    scanEmails.mockResolvedValue(censusWith([PLAIN_TEXT, ARISTON_TEXT], false));
    const ctx = makeCtx();

    const first = await executeTool("scan_email_items", { from: "edc", top: 5 }, ctx as never);
    expect(first.ok).toBe(true);
    expect(scanEmails).toHaveBeenCalledTimes(1);

    // The follow-up: same scan args, different question.
    const second = await executeTool(
      "scan_email_items",
      { from: "edc", top: 5, contains: "ariston" },
      ctx as never,
    );
    expect(second.ok).toBe(true);
    // The whole point: the expensive census ran ONCE across both calls.
    expect(scanEmails).toHaveBeenCalledTimes(1);
  });

  it("re-scans when the scope actually changes", async () => {
    scanEmails.mockResolvedValue(censusWith([PLAIN_TEXT], false));
    const ctx = makeCtx();
    await executeTool("scan_email_items", { from: "edc", top: 5 }, ctx as never);
    await executeTool(
      "scan_email_items",
      { from: "edc", sinceDate: "2026-06-01", top: 5 },
      ctx as never,
    );
    expect(scanEmails).toHaveBeenCalledTimes(2);
  });
});

describe("scan_email_items contains filter (missing older orders)", () => {
  it("narrows the result set to the requested brand only", async () => {
    scanEmails.mockResolvedValue(censusWith([PLAIN_TEXT, ARISTON_TEXT], false));
    const ctx = makeCtx();

    const all = await executeTool("scan_email_items", { from: "edc", top: 50 }, ctx as never);
    expect((all.data as { topItems: unknown[] }).topItems.length).toBeGreaterThan(1);

    // The brand filter surfaces only the rows that match it — the rows a plain
    // «اكتر بند اتكرر» report mixes in among everything else.
    const filtered = await executeTool(
      "scan_email_items",
      { from: "edc", top: 10, contains: "ariston" },
      ctx as never,
    );
    expect(filtered.ok).toBe(true);
    const data = filtered.data as { topItems: Array<{ partNo: string }>; matchedLines: number };
    expect(data.topItems.length).toBe(1);
    expect(data.topItems[0].partNo).toContain("ARSTON");
    expect(data.matchedLines).toBe(1);
  });

  it("matches on the part number as well as the description", async () => {
    scanEmails.mockResolvedValue(censusWith([PLAIN_TEXT, ARISTON_TEXT], false));
    const ctx = makeCtx();
    const r = await executeTool(
      "scan_email_items",
      { from: "edc", contains: "ARSTON" },
      ctx as never,
    );
    expect((r.data as { matchedLines: number }).matchedLines).toBeGreaterThan(0);
  });

  it("says a truncated scan did NOT cover everything instead of implying «غير موجود»", async () => {
    // 3,753 matched but only the newest 1 was opened — the live shape.
    scanEmails.mockResolvedValue(censusWith([PLAIN_TEXT], true, 3753));
    const ctx = makeCtx();
    const r = await executeTool(
      "scan_email_items",
      { from: "edc", contains: "ariston" },
      ctx as never,
    );
    const note = (r.data as { note: string }).note;
    expect(note).toContain("لم تُفحص");
    expect(note).toContain("3753");
    expect(note).toContain("قد يكون في رسائل أقدم");
    expect((r.data as { isComplete: boolean }).isComplete).toBe(false);
  });
});

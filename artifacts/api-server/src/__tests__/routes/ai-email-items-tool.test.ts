/**
 * `scan_email_items` as the model sees it.
 *
 * Live failure: asked for the items/quantities inside EDC's RFQ and PO files for
 * the year, the assistant answered that the data was inside attachments it could
 * not read — and its only file-reading path (Gemini `inline_data`) was out of
 * quota anyway. The items are read locally now, and this file pins the wiring:
 * the census finds the messages, the parser reads the PDFs, and the coverage is
 * reported so a partial read is never presented as a complete census.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

const scanEmails = vi.fn();
/**
 * The extraction is mocked with the REAL text of an EDC PO attachment: pdf.js's
 * behavior on synthetic PDFs is not reproducible under vitest, while the real
 * attachments parse correctly in plain Node. What this file tests is the tool
 * wiring and the parser, both of which see this exact string either way.
 */
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
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    // The oversize-census hand-off creates a real job row, so `insert`/`update`
    // must exist or the hand-off would fail with a TypeError instead of queueing.
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: () => Promise.resolve([{ id: 1, ...v }]),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));

vi.mock("../../modules/ai-assistant/pdf", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generateAssistantPdf: vi.fn(async () => Buffer.from("%PDF-fake")),
}));

// The oversize-census hand-off calls the WhatsApp sender from the background
// worker's finish callback; it must be a no-op here rather than a real network
// call (the worker runs detached and would otherwise hit the API after the test).
vi.mock("../../modules/communications/service", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendWhatsAppText: vi.fn(async () => undefined),
  sendWhatsAppDocument: vi.fn(async () => undefined),
}));

/** One attached PDF, as the item parser receives it. */
function pdfAttachments(files: Array<{ filename: string; content: Buffer }>) {
  return files.map((f) => ({
    filename: f.filename,
    mimeType: "application/pdf",
    content: f.content,
  }));
}

/** Real extracted text of EDC PO P26E14630 (both pages). */
const PO_TEXT = `PO number: P26E14630(RIG58)
Line
No.
Quantity UOM Part No Line Item Delivery Date Unit Price Total (EGP)
1 12 Piece 05-OCT-2026 75.00 900.00
0666.000.GENRAL.0006
2 INCH BRASS LONG SHACKLE PADLOCK WITH
3 KEYS-CHINA MADE-GOOD QUALITY
2 1 Piece 05-OCT-2026 126.00 126.00
0600.000.GENRAL.0005
VALUE ADDED TAX LOCAL
Total Price 1,026.00

Purchase Order Distribution List
Line Quote
No. Ref.
PR Ref. Quantity UOM Part No Line Item Unit Price Total
RIG58- 1 E5G260287 26R01098 12 Piece 06.66.000 0666.000.GENRAL.0006 75.00 900.00`;

const { executeTool, toolDefinitions } = await import("../../modules/ai-assistant/tools");

const ctx = {
  settings: { allowDatabase: true, allowEmail: true, allowPdf: true },
  outbox: [] as { filename: string; mimeType: string; buffer: Buffer }[],
} as never as {
  settings: Record<string, boolean>;
  outbox: { filename: string; mimeType: string; buffer: Buffer }[];
};

/** A census whose attachments are supplied by the test. */
function censusWithAttachments(
  messages: Array<{
    uid: number;
    mailbox: string;
    subject: string;
    date?: string;
    attachments: Array<{ filename: string; mimeType: string | null; content: Buffer | null }>;
  }>,
  overrides: Record<string, unknown> = {},
) {
  // `matched` defaults to the number of messages supplied so the census is
  // internally consistent (every matched message's attachments were opened).
  // Tests that model a SHORTFALL override `matched` explicitly.
  return {
    matched: messages.length,
    returned: messages.length,
    emails: messages.map((m) => ({
      uid: m.uid,
      mailbox: m.mailbox,
      folder: "inbox",
      from: "noreply@egyptian-drilling.com",
      to: m.mailbox,
      subject: m.subject,
      date: "2026-09-22T10:00:00Z",
      numbers: [],
    })),
    byMailbox: { "info@cortoba-supplies.com": 137 },
    byMonth: { "2026-09": 137 },
    bySender: [],
    numbers: [],
    distinctNumbers: 0,
    numbersTruncated: false,
    attachmentCoverage: {
      messages: messages.length,
      scanned: messages.length,
      readable: messages.length,
      unreadable: 0,
      attachments: messages.length,
      truncated: false,
    },
    attachmentMessages: messages.map((m) => ({
      uid: m.uid,
      mailbox: m.mailbox,
      folder: "inbox",
      subject: m.subject,
      date: "2026-09-22T10:00:00Z",
      from: "noreply@egyptian-drilling.com",
      attachments: m.attachments,
    })),
    scope: {
      folder: "inbox",
      sinceDate: null,
      beforeDate: null,
      mailboxes: [{ mailbox: "info@cortoba-supplies.com", scanned: 3875, truncated: false }],
      scanned: 3875,
      truncated: false,
      elapsedMs: 1000,
    },
    note: "حصر كامل.",
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  ctx.outbox.length = 0;
  // The scan+parse memo is module-level; without this a previous test's mail
  // would be served to the next case.
  const { clearScanCache } = await import("../../modules/ai-assistant/email");
  clearScanCache();
  // Unreadable files are modelled by content, so a scan can be simulated.
  extractPdfText.mockImplementation(async (buf: Buffer) =>
    buf.toString("latin1").includes("scanned") ? "" : PO_TEXT,
  );
});

describe("scan_email_items tool", () => {
  it("is offered to the model and distinguishes itself from search_emails", () => {
    const defs = toolDefinitions(ctx as never);
    const def = defs.find((d) => d.function.name === "scan_email_items");
    expect(def).toBeTruthy();
    // The model must not reach for search_emails here: it never opens a file.
    expect(def!.function.description).toContain("مرفقات");
    expect(def!.function.description).toContain("search_emails");
  });

  it("parses the line items out of the PDF attachments and aggregates them", async () => {
    scanEmails.mockResolvedValue(
      censusWithAttachments([
        {
          uid: 10,
          mailbox: "info@cortoba-supplies.com",
          subject: "EDC PO No P26E14630",
          attachments: pdfAttachments([{ filename: "po.pdf", content: Buffer.from("pdf") }]),
        },
      ]),
    );

    const res = (await executeTool(
      "scan_email_items",
      { from: "egyptian-drilling" },
      ctx as never,
    )) as {
      ok: boolean;
      data: {
        isComplete: boolean;
        matchedMessages: number;
        distinctParts: number;
        totalLines: number;
        topItems: Array<{ partNo: string; qty: number; uom: string }>;
        coverage: { unreadable: number; withItems: number };
      };
    };

    expect(res.ok).toBe(true);
    expect(res.data.matchedMessages).toBe(1);
    // One real line: line 2 of this PO is the ERP's VAT pseudo-line
    // (0600.000.GENRAL.0005 / «VALUE ADDED TAX LOCAL»), which is not stock.
    expect(res.data.totalLines).toBe(1);
    expect(res.data.distinctParts).toBe(1);
    // The single line comes from ONE order, so the frequency ranking excludes it
    // (default minOrders=2). The quantity view still lists it.
    expect(res.data.topItems).toHaveLength(0);
    expect(res.data.isComplete).toBe(true);

    const qty = (await executeTool(
      "scan_email_items",
      { from: "egyptian-drilling", ordering: "qty" },
      ctx as never,
    )) as { data: { topItems: Array<{ partNo: string; qty: number; uom: string }> } };
    expect(qty.data.topItems.map((i) => i.partNo)).toEqual(["0666.000.GENRAL.0006"]);
    expect(qty.data.topItems[0]).toMatchObject({ qty: 12, uom: "Piece" });
  });

  it("reports the resolved sender when the operator used a shorthand", async () => {
    // Live (24/09): «اوامر الشراء الواردة من EDC» — «EDC» is the operator's
    // shorthand, the address is `noreply@egyptian-drilling.com`, and the word
    // only appears in the SUBJECT. The census resolves it and the tool must
    // surface that so the model can say what it actually searched, instead of
    // «لا توجد رسائل من هذا المُرسل».
    scanEmails.mockResolvedValue(
      censusWithAttachments(
        [
          {
            uid: 30,
            mailbox: "info@cortoba-supplies.com",
            subject: "EDC PO No P26E14630",
            attachments: pdfAttachments([{ filename: "po.pdf", content: Buffer.from("pdf") }]),
          },
        ],
        {
          senderResolution: {
            requested: "EDC",
            resolved: "noreply@egyptian-drilling.com",
            matched: 1,
            candidates: [],
          },
        },
      ),
    );

    const res = (await executeTool(
      "scan_email_items",
      { from: "EDC", ordering: "qty" },
      ctx as never,
    )) as { data: { senderResolution: { resolved: string | null; requested: string } } };
    expect(res.data.senderResolution.requested).toBe("EDC");
    expect(res.data.senderResolution.resolved).toBe("noreply@egyptian-drilling.com");
  });

  it("surfaces the printed Line Item numbers per item", async () => {
    // The operator asked for the Line Item column by name. It is not an identity
    // (it differs PO by PO) but it IS printed, so it must reach the report.
    extractPdfText.mockResolvedValue(
      "PO number: P26E14630(RIG58)\nQuantity UOM Part No Line Item\n" +
        "1 5 Each 05-OCT-2026 10.00 50.00\n0666.000.GENRAL.0006\nWIDGET\n",
    );
    const pool = [1, 2].map((uid) => ({
      uid,
      mailbox: "info@cortoba-supplies.com",
      subject: `EDC PO No P26E1463${uid}`,
      attachments: pdfAttachments([{ filename: `po${uid}.pdf`, content: Buffer.from("pdf") }]),
    }));
    scanEmails.mockImplementation(
      async (opts: { attachmentSkip?: number; includeAttachments?: boolean }) =>
        censusWithAttachments(opts.includeAttachments ? pool.slice(opts.attachmentSkip ?? 0) : [], {
          matched: 2,
        }),
    );

    const res = (await executeTool("scan_email_items", { ordering: "qty" }, ctx as never)) as {
      data: { topItems: Array<{ partNo: string; lineItems: number[] }> };
    };
    expect(res.data.topItems[0].partNo).toBe("0666.000.GENRAL.0006");
    expect(res.data.topItems[0].lineItems).toEqual([1]);
  });

  it("asks the census for the WHOLE matched set, not the public 500-row page", async () => {
    // A year of mail must not be analysed from the newest page only — that is
    // how a partial census gets presented as the year's total.
    scanEmails.mockResolvedValue(censusWithAttachments([]));
    await executeTool("scan_email_items", {}, ctx as never);
    expect(scanEmails).toHaveBeenCalledWith(
      expect.objectContaining({ includeAttachments: true, returnAllMatches: true }),
    );
  });

  it("reports a partial census honestly instead of claiming completeness", async () => {
    scanEmails.mockResolvedValue(
      censusWithAttachments(
        [
          {
            uid: 11,
            mailbox: "info@cortoba-supplies.com",
            subject: "EDC PO No P26E14631",
            attachments: pdfAttachments([{ filename: "po.pdf", content: Buffer.from("pdf") }]),
          },
          {
            uid: 12,
            mailbox: "info@cortoba-supplies.com",
            subject: "EDC PO No P26E14632",
            // A scan with no text layer: extractPdfText returns "".
            attachments: pdfAttachments([
              { filename: "scan.pdf", content: Buffer.from("scanned image only") },
            ]),
          },
        ],
        {
          attachmentCoverage: {
            messages: 2,
            scanned: 2,
            readable: 1,
            unreadable: 1,
            attachments: 2,
            truncated: false,
          },
        },
      ),
    );

    const res = (await executeTool("scan_email_items", {}, ctx as never)) as {
      data: { isComplete: boolean; note: string; scope: string; coverage: { unreadable: number } };
    };
    expect(res.data.isComplete).toBe(false);
    expect(res.data.coverage.unreadable).toBe(1);
    // All matched messages WERE opened here; the partial flag comes from one
    // unreadable file, so the scope line is allowed to say "all matched" — the
    // note carries the shortfall. (A capped fetch is covered by the next test.)
    expect(res.data.note).toContain("جزئي");
    expect(res.data.note).toContain("تعذّرت قراءة 1");
    expect(res.data.scope).toContain("كل الرسائل المطابقة");
  });

  it("names the scanned scope honestly when the mailbox outgrew the scan", async () => {
    // The live failure's shape: thousands matched, only a few opened. The scan
    // now RESUMES rather than claiming a sample is the whole — and it must still
    // report exactly how much it covered and how much remains.
    extractPdfText.mockResolvedValue("Quantity UOM Part No Line Item\n1 5 Each X-1 THING\n");
    // `scanEmails` as the resumable tool drives it: the pool is windowed by
    // `attachmentSkip`, so each call opens the next messages instead of the same
    // newest ones. Six available, 3749 matched on the wire.
    const pool = [1, 2, 3, 4, 5, 6].map((uid) => ({
      uid,
      mailbox: "info@cortoba-supplies.com",
      subject: `EDC RFQ ${uid}`,
      attachments: pdfAttachments([{ filename: `a${uid}.pdf`, content: Buffer.from("pdf") }]),
    }));
    scanEmails.mockImplementation(
      async (opts: { attachmentSkip?: number; includeAttachments?: boolean }) =>
        censusWithAttachments(opts.includeAttachments ? pool.slice(opts.attachmentSkip ?? 0) : [], {
          matched: 3749,
        }),
    );

    const res = (await executeTool("scan_email_items", { noAutoJob: true }, ctx as never)) as {
      data: {
        isComplete: boolean;
        scope: string;
        note: string;
        scannedMessages: number;
        remainingMessages: number;
      };
    };
    expect(res.data.isComplete).toBe(false);
    expect(res.data.scannedMessages).toBe(pool.length);
    expect(res.data.remainingMessages).toBe(3749 - pool.length);
    expect(res.data.scope).toContain(`فُتح ${pool.length} من 3749`);
    expect(res.data.note).toContain("ولم تُفحص كل الرسائل");
    // The model is told how to finish, not left to present the sample as a total.
    expect(res.data.note).toContain("أعد نداء scan_email_items");
  });

  it("sends both the full line list and the summary as CSV", async () => {
    scanEmails.mockResolvedValue(
      censusWithAttachments([
        {
          uid: 10,
          mailbox: "info@cortoba-supplies.com",
          subject: "EDC PO No P26E14630",
          attachments: pdfAttachments([{ filename: "po.pdf", content: Buffer.from("pdf") }]),
        },
      ]),
    );

    const res = (await executeTool("scan_email_items", { exportCsv: true }, ctx as never)) as {
      data: { csvSent: boolean };
    };
    expect(res.data.csvSent).toBe(true);
    expect(ctx.outbox).toHaveLength(2);
    // NOT text/csv: WhatsApp's media upload rejects that type (#100) and the
    // file is silently lost. text/plain is accepted and keeps the .csv name.
    expect(ctx.outbox.every((f) => f.mimeType === "text/plain")).toBe(true);
    expect(ctx.outbox.every((f) => f.filename.endsWith(".csv"))).toBe(true);
    const all = ctx.outbox.map((f) => f.buffer.toString("utf8")).join("\n");
    expect(all).toContain("0666.000.GENRAL.0006");
    expect(all).toContain("PADLOCK");
  });

  it("emits a PDF summary when asked for a file", async () => {
    scanEmails.mockResolvedValue(
      censusWithAttachments([
        {
          uid: 10,
          mailbox: "info@cortoba-supplies.com",
          subject: "EDC PO No P26E14630",
          attachments: pdfAttachments([{ filename: "po.pdf", content: Buffer.from("pdf") }]),
        },
      ]),
    );
    const res = (await executeTool("scan_email_items", { exportPdf: true }, ctx as never)) as {
      data: { pdfSent: boolean };
    };
    expect(res.data.pdfSent).toBe(true);
    expect(ctx.outbox).toHaveLength(1);
    expect(ctx.outbox[0].mimeType).toBe("application/pdf");
  });

  it("puts price, order-count and PO numbers in the PDF table", async () => {
    extractPdfText.mockImplementation(async (buf: Buffer) => buf.toString("utf8"));
    scanEmails.mockResolvedValue(
      censusWithAttachments([
        {
          uid: 30,
          mailbox: "info@cortoba-supplies.com",
          subject: "EDC PO No P26E14630",
          attachments: pdfAttachments([{ filename: "po.pdf", content: Buffer.from(PO_TEXT) }]),
        },
        {
          uid: 31,
          mailbox: "info@cortoba-supplies.com",
          subject: "EDC PO No P26E14631",
          attachments: pdfAttachments([
            {
              filename: "po2.pdf",
              content: Buffer.from(PO_TEXT.replace("P26E14630", "P26E14631")),
            },
          ]),
        },
      ]),
    );
    const { generateAssistantPdf } = await import("../../modules/ai-assistant/pdf");
    const pdfMock = generateAssistantPdf as unknown as ReturnType<typeof vi.fn>;
    pdfMock.mockClear();

    await executeTool("scan_email_items", { exportPdf: true }, ctx as never);

    const opts = pdfMock.mock.calls[0][0] as {
      sections: Array<{ paragraphs?: string[]; table?: { columns: string[]; rows: unknown[][] } }>;
    };
    const table = opts.sections.find((s) => s.table)?.table;
    // The operator specified these columns exactly: part number and line item
    // are reported as separate, possibly-absent fields, and a missing value is
    // spelled «غير متوفر» rather than left blank.
    expect(table?.columns).toEqual([
      "الترتيب",
      "وصف البند الكامل",
      "Part Number",
      "Line Item",
      "عدد الأوامر",
      "إجمالي الكمية",
      "الوحدة",
      "متوسط سعر الوحدة",
      "إجمالي القيمة",
      "العملة",
      "أرقام الأوامر",
    ]);
    const padlock = table?.rows.find((r) => r[2] === "0666.000.GENRAL.0006");
    // Seen in two orders, price 75.00 each, and both PO numbers listed.
    expect(padlock?.[4]).toBe(2);
    expect(padlock?.[7]).toBe("75.00");
    expect(padlock?.[10]).toContain("P26E14630");
    expect(padlock?.[10]).toContain("P26E14631");
    // The scope paragraph is present and honest.
    const paragraphs = opts.sections.flatMap((s) => s.paragraphs ?? []).join("\n");
    expect(paragraphs).toContain("النطاق");
  });

  it("does not claim a complete scan when the mailbox outgrew the attachment pass", async () => {
    // The live bug, pinned: the ENVELOPE scan covered every match, but the
    // attachment pass had only read a sample — so an incomplete census must
    // never be reported as complete, and it must say what is left.
    extractPdfText.mockImplementation(async (buf: Buffer) => buf.toString("utf8"));
    const pool = [40, 41, 42].map((uid) => ({
      uid,
      mailbox: "info@cortoba-supplies.com",
      subject: `EDC PO No P26E1463${uid}`,
      attachments: pdfAttachments([{ filename: "po.pdf", content: Buffer.from(PO_TEXT) }]),
    }));
    scanEmails.mockImplementation(
      async (opts: { attachmentSkip?: number; includeAttachments?: boolean }) =>
        censusWithAttachments(opts.includeAttachments ? pool.slice(opts.attachmentSkip ?? 0) : [], {
          matched: 480,
        }),
    );

    const res = (await executeTool("scan_email_items", { noAutoJob: true }, ctx as never)) as {
      data: { isComplete: boolean; scope: string; note: string; remainingMessages: number };
    };
    // Only 3 of 480 opened → not complete, and the shortfall is stated.
    expect(res.data.isComplete).toBe(false);
    expect(res.data.remainingMessages).toBe(477);
    expect(res.data.note).toContain("جزئي");
    expect(res.data.note).not.toContain("الحصر كامل على كل الرسائل المطابقة");
  });

  it("completes the census across calls instead of stopping at one batch", async () => {
    // The core of Phase 3: a mailbox too large for one call is finished over
    // several calls. Each call resumes from the cursor; the LAST call reports a
    // complete census covering every matched message, with no batch lost.
    extractPdfText.mockResolvedValue("Quantity UOM Part No Line Item\n1 5 Each X-1 THING\n");
    process.env.AI_SCAN_CALL_BUDGET_MS = "0";
    process.env.AI_ATTACHMENT_SCAN_BUDGET = "2";
    try {
      const pool = [1, 2, 3, 4, 5].map((uid) => ({
        uid,
        mailbox: "info@cortoba-supplies.com",
        subject: `EDC PO ${uid}`,
        attachments: pdfAttachments([{ filename: `po${uid}.pdf`, content: Buffer.from("pdf") }]),
      }));
      const skips: number[] = [];
      scanEmails.mockImplementation(
        async (opts: { attachmentSkip?: number; includeAttachments?: boolean }) => {
          if (opts.includeAttachments) skips.push(opts.attachmentSkip ?? 0);
          // The envelope pass returns the whole pool; the attachment pass is the
          // window the engine asked for, mirroring the real `fetchMessageAttachments`.
          return censusWithAttachments(
            opts.includeAttachments
              ? pool.slice(opts.attachmentSkip ?? 0, (opts.attachmentSkip ?? 0) + 2)
              : pool,
            { matched: pool.length, returned: pool.length },
          );
        },
      );

      // Three calls: 2 + 2 + 1 messages, then the census is complete.
      const data = [] as Array<{ isComplete: boolean; scannedMessages: number }>;
      for (let i = 0; i < 3; i++) {
        const r = (await executeTool("scan_email_items", {}, ctx as never)) as {
          data: { isComplete: boolean; scannedMessages: number };
        };
        data.push(r.data);
      }

      expect(data[0].isComplete).toBe(false);
      expect(data[1].isComplete).toBe(false);
      expect(data[2].isComplete).toBe(true);
      expect(data[2].scannedMessages).toBe(pool.length);
      // The cursor advanced monotonically — no window was re-read.
      expect(skips).toEqual([0, 2, 4]);
    } finally {
      delete process.env.AI_SCAN_CALL_BUDGET_MS;
      delete process.env.AI_ATTACHMENT_SCAN_BUDGET;
    }
  });

  it("keeps parsed rows when a call is cut mid-batch, and resumes from there", async () => {
    // The live failure distilled: a timeout during the parse must not discard
    // the batch already read. Proven by counting the parse calls and by the
    // resume cursor picking up exactly where the cut happened.
    process.env.AI_SCAN_CALL_BUDGET_MS = "0";
    process.env.AI_ITEM_PARSE_CHUNK = "2";
    process.env.AI_ATTACHMENT_SCAN_BUDGET = "100";
    try {
      const pool = [1, 2, 3, 4, 5, 6].map((uid) => ({
        uid,
        mailbox: "info@cortoba-supplies.com",
        subject: `EDC PO ${uid}`,
        // Unique bytes per message so `extractPdfText` can tag which one it saw.
        attachments: pdfAttachments([
          { filename: `po${uid}.pdf`, content: Buffer.from(`pdf-${uid}`) },
        ]),
      }));
      scanEmails.mockImplementation(
        async (opts: { attachmentSkip?: number; includeAttachments?: boolean }) =>
          censusWithAttachments(
            opts.includeAttachments ? pool.slice(opts.attachmentSkip ?? 0) : [],
            {
              matched: pool.length,
              returned: pool.length,
            },
          ),
      );

      // parseItemsFromAttachments is the real parser; count the messages it sees
      // per call so a lost batch would show as a gap in the cursor sequence.
      const seen: number[] = [];
      extractPdfText.mockImplementation(async (buf: Buffer) => {
        seen.push(Number(buf.toString().replace(/\D/g, "")) || 0);
        return "Quantity UOM Part No Line Item\n1 5 Each X-1 THING\n";
      });

      const first = (await executeTool("scan_email_items", {}, ctx as never)) as {
        data: { isComplete: boolean; scannedMessages: number; remainingMessages: number };
      };
      // One 2-message chunk per call (budget 1ms), so the first call reads 2.
      expect(first.data.isComplete).toBe(false);
      const readFirst = first.data.scannedMessages;
      expect(readFirst).toBeGreaterThan(0);

      const second = (await executeTool("scan_email_items", {}, ctx as never)) as {
        data: { scannedMessages: number };
      };
      // The second call CONTINUED the census rather than restarting it.
      expect(second.data.scannedMessages).toBeGreaterThan(readFirst);
      // Every message was read exactly once across the two calls.
      expect(new Set(seen).size).toBe(seen.length);
    } finally {
      delete process.env.AI_SCAN_CALL_BUDGET_MS;
      delete process.env.AI_ITEM_PARSE_CHUNK;
      delete process.env.AI_ATTACHMENT_SCAN_BUDGET;
    }
  });

  it("refuses when email access is disabled", async () => {
    const off = {
      settings: { allowDatabase: true, allowEmail: false, allowPdf: true },
      outbox: [],
    };
    const res = (await executeTool("scan_email_items", {}, off as never)) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it("ranks by occurrence by default, answering «أكتر بند اتكرر»", async () => {
    // Two messages carry the SAME small part (repeated), one carries a single
    // huge line. Frequency must lead — a quantity-ranked list would put the
    // one-off order first and miss the question being asked.
    extractPdfText.mockImplementation(async (buf: Buffer) => buf.toString("utf8"));
    scanEmails.mockResolvedValue(
      censusWithAttachments([
        {
          uid: 20,
          mailbox: "info@cortoba-supplies.com",
          subject: "EDC RFQ No 26R011900",
          attachments: pdfAttachments([
            {
              filename: "a.pdf",
              content: Buffer.from(
                "Quantity UOM Part No Line Item\n1 1 Each 0101.001.GENRAL.0001 ITEM\n1 SMALL PART 4\n",
              ),
            },
          ]),
        },
        {
          uid: 21,
          mailbox: "info@cortoba-supplies.com",
          subject: "EDC RFQ No 26R011901",
          attachments: pdfAttachments([
            {
              filename: "b.pdf",
              content: Buffer.from(
                "Quantity UOM Part No Line Item\n1 1 Each 0101.001.GENRAL.0001 ITEM\n1 SMALL PART 4\n",
              ),
            },
          ]),
        },
        {
          uid: 22,
          mailbox: "info@cortoba-supplies.com",
          subject: "EDC RFQ No 26R011902",
          attachments: pdfAttachments([
            {
              filename: "c.pdf",
              content: Buffer.from(
                "Quantity UOM Part No Line Item\n1 5000 Each 0101.001.GENRAL.0002 BIG ONCE\n",
              ),
            },
          ]),
        },
      ]),
    );

    const res = (await executeTool("scan_email_items", {}, ctx as never)) as {
      data: {
        ordering: string;
        topItems: Array<{ partNo: string | null; occurrences: number; qty: number }>;
      };
    };

    expect(res.data.ordering).toBe("mostRepeated");
    // The repeated small part outranks the single huge line.
    expect(res.data.topItems[0].partNo).toBe("0101.001.GENRAL.0001");
    expect(res.data.topItems[0].occurrences).toBe(2);
    expect(res.data.topItems[0].qty).toBe(2);
    // The huge one-off is EXCLUDED: the operator's rule is that a part ordered
    // once — however large — is not "most repeated". minOrders=1 brings it back.
    expect(res.data.topItems.find((i) => i.partNo === "0101.001.GENRAL.0002")).toBeUndefined();

    const all = (await executeTool("scan_email_items", { minOrders: 1 }, ctx as never)) as {
      data: { topItems: Array<{ partNo: string | null; occurrences: number; qty: number }> };
    };
    const big = all.data.topItems.find((i) => i.partNo === "0101.001.GENRAL.0002");
    expect(big?.qty).toBe(5000);
    expect(big?.occurrences).toBe(1);
  });

  it("honours ordering=qty for a volume question", async () => {
    extractPdfText.mockImplementation(async (buf: Buffer) => buf.toString("utf8"));
    scanEmails.mockResolvedValue(
      censusWithAttachments([
        {
          uid: 23,
          mailbox: "info@cortoba-supplies.com",
          subject: "EDC RFQ No 26R011903",
          attachments: pdfAttachments([
            {
              filename: "d.pdf",
              content: Buffer.from(
                "Quantity UOM Part No Line Item\n1 1 Each 0101.001.GENRAL.0001 ITEM\n1 SMALL PART 4\n1 5000 Each 0101.001.GENRAL.0002 BIG ONCE\n",
              ),
            },
          ]),
        },
      ]),
    );

    const res = (await executeTool("scan_email_items", { ordering: "qty" }, ctx as never)) as {
      data: { topItems: Array<{ partNo: string | null }> };
    };
    expect(res.data.topItems[0].partNo).toBe("0101.001.GENRAL.0002");
  });

  it("never claims completeness when NO attachment could be opened", async () => {
    // A nothing-found scan is the exact state that produced the misleading
    // report the operator saw; it must be labelled, not presented as a result.
    scanEmails.mockResolvedValue(censusWithAttachments([]));
    const res = (await executeTool(
      "scan_email_items",
      { from: "egyptian-drilling" },
      ctx as never,
    )) as {
      data: { isComplete: boolean; hasAttachments: boolean; note: string };
    };
    expect(res.data.hasAttachments).toBe(false);
    expect(res.data.isComplete).toBe(false);
    expect(res.data.note).toContain("لم أجد أي مرفق");
  });
});

describe("oversize census hands off to a background job", () => {
  beforeEach(() => {
    scanEmails.mockReset();
    extractPdfText.mockReset();
    ctx.outbox.length = 0;
  });

  it("queues a job and returns immediately when too much is left to finish now", async () => {
    // Thousands matched, a handful opened. Rather than tell the operator to keep
    // re-asking (each re-ask spends the day's model quota), the tool queues a
    // job and returns its id — the worker finishes it unattended.
    extractPdfText.mockResolvedValue("Quantity UOM Part No Line Item\n1 5 Each X-1 THING\n");
    const pool = [1, 2, 3].map((uid) => ({
      uid,
      mailbox: "info@cortoba-supplies.com",
      subject: `EDC RFQ ${uid}`,
      attachments: pdfAttachments([{ filename: `a${uid}.pdf`, content: Buffer.from("pdf") }]),
    }));
    scanEmails.mockImplementation(
      async (opts: { attachmentSkip?: number; includeAttachments?: boolean }) =>
        censusWithAttachments(opts.includeAttachments ? pool.slice(opts.attachmentSkip ?? 0) : [], {
          matched: 3749,
        }),
    );

    const res = (await executeTool(
      "scan_email_items",
      { question: "حصر كل بنود السنة" },
      ctx as never,
    )) as { data: { jobId: number; status: string; note: string } };

    // The hand-off returns a job, not a partial item list.
    expect(res.data.jobId).toBeGreaterThan(0);
    expect(res.data.note).toContain("الخلفية");
    expect(res.data.note).toContain("job_status");
  });

  it("does NOT queue a job for a scan that finished", async () => {
    // A completed census must return its rows, not a job — the threshold only
    // applies to work that would otherwise be left unfinished.
    extractPdfText.mockResolvedValue("Quantity UOM Part No Line Item\n1 5 Each X-1 THING\n");
    scanEmails.mockResolvedValue(
      censusWithAttachments([
        {
          uid: 1,
          mailbox: "info@cortoba-supplies.com",
          subject: "EDC RFQ 1",
          attachments: pdfAttachments([{ filename: "a.pdf", content: Buffer.from("pdf") }]),
        },
      ]),
    );
    const res = (await executeTool("scan_email_items", {}, ctx as never)) as {
      data: { jobId?: number; isComplete: boolean; topItems: unknown[] };
    };
    expect(res.data.jobId).toBeUndefined();
    expect(res.data.isComplete).toBe(true);
    expect(Array.isArray(res.data.topItems)).toBe(true);
  });

  it("does NOT queue a job for a `contains` lookup (an answer beats a notice)", async () => {
    // «فين البند ده؟» must be answered from what was read, with its scope, not
    // replaced by a «جاري الحصر» message.
    extractPdfText.mockResolvedValue(
      "Quantity UOM Part No Line Item\n1 5 Each X-1 ARISTON HEATER\n",
    );
    const pool = [1, 2].map((uid) => ({
      uid,
      mailbox: "info@cortoba-supplies.com",
      subject: `EDC RFQ ${uid}`,
      attachments: pdfAttachments([{ filename: `a${uid}.pdf`, content: Buffer.from("pdf") }]),
    }));
    scanEmails.mockImplementation(
      async (opts: { attachmentSkip?: number; includeAttachments?: boolean }) =>
        censusWithAttachments(opts.includeAttachments ? pool.slice(opts.attachmentSkip ?? 0) : [], {
          matched: 3749,
        }),
    );
    const res = (await executeTool("scan_email_items", { contains: "ariston" }, ctx as never)) as {
      data: { jobId?: number; contains?: string; note: string };
    };
    expect(res.data.jobId).toBeUndefined();
    expect(res.data.contains).toBe("ariston");
    // The scope warning still tells the model older mail was not read.
    expect(res.data.note).toContain("لم تُفحص كل الرسائل");
  });

  it("counts PURCHASE ORDERS only — an RFQ is read but excluded", async () => {
    // The operator's rule: a quotation is not an order. EDC sends both from the
    // same address with nearly identical item tables, so counting RFQs would
    // report a part «ordered» on quotes that were never ordered.
    extractPdfText.mockImplementation(async (buf: Buffer) => buf.toString("utf8"));
    const poText = `PO number: P26E14630\nPURCHASE ORDER\nQuantity UOM Part No Line Item\n1 5 Each 0666.000.GENRAL.0006 PADLOCK\n`;
    const rfqText = `RFQ number: 26R011954\nREQUEST FOR QUOTATION\nQuantity UOM Part No Line Item\n1 5 Each 0666.000.GENRAL.0006 PADLOCK\n`;
    const pool = [
      {
        uid: 1,
        mailbox: "info@cortoba-supplies.com",
        subject: "EDC PO",
        attachments: pdfAttachments([{ filename: "po.pdf", content: Buffer.from(poText) }]),
      },
      {
        uid: 2,
        mailbox: "info@cortoba-supplies.com",
        subject: "EDC RFQ",
        attachments: pdfAttachments([{ filename: "rfq.pdf", content: Buffer.from(rfqText) }]),
      },
    ];
    scanEmails.mockImplementation(
      async (opts: { attachmentSkip?: number; includeAttachments?: boolean }) =>
        censusWithAttachments(opts.includeAttachments ? pool.slice(opts.attachmentSkip ?? 0) : [], {
          matched: 2,
          returned: 2,
        }),
    );

    const res = (await executeTool("scan_email_items", { minOrders: 1 }, ctx as never)) as {
      data: {
        poDocuments: number;
        rfqDocumentsExcluded: number;
        isComplete: boolean;
        note: string;
        topItems: Array<{ occurrences: number; partNo: string | null }>;
      };
    };
    expect(res.data.poDocuments).toBe(1);
    expect(res.data.rfqDocumentsExcluded).toBe(1);
    // Only the PO contributed, so the part was seen on ONE order — not two.
    expect(res.data.topItems).toHaveLength(1);
    expect(res.data.topItems[0].occurrences).toBe(1);
    // And the exclusion is stated, not silent.
    expect(res.data.note).toContain("مستبعد");
  });

  it("groups the same item across POs even when one omits the part number", async () => {
    // The operator's exact case, end to end: the same physical item appears with
    // a part number on one PO and by description alone on the next. A
    // part-number-keyed census splits it into two items and under-reports its
    // frequency.
    extractPdfText.mockImplementation(async (buf: Buffer) => buf.toString("utf8"));
    // Part numbers in the format the parser recognises — `A9R41440` is not a
    // part-number shape and would be read as prose, making the assertion vacuous.
    const withCode = `PO number: P26E14630\nPURCHASE ORDER\nQuantity UOM Part No Line Item\n1 5 Each 0666.000.GENRAL.0006 2 INCH BRASS LONG SHACKLE PADLOCK\n`;
    const without = `PO number: P26E14631\nPURCHASE ORDER\nQuantity UOM Part No Line Item\n1 5 Each 2 INCH BRASS LONG SHACKLE PADLOCK\n`;
    const pool = [
      {
        uid: 1,
        mailbox: "info@cortoba-supplies.com",
        subject: "EDC PO 1",
        attachments: pdfAttachments([{ filename: "po1.pdf", content: Buffer.from(withCode) }]),
      },
      {
        uid: 2,
        mailbox: "info@cortoba-supplies.com",
        subject: "EDC PO 2",
        attachments: pdfAttachments([{ filename: "po2.pdf", content: Buffer.from(without) }]),
      },
    ];
    scanEmails.mockImplementation(
      async (opts: { attachmentSkip?: number; includeAttachments?: boolean }) =>
        censusWithAttachments(opts.includeAttachments ? pool.slice(opts.attachmentSkip ?? 0) : [], {
          matched: 2,
          returned: 2,
        }),
    );

    const res = (await executeTool("scan_email_items", {}, ctx as never)) as {
      data: {
        distinctParts: number;
        topItems: Array<{ occurrences: number; partNo: string | null; partNos: string[] }>;
      };
    };
    // ONE item, seen on TWO orders.
    expect(res.data.distinctParts).toBe(1);
    expect(res.data.topItems[0].occurrences).toBe(2);
    expect(res.data.topItems[0].partNo).toBe("0666.000.GENRAL.0006");
  });

  it("hands a 100%-census request to a background job instead of a partial list", async () => {
    // «فحص كامل بنسبة 100%» must not come back as a sample. Even a SMALL
    // remainder is handed off, because a partial ranking is not an answer to
    // that question — the auto-job threshold only applies to an ordinary ask.
    extractPdfText.mockResolvedValue("Quantity UOM Part No Line Item\n1 5 Each X-1 THING\n");
    const pool = [1, 2, 3].map((uid) => ({
      uid,
      mailbox: "info@cortoba-supplies.com",
      subject: `EDC PO ${uid}`,
      attachments: pdfAttachments([{ filename: `po${uid}.pdf`, content: Buffer.from("pdf") }]),
    }));
    scanEmails.mockImplementation(
      async (opts: { attachmentSkip?: number; includeAttachments?: boolean }) =>
        censusWithAttachments(
          opts.includeAttachments ? pool.slice(opts.attachmentSkip ?? 0, 1) : [],
          { matched: 3 },
        ),
    );

    const res = (await executeTool(
      "scan_email_items",
      { question: "اعمل فحص كامل بنسبة 100% لكل أوامر الشراء" },
      ctx as never,
    )) as { data: { jobId?: number; note: string } };
    // A job, not a ranked sample.
    expect(res.data.jobId).toBe(1);
    expect(res.data.note).toContain("الخلفية");
  });
});

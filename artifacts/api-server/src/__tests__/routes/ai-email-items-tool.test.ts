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
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }) },
}));

vi.mock("../../modules/ai-assistant/pdf", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generateAssistantPdf: vi.fn(async () => Buffer.from("%PDF-fake")),
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
const PO_TEXT = `Line
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
    attachments: Array<{ filename: string; mimeType: string | null; content: Buffer | null }>;
  }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    matched: 137,
    returned: 137,
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
    expect(res.data.matchedMessages).toBe(137);
    expect(res.data.totalLines).toBe(2);
    expect(res.data.distinctParts).toBe(2);
    expect(res.data.topItems.map((i) => i.partNo)).toEqual([
      "0666.000.GENRAL.0006",
      "0600.000.GENRAL.0005",
    ]);
    expect(res.data.topItems[0]).toMatchObject({ qty: 12, uom: "Piece" });
    expect(res.data.isComplete).toBe(true);
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
    // The note must say it is partial AND name the scope — a count from a capped
    // or partly-unreadable pass must never be relayed as the whole set.
    expect(res.data.note).toContain("جزئي");
    expect(res.data.note).toContain("تعذّرت قراءة 1");
    expect(res.data.scope).toContain("كل الرسائل المطابقة");
  });

  it("names the scanned scope when the attachment pass was truncated", async () => {
    // The live failure's shape: thousands matched, only the newest scanned. The
    // ranking is a fact about the sample, so the note has to say so.
    extractPdfText.mockResolvedValue("Quantity UOM Part No Line Item\n1 5 Each X-1 THING\n");
    scanEmails.mockResolvedValue({
      matched: 3749,
      truncated: false,
      emails: [],
      attachmentMessages: [
        {
          uid: 1,
          mailbox: "info@cortoba-supplies.com",
          subject: "EDC RFQ",
          attachments: pdfAttachments([{ filename: "a.pdf", content: Buffer.from("pdf") }]),
        },
      ],
      attachmentCoverage: {
        messages: 1,
        scanned: 1,
        readable: 1,
        unreadable: 0,
        attachments: 1,
        truncated: true,
      },
    });

    const res = (await executeTool("scan_email_items", {}, ctx as never)) as {
      data: { isComplete: boolean; scope: string; note: string };
    };
    expect(res.data.isComplete).toBe(false);
    expect(res.data.scope).toContain("أحدث 1 رسالة من 3749");
    expect(res.data.note).toContain("ولم تُفحص كل الرسائل");
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
    // The huge one-off is still present, just not first.
    const big = res.data.topItems.find((i) => i.partNo === "0101.001.GENRAL.0002");
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

/**
 * Reading an attachment that the sender MISLABELLED.
 *
 * Live failure (recorded by the operator): «ادخل الميل وشوف كل الPO وقولي اكتر
 * بند اتكرر». The assistant answered that the item tables were inside PDFs it
 * could not read. It was not a quota problem and not a parser problem — EDC
 * labels its PDF attachments `application/doc`, and the attachment filter
 * accepted only exactly `application/pdf`, so `scan_email_items` opened ZERO
 * files out of a mailbox holding thousands. Measured on live mail: 281 of 305
 * EDC attachments are real PDFs (`%PDF-`) declared `application/doc`.
 *
 * These tests pin the decision to the CONTENT, since that is the only signal a
 * sender cannot corrupt.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";
// A single legacy mailbox, so `withMailbox` resolves without delegation.
process.env.SMTP_HOST = "smtp.gmail.com";
process.env.SMTP_USER = "info@cortoba-supplies.com";
process.env.SMTP_PASS = "app-password";
delete process.env.AI_MAILBOXES;
delete process.env.GOOGLE_ACCOUNT_BASE_64;
delete process.env.GOOGLE_MAIL_SERVICE_ACCOUNT_BASE_64;

/** Raw MIME sources the fake IMAP server will hand back, keyed by uid. */
const sources = new Map<number, Buffer>();

vi.mock("imapflow", () => ({
  ImapFlow: class {
    async connect() {}
    async logout() {}
    async list() {
      return [];
    }
    async getMailboxLock() {
      return { release() {} };
    }
    async *fetch(uids: number[]) {
      for (const uid of uids) {
        const source = sources.get(uid);
        if (source) yield { uid, source };
      }
    }
  },
}));

vi.mock("dns", () => ({
  promises: { resolve4: vi.fn(async () => ["127.0.0.1"]) },
}));

/** A MIME message with exactly one attachment, labelled by `contentType`. */
function mimeWith(contentType: string, filename: string, body: string): Buffer {
  return Buffer.from(
    [
      "From: noreply@egyptian-drilling.com",
      "To: info@cortoba-supplies.com",
      "Subject: EDC RFQ No 26R011978",
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Kindly submit your quotation.",
      "--B",
      `Content-Type: ${contentType}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      body,
      "--B--",
      "",
    ].join("\r\n"),
  );
}

// Real magic bytes, so the content sniff is exercised for real.
const PDF_SOURCE = mimeWith(
  "application/doc",
  "RFQ_26R011978_23092026105738.PDF",
  "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n",
);
const XLSX_SOURCE = mimeWith("application/vnd.ms-excel", "prices.xlsx", "PK\u0003\u0004 not a pdf");

const { isPdfAttachment, isPdfContent, fetchMessageAttachments } =
  await import("../../modules/ai-assistant/email");

const matches = (uid: number) => [
  {
    uid,
    mailbox: "info@cortoba-supplies.com",
    folder: "inbox" as const,
    from: "noreply@egyptian-drilling.com",
    to: "info@cortoba-supplies.com",
    subject: "EDC RFQ No 26R011978",
    date: "2026-09-23T10:00:00Z",
    numbers: [],
  },
];

beforeEach(() => {
  sources.clear();
});

describe("isPdfContent", () => {
  it("accepts real PDF bytes and rejects anything else", () => {
    expect(isPdfContent(Buffer.from("%PDF-1.4\n..."))).toBe(true);
    expect(isPdfContent(Buffer.from("PK\x03\x04 zip"))).toBe(false);
    expect(isPdfContent(Buffer.alloc(0))).toBe(false);
    expect(isPdfContent(null)).toBe(false);
  });
});

describe("isPdfAttachment", () => {
  it("trusts the magic bytes when the declared type is wrong", () => {
    // The exact live case: a PDF declared application/doc.
    expect(
      isPdfAttachment({
        mimeType: "application/doc",
        filename: "RFQ_26R011978.PDF",
        content: Buffer.from("%PDF-1.4\n"),
      }),
    ).toBe(true);
  });

  it("accepts a PDF identified only by its declared type", () => {
    expect(isPdfAttachment({ mimeType: "application/pdf", filename: "x", content: null })).toBe(
      true,
    );
  });

  it("accepts a PDF identified only by its filename extension", () => {
    expect(
      isPdfAttachment({ mimeType: "application/octet-stream", filename: "PO.PDF", content: null }),
    ).toBe(true);
  });

  it("rejects a file with no PDF signal at all", () => {
    // Any ONE positive signal is enough, so the negative case must carry none.
    expect(
      isPdfAttachment({
        mimeType: "application/vnd.ms-excel",
        filename: "sheet.xlsx",
        content: Buffer.from("PK\x03\x04"),
      }),
    ).toBe(false);
  });
});

describe("fetchMessageAttachments", () => {
  it("opens an EDC PDF attachment that is declared application/doc", async () => {
    // The regression: this returned zero attachments before the content sniff,
    // so the item census had nothing to read.
    sources.set(1, PDF_SOURCE);

    const { messages, coverage } = await fetchMessageAttachments(matches(1));

    expect(coverage.attachments).toBe(1);
    expect(coverage.readable).toBe(1);
    expect(messages[0].attachments).toHaveLength(1);
    expect(messages[0].attachments[0].filename).toBe("RFQ_26R011978_23092026105738.PDF");
    expect(messages[0].attachments[0].content?.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("still ignores a genuinely non-PDF attachment", async () => {
    sources.set(2, XLSX_SOURCE);
    const { messages, coverage } = await fetchMessageAttachments(matches(2));
    expect(coverage.attachments).toBe(0);
    expect(coverage.unreadable).toBe(1);
    expect(messages[0].attachments).toHaveLength(0);
  });
});

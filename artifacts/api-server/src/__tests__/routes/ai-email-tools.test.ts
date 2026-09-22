/**
 * The email TOOLS as the model sees them.
 *
 * `multi-mailbox-search.test.ts` covers the search itself; this file covers the
 * layer above it — the argument wiring and the merge that decide what the model
 * actually gets back. The failure modes here are silent ones: results from a
 * second mailbox dropped, a "sent" question answered from the inbox, or the
 * scope note naming the wrong folder, all of which look like a plausible answer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

const searchEmails = vi.fn();
const readEmail = vi.fn();
const readEmailAttachment = vi.fn();

vi.mock("../../modules/ai-assistant/email", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  searchEmails,
  readEmail,
  readEmailAttachment,
  isEmailReadConfigured: () => true,
}));

const { executeTool, toolDefinitions } = await import("../../modules/ai-assistant/tools");

/** A result row as `searchEmails` returns it, one per mailbox. */
function result(mailbox: string, folder: "inbox" | "sent", rows: [number, string, string][]) {
  return {
    emails: rows.map(([uid, subject, date]) => ({
      uid,
      mailbox,
      folder,
      from: "Supplier <s@example.com>",
      to: "us@cortoba-supplies.com",
      subject,
      date,
      snippet: "…",
      hasAttachments: false,
    })),
    scope: { mailbox, folder, sinceDays: 60, scanned: rows.length },
  };
}

const settings = {
  allowDatabase: true,
  allowEmail: true,
  allowPdf: true,
  allowSend: false,
};

const ctx = {
  settings,
  outbox: [] as { filename: string }[],
} as never;

const A = "procurement@cortoba-supplies.com";
const B = "info@cortoba-supplies.com";
const C = "sales@cortoba-supplies.com";

beforeEach(() => {
  process.env.AI_MAILBOXES = `${A},${B},${C}`;
  vi.clearAllMocks();
  searchEmails.mockResolvedValue([]);
});

describe("search_emails", () => {
  it("searches every mailbox when the operator names none", async () => {
    searchEmails.mockResolvedValue([
      result(A, "inbox", [[1, "a", "2026-01-01T00:00:00Z"]]),
      result(B, "inbox", [[2, "b", "2026-01-02T00:00:00Z"]]),
      result(C, "inbox", [[3, "c", "2026-01-03T00:00:00Z"]]),
    ]);

    const res = (await executeTool("search_emails", { query: "x" }, ctx)) as {
      ok: boolean;
      data: { count: number; mailboxesSearched: string[] };
    };

    expect(searchEmails).toHaveBeenCalledWith(
      expect.objectContaining({ mailbox: "*", folder: "inbox" }),
    );
    expect(res.data.count).toBe(3);
    expect(res.data.mailboxesSearched).toEqual([A, B, C]);
  });

  it("merges results newest-first across mailboxes", async () => {
    // Each mailbox returns its own rows already newest-first; the MERGE is what
    // has to re-order them, or the operator sees the oldest answer on top.
    searchEmails.mockResolvedValue([
      result(A, "inbox", [[1, "a-oldest", "2026-01-01T00:00:00Z"]]),
      result(B, "inbox", [[2, "b-newest", "2026-03-01T00:00:00Z"]]),
      result(C, "inbox", [[3, "c-middle", "2026-02-01T00:00:00Z"]]),
    ]);

    const res = (await executeTool("search_emails", { query: "x" }, ctx)) as {
      data: { emails: { subject: string }[] };
    };
    expect(res.data.emails.map((e) => e.subject)).toEqual(["b-newest", "c-middle", "a-oldest"]);
  });

  it("applies the limit AFTER merging, not per mailbox", async () => {
    // With a per-mailbox limit the model would get 3 when it asked for 2.
    searchEmails.mockResolvedValue([
      result(A, "inbox", [
        [1, "a1", "2026-01-01T00:00:00Z"],
        [2, "a2", "2026-01-02T00:00:00Z"],
      ]),
      result(B, "inbox", [
        [3, "b1", "2026-01-03T00:00:00Z"],
        [4, "b2", "2026-01-04T00:00:00Z"],
      ]),
    ]);

    const res = (await executeTool("search_emails", { query: "x", limit: 2 }, ctx)) as {
      data: { count: number; emails: { subject: string }[] };
    };
    expect(res.data.count).toBe(2);
    expect(res.data.emails.map((e) => e.subject)).toEqual(["b2", "b1"]);
  });

  it("honours a named mailbox instead of fanning out", async () => {
    searchEmails.mockResolvedValue([result(C, "inbox", [])]);
    await executeTool("search_emails", { query: "x", mailbox: C }, ctx);
    expect(searchEmails).toHaveBeenCalledWith(expect.objectContaining({ mailbox: C }));
  });

  it("names every mailbox in the scope note, and the inbox folder", async () => {
    searchEmails.mockResolvedValue([
      result(A, "inbox", [[1, "x", "2026-01-01T00:00:00Z"]]),
      result(B, "inbox", []),
    ]);
    const res = (await executeTool("search_emails", { query: "x" }, ctx)) as {
      data: { scopeNote: string };
    };
    expect(res.data.scopeNote).toContain(A);
    expect(res.data.scopeNote).toContain(B);
    expect(res.data.scopeNote).toContain("صندوق الوارد");
  });

  it("tells the model what to try when nothing matched", async () => {
    searchEmails.mockResolvedValue([result(A, "inbox", [])]);
    const res = (await executeTool("search_emails", { query: "x" }, ctx)) as {
      data: { scopeNote: string };
    };
    expect(res.data.scopeNote).toContain("sinceDays");
  });
});

describe("search_sent_emails", () => {
  it("reads the Sent folder, not the inbox", async () => {
    // A "what did we send?" question answered from the inbox is a wrong answer
    // that still looks plausible.
    searchEmails.mockResolvedValue([result(A, "sent", [[9, "Re: PO", "2026-04-01T00:00:00Z"]])]);

    const res = (await executeTool("search_sent_emails", { query: "PO" }, ctx)) as {
      data: { emails: { folder: string }[]; scopeNote: string };
    };

    expect(searchEmails).toHaveBeenCalledWith(expect.objectContaining({ folder: "sent" }));
    expect(res.data.emails[0].folder).toBe("sent");
    expect(res.data.scopeNote).toContain("المرسل");
  });

  it("is a distinct tool the model can choose", () => {
    const names = toolDefinitions(ctx).map((d) => d.function.name);
    expect(names).toContain("search_sent_emails");
    expect(names).toContain("list_mailboxes");
  });
});

describe("read_email and attachments carry the location", () => {
  it("forwards mailbox and folder to readEmail", async () => {
    readEmail.mockResolvedValue({ uid: 5 });
    await executeTool("read_email", { uid: 5, mailbox: B, folder: "sent" }, ctx);
    expect(readEmail).toHaveBeenCalledWith(5, B, "sent");
  });

  it("defaults to inbox when the folder is not given", async () => {
    readEmail.mockResolvedValue({ uid: 5 });
    await executeTool("read_email", { uid: 5, mailbox: B }, ctx);
    expect(readEmail).toHaveBeenCalledWith(5, B, "inbox");
  });

  it("forwards mailbox and folder to the attachment reader", async () => {
    readEmailAttachment.mockResolvedValue({
      filename: "po.pdf",
      mimeType: "application/pdf",
      content: Buffer.from("x"),
      size: 1,
      oversized: false,
    });
    // A PDF is queued for WhatsApp and NOT handed to the model as text.
    const outbox: { filename: string }[] = [];
    const scoped = { settings, outbox } as never;
    await executeTool("get_email_attachment", { uid: 5, mailbox: C, folder: "sent" }, scoped);
    expect(readEmailAttachment).toHaveBeenCalledWith(5, expect.anything(), C, "sent");
    expect(outbox.map((f) => f.filename)).toEqual(["po.pdf"]);
  });

  it("returns a text-like attachment's contents instead of only queueing it", async () => {
    readEmailAttachment.mockResolvedValue({
      filename: "notes.csv",
      mimeType: "text/csv",
      content: Buffer.from("a,b\n1,2"),
      size: 7,
      oversized: false,
    });
    const outbox: { filename: string }[] = [];
    const res = (await executeTool("get_email_attachment", { uid: 5 }, {
      settings,
      outbox,
    } as never)) as { data: { content?: string } };
    expect(res.data.content).toContain("a,b");
  });

  it("refuses an oversized attachment instead of sending nothing", async () => {
    readEmailAttachment.mockResolvedValue({
      filename: "big.zip",
      mimeType: "application/zip",
      content: null,
      size: 99_000_000,
      oversized: true,
    });
    const outbox: { filename: string }[] = [];
    const res = (await executeTool("get_email_attachment", { uid: 5 }, {
      settings,
      outbox,
    } as never)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("big.zip");
    expect(outbox).toHaveLength(0);
  });

  it("rejects a non-integer uid rather than reading UID NaN", async () => {
    const res = (await executeTool("read_email", { uid: "abc" }, ctx)) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(readEmail).not.toHaveBeenCalled();
  });
});

describe("list_mailboxes", () => {
  it("lists the configured mailboxes and the default", async () => {
    const res = (await executeTool("list_mailboxes", {}, ctx)) as {
      data: { mailboxes: { email: string }[]; default: string | null };
    };
    expect(res.data.mailboxes.map((m) => m.email)).toEqual([A, B, C]);
    expect(res.data.default).toBe(A);
  });
});

describe("gating", () => {
  it("hides the read tools when email reading is not configured", async () => {
    vi.resetModules();
    vi.doMock("../../modules/ai-assistant/email", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      isEmailReadConfigured: () => false,
    }));
    const fresh = await import("../../modules/ai-assistant/tools");
    const names = fresh.toolDefinitions(ctx).map((d) => d.function.name);
    expect(names).not.toContain("search_emails");
    expect(names).not.toContain("search_sent_emails");
    expect(names).not.toContain("list_mailboxes");
    expect(names).not.toContain("read_email");
    vi.doUnmock("../../modules/ai-assistant/email");
    vi.resetModules();
  });
});

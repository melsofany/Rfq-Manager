import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Attachment handling: choosing which attachment to fetch, the size ceiling, and
 * the get_email_attachment tool that turns an email attachment into an outbox
 * file for WhatsApp.
 */

// ── The IMAP client is faked: fetchOne returns a raw MIME message that
//    mailparser (real) parses, so the parsing path is exercised for real. ─────
const fetchOne = vi.fn();

vi.mock("imapflow", () => ({
  ImapFlow: class {
    getMailboxLock() {
      return Promise.resolve({ release() {} });
    }
    connect() {
      return Promise.resolve();
    }
    logout() {
      return Promise.resolve();
    }
    fetchOne(...args: any[]) {
      return fetchOne(...args);
    }
  },
}));

// Keep DNS out of the test: resolveIpv4 would otherwise hit the network.
vi.mock("dns", () => ({
  promises: { resolve4: vi.fn(async () => ["127.0.0.1"]) },
}));

const warn = vi.fn();
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: (...a: any[]) => warn(...a), error: vi.fn() },
}));

const ENV_KEYS = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "IMAP_HOST", "IMAP_PORT"] as const;

/** A minimal MIME message with one PDF attachment. */
function mimeWithPdf(sizeHintBytes = 32): Buffer {
  const b64 = Buffer.alloc(sizeHintBytes, "A").toString("base64");
  return Buffer.from(
    [
      "From: supplier@example.com",
      "To: info@cortoba-supplies.com",
      "Subject: امر توريد PO-2026-000123",
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "مرفق أمر التوريد.",
      "--B",
      'Content-Type: application/pdf; name="PO-2026-000123.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="PO-2026-000123.pdf"',
      "",
      b64,
      "--B--",
      "",
    ].join("\r\n"),
  );
}

/** A message with a CSV attachment (text-like ⇒ content is returned inline). */
function mimeWithCsv(): Buffer {
  return Buffer.from(
    [
      "From: a@b.com",
      "Subject: تقرير",
      'Content-Type: multipart/mixed; boundary="C"',
      "",
      "--C",
      "Content-Type: text/plain",
      "",
      "تقرير مرفق.",
      "--C",
      'Content-Type: text/csv; name="data.csv"',
      'Content-Disposition: attachment; filename="data.csv"',
      "",
      "part,qty",
      "A,5",
      "--C--",
      "",
    ].join("\r\n"),
  );
}

function configure() {
  process.env.SMTP_HOST = "smtp.gmail.com";
  process.env.SMTP_USER = "info@cortoba-supplies.com";
  process.env.SMTP_PASS = "app-password";
}

describe("email attachments", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    vi.clearAllMocks();
    configure();
    fetchOne.mockReset();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("selects an attachment by filename substring, case-insensitively", async () => {
    const { selectAttachment } = await import("../../modules/ai-assistant/email");
    const atts = [
      { index: 0, filename: "Cover.docx", mimeType: "application/msword", size: 1 },
      { index: 1, filename: "PO-2026-000123.pdf", mimeType: "application/pdf", size: 2 },
    ];
    expect(selectAttachment(atts, { filename: "po-2026" }).filename).toBe("PO-2026-000123.pdf");
    expect(selectAttachment(atts, { filename: "cover" }).filename).toBe("Cover.docx");
  });

  it("falls back to the index and defaults to the first attachment", async () => {
    const { selectAttachment } = await import("../../modules/ai-assistant/email");
    const atts = [
      { index: 0, filename: "a.pdf", mimeType: "application/pdf", size: 1 },
      { index: 1, filename: "b.pdf", mimeType: "application/pdf", size: 1 },
    ];
    expect(selectAttachment(atts, {}).filename).toBe("a.pdf");
    expect(selectAttachment(atts, { index: 1 }).filename).toBe("b.pdf");
    // An unknown filename does not throw — it falls back to the index.
    expect(selectAttachment(atts, { filename: "nope" }).filename).toBe("a.pdf");
  });

  it("reports clearly when there are no attachments or the index is out of range", async () => {
    const { selectAttachment } = await import("../../modules/ai-assistant/email");
    expect(() => selectAttachment([], {})).toThrow(/لا توجد مرفقات/);
    const atts = [{ index: 0, filename: "a.pdf", mimeType: "application/pdf", size: 1 }];
    expect(() => selectAttachment(atts, { index: 3 })).toThrow(/لا يوجد مرفق بالرقم 3/);
  });

  it("classifies text-like mime types", async () => {
    const { isTextLikeMime } = await import("../../modules/ai-assistant/email");
    expect(isTextLikeMime("text/csv")).toBe(true);
    expect(isTextLikeMime("application/json")).toBe(true);
    expect(isTextLikeMime("application/pdf")).toBe(false);
    expect(isTextLikeMime("image/png")).toBe(false);
    expect(isTextLikeMime(null)).toBe(false);
  });

  it("downloads a real attachment's bytes and lists its index", async () => {
    fetchOne.mockResolvedValue({ uid: 77, source: mimeWithPdf(64) });
    const { readEmail, readEmailAttachment } = await import("../../modules/ai-assistant/email");

    const detail = await readEmail(77);
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0].index).toBe(0);
    expect(detail.attachments[0].filename).toBe("PO-2026-000123.pdf");
    expect(detail.attachments[0].mimeType).toBe("application/pdf");

    const att = await readEmailAttachment(77, { filename: "PO" });
    expect(att.filename).toBe("PO-2026-000123.pdf");
    expect(att.oversized).toBe(false);
    expect(att.content).toBeInstanceOf(Buffer);
    expect(att.content!.length).toBeGreaterThan(0);
  });

  it("refuses to download an attachment over the size ceiling", async () => {
    // Lower the ceiling instead of allocating 25MB in a unit test. The module
    // reads it at import time, so set it before the dynamic import.
    process.env.AI_MAX_ATTACHMENT_BYTES = "16";
    vi.resetModules();
    fetchOne.mockResolvedValue({ uid: 5, source: mimeWithPdf(256) });

    const mod = await import("../../modules/ai-assistant/email");
    expect(mod.MAX_ATTACHMENT_BYTES).toBe(16);

    const att = await mod.readEmailAttachment(5);
    expect(att.oversized).toBe(true);
    expect(att.content).toBeNull();

    delete process.env.AI_MAX_ATTACHMENT_BYTES;
    vi.resetModules();
  });
});

// ── Tool-level: get_email_attachment queues the file for WhatsApp ────────────
vi.mock("@workspace/db", () => ({
  db: {},
  purchaseOrdersTable: {},
  purchaseOrderItemsTable: {},
  poItemReceiptsTable: {},
  customerPosTable: {},
  customerPoItemsTable: {},
  customerPoItemDeliveriesTable: {},
  customerPoCollectionsTable: {},
  customerPoPaymentsTable: {},
  rfqTable: {},
  rfqItemsTable: {},
  offersTable: {},
  offerItemsTable: {},
  customerRfqsTable: {},
  customerRfqItemsTable: {},
  salesInvoicesTable: {},
  supplierInvoicesTable: {},
  suppliersTable: {},
}));

vi.mock("../../modules/ai-assistant/db-tools", () => ({
  TABLES: {},
  queryRecords: vi.fn(async () => []),
  countRecords: vi.fn(async () => 0),
  systemSnapshot: vi.fn(async () => ({})),
  findWhere: vi.fn(async () => []),
  tableListForPrompt: () => "",
}));

vi.mock("../../modules/ai-assistant/pdf", () => ({
  generateAssistantPdf: vi.fn(async () => Buffer.from("pdf")),
}));

const settings = {
  enabled: true,
  model: "m",
  baseUrl: null,
  systemPrompt: null,
  language: "ar",
  allowEmail: true,
  allowDatabase: true,
  allowPdf: true,
};

describe("get_email_attachment tool", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    vi.clearAllMocks();
    configure();
    fetchOne.mockReset();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("is offered to the model only when the mailbox is readable", async () => {
    const { toolDefinitions } = await import("../../modules/ai-assistant/tools");
    const ctx = { settings, phone: "2010", outbox: [] } as any;

    const withMail = toolDefinitions(ctx).map((d) => d.function.name);
    expect(withMail).toContain("get_email_attachment");
    expect(withMail).toContain("read_email");

    delete process.env.SMTP_USER;
    const withoutMail = toolDefinitions(ctx).map((d) => d.function.name);
    expect(withoutMail).not.toContain("get_email_attachment");
    expect(withoutMail).not.toContain("read_email");
  });

  it("queues the attachment for WhatsApp and reports metadata", async () => {
    fetchOne.mockResolvedValue({ uid: 77, source: mimeWithPdf(64) });
    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const ctx = { settings, phone: "2010", outbox: [] as any[] } as any;

    const res = await executeTool("get_email_attachment", { uid: 77 }, ctx);
    expect(res.ok).toBe(true);
    expect(ctx.outbox).toHaveLength(1);
    expect(ctx.outbox[0].filename).toBe("PO-2026-000123.pdf");
    expect(ctx.outbox[0].mimeType).toBe("application/pdf");
    expect(ctx.outbox[0].buffer.length).toBeGreaterThan(0);
  });

  it("returns text-like attachments inline so the model can quote them", async () => {
    fetchOne.mockResolvedValue({ uid: 9, source: mimeWithCsv() });
    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const ctx = { settings, phone: "2010", outbox: [] as any[] } as any;

    const res = await executeTool("get_email_attachment", { uid: 9 }, ctx);
    expect(res.ok).toBe(true);
    expect((res.data as any).content).toContain("part,qty");
    expect(ctx.outbox).toHaveLength(1);
  });

  it("rejects a non-integer uid and a disabled email setting", async () => {
    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const ctx = { settings, phone: "2010", outbox: [] as any[] } as any;

    const bad = await executeTool("get_email_attachment", { uid: "x" }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/uid/);

    const off = await executeTool(
      "get_email_attachment",
      { uid: 1 },
      { ...ctx, settings: { ...settings, allowEmail: false } },
    );
    expect(off.ok).toBe(false);
  });

  it("logs an unknown tool call instead of silently swallowing it", async () => {
    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const ctx = { settings, phone: "2010", outbox: [] as any[] } as any;

    // This is the exact hallucinated name the live model produced.
    const res = await executeTool("get_email_attachments", { uid: 1 }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Unknown tool");
    expect(warn).toHaveBeenCalledWith(
      { tool: "get_email_attachments" },
      "AI assistant: model called an unknown tool",
    );
  });
});

/**
 * The From/Reply-To headers that actually reach nodemailer.
 *
 * `mail-identity.test.ts` pins the header strings; this file pins the wiring —
 * that all three senders PASS those values to `sendMail` and none of them
 * still hardcodes its own sender. nodemailer is faked (no network), which is
 * the only way to inspect the arguments without sending real mail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

const sendMail = vi.fn().mockResolvedValue({ messageId: "test" });
const closeTransport = vi.fn();
const createTransport = vi.fn(() => ({ sendMail, close: closeTransport }));

vi.mock("nodemailer", () => ({
  default: { createTransport: (...a: unknown[]) => createTransport(...(a as [])) },
}));
vi.mock("dns", () => ({
  promises: { resolve4: vi.fn().mockResolvedValue(["127.0.0.1"]) },
}));

const { sendPoEmail, sendRfqEmail } = await import("../../shared/email");

const SENT_FROM = "procurement@cortoba-supplies.com";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SMTP_USER = SENT_FROM;
  process.env.SMTP_PASS = "secret";
  process.env.SMTP_HOST = "smtp.gmail.com";
  process.env.SMTP_PORT = "587";
  delete process.env.SMTP_FROM_EMAIL;
  delete process.env.SMTP_FROM_NAME;
  delete process.env.SMTP_REPLY_TO_EMAIL;
  delete process.env.MAIL_READONLY;
  // Read-side settings must not leak into the From header.
  process.env.IMAP_USER = "sales@cortoba-supplies.com";
});

const poArgs = {
  to: "supplier@example.com",
  toName: "Supplier",
  poNo: "P26E11407",
  employeeName: "Ahmed",
  items: [{ description: "Bolt", qty: 5 }],
  pdfBuffer: Buffer.from("pdf"),
};

const rfqArgs = {
  to: "supplier@example.com",
  toName: "Supplier",
  rfqNo: "RFQ-1",
  items: [{ description: "Bolt", qty: "5" }],
  pricingUrl: "https://example.com/pricing",
  closeDate: "2026-01-01",
  employeeName: "Ahmed",
};

describe("outbound From header is identical across senders", () => {
  it("sends the PO from the configured identity", async () => {
    await sendPoEmail(poArgs as never);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.from).toBe(`"Cortoba Supplies قرطبة للتوريدات" <${SENT_FROM}>`);
  });

  it("sends the RFQ from the configured identity", async () => {
    await sendRfqEmail(rfqArgs as never);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.from).toBe(`"Cortoba Supplies قرطبة للتوريدات" <${SENT_FROM}>`);
  });

  it("points Reply-To at the monitored inbox, not the employee name", async () => {
    // The old code set replyTo to `"<employee>" <senderEmail>`; the employee is
    // not a mailbox, so replies were addressed to a non-existent person.
    await sendPoEmail(poArgs as never);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.replyTo).toBe(`"Cortoba Supplies قرطبة للتوريدات" <${SENT_FROM}>`);
    expect(mail.replyTo).not.toContain("Ahmed");
  });
});

describe("MAIL_READONLY stops every sender", () => {
  it("refuses the PO and the RFQ", async () => {
    process.env.MAIL_READONLY = "true";

    await expect(sendPoEmail(poArgs as never)).rejects.toThrow(/للقراءة فقط/);
    await expect(sendRfqEmail(rfqArgs as never)).rejects.toThrow(/للقراءة فقط/);
    // Nothing reached the transport at all.
    expect(sendMail).not.toHaveBeenCalled();
  });
});

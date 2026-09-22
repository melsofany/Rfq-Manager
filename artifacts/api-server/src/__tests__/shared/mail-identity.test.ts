/**
 * One outbound identity.
 *
 * The reported problem: the sender of supplier mail was not stable — replies
 * and RFQ/PO messages could leave from a different address depending on which
 * mailbox happened to be configured. On a Google Workspace domain
 * (cortoba-supplies.com: MX aspmx.l.google.com, SPF _spf.google.com, DKIM
 * google._domainkey) an unaligned From breaks DKIM and directs replies to a
 * mailbox nobody monitors.
 *
 * The fix is structural: EVERY sender resolves From/Reply-To from
 * `senderIdentity()`, which reads only SMTP_FROM_EMAIL/SMTP_USER and knows
 * nothing about the read-side mailbox list. These tests pin that separation —
 * adding or removing a read mailbox must not move the From header.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  senderIdentity,
  fromHeader,
  replyToHeader,
  assertCanSend,
  isMailReadOnly,
  MailReadOnlyError,
} from "../../shared/mail-identity";

const KEYS = [
  "SMTP_USER",
  "SMTP_FROM_EMAIL",
  "SMTP_FROM_NAME",
  "SMTP_REPLY_TO_EMAIL",
  "SMTP_REPLY_TO_NAME",
  "MAIL_READONLY",
  // Read-side variables — must never influence the sender.
  "IMAP_USER",
  "IMAP_HOST",
  "IMAP_PASS",
  "AI_MAILBOXES",
  "AI_MAILBOX_USER",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("senderIdentity", () => {
  it("prefers SMTP_FROM_EMAIL and falls back to SMTP_USER", () => {
    process.env.SMTP_USER = "procurement@cortoba-supplies.com";
    expect(senderIdentity().email).toBe("procurement@cortoba-supplies.com");

    process.env.SMTP_FROM_EMAIL = "sales@cortoba-supplies.com";
    expect(senderIdentity().email).toBe("sales@cortoba-supplies.com");
  });

  it("defaults Reply-To to the From address, keeping replies monitored", () => {
    process.env.SMTP_USER = "procurement@cortoba-supplies.com";
    const id = senderIdentity();
    expect(id.replyTo).toBe("procurement@cortoba-supplies.com");
  });

  it("honours an explicit Reply-To", () => {
    process.env.SMTP_USER = "procurement@cortoba-supplies.com";
    process.env.SMTP_REPLY_TO_EMAIL = "info@cortoba-supplies.com";
    process.env.SMTP_REPLY_TO_NAME = "Cortoba Info";
    const hdr = replyToHeader();
    expect(hdr).toBe('"Cortoba Info" <info@cortoba-supplies.com>');
  });

  it("ignores the read-side mailbox configuration entirely", () => {
    process.env.SMTP_USER = "procurement@cortoba-supplies.com";
    const before = { ...senderIdentity(), from: fromHeader(), replyTo: replyToHeader() };

    // Simulate the upcoming multi-mailbox read feature.
    process.env.IMAP_USER = "sales@cortoba-supplies.com";
    process.env.IMAP_HOST = "imap.gmail.com";
    process.env.AI_MAILBOXES = "sales@cortoba-supplies.com,info@cortoba-supplies.com";
    process.env.AI_MAILBOX_USER = "info@cortoba-supplies.com";

    const after = { ...senderIdentity(), from: fromHeader(), replyTo: replyToHeader() };
    expect(after).toEqual(before);
  });
});

describe("fromHeader / replyToHeader", () => {
  it("quotes the display name so the Arabic name parses correctly", () => {
    process.env.SMTP_USER = "procurement@cortoba-supplies.com";
    const hdr = fromHeader();
    expect(hdr).toContain("قرطبة للتوريدات");
    expect(hdr).toBe('"Cortoba Supplies قرطبة للتوريدات" <procurement@cortoba-supplies.com>');
  });

  it("never emits a raw quote from a name that contains one", () => {
    process.env.SMTP_USER = "procurement@cortoba-supplies.com";
    process.env.SMTP_FROM_NAME = 'Bad "Name"';
    expect(fromHeader()).toBe("\"Bad 'Name'\" <procurement@cortoba-supplies.com>");
  });

  it("returns no Reply-To when there is no address at all", () => {
    expect(replyToHeader()).toBeUndefined();
    expect(fromHeader()).toBe("");
  });
});

describe("MAIL_READONLY", () => {
  it("is off by default so production keeps sending", () => {
    expect(isMailReadOnly()).toBe(false);
    expect(() => assertCanSend()).not.toThrow();
  });

  it("refuses to send when explicitly enabled", () => {
    process.env.MAIL_READONLY = "true";
    expect(isMailReadOnly()).toBe(true);
    expect(() => assertCanSend()).toThrow(MailReadOnlyError);
    expect(() => assertCanSend()).toThrow(/للقراءة فقط/);
  });

  it("treats any other value as writable", () => {
    process.env.MAIL_READONLY = "false";
    expect(() => assertCanSend()).not.toThrow();
    process.env.MAIL_READONLY = "1";
    expect(() => assertCanSend()).not.toThrow();
  });
});

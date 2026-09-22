/**
 * Multi-mailbox READ configuration.
 *
 * The requirement: the assistant must read all three company mailboxes, while
 * outbound mail keeps ONE fixed sender. These tests cover the resolution rules
 * (which mailbox does a phrase refer to?) and, critically, that nothing here
 * can influence the From header — that is asserted in `mail-identity.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  mailboxes,
  defaultMailbox,
  resolveMailbox,
  isMultiMailbox,
  mailboxListForDisplay,
  clearMailboxCache,
} from "../../modules/ai-assistant/mailboxes";

const KEYS = ["AI_MAILBOXES", "IMAP_USER", "SMTP_USER"];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  clearMailboxCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  clearMailboxCache();
  vi.restoreAllMocks();
});

describe("mailboxes", () => {
  it("reads an explicit list, trimmed and lowercased", () => {
    process.env.AI_MAILBOXES = " Procurement@Cortoba-Supplies.com , info@cortoba-supplies.com ";
    clearMailboxCache();
    expect(mailboxes().map((m) => m.email)).toEqual([
      "procurement@cortoba-supplies.com",
      "info@cortoba-supplies.com",
    ]);
  });

  it("marks the FIRST mailbox as the default", () => {
    process.env.AI_MAILBOXES = "procurement@x.com,info@x.com,sales@x.com";
    clearMailboxCache();
    expect(defaultMailbox()?.email).toBe("procurement@x.com");
    expect(mailboxes().filter((m) => m.isDefault)).toHaveLength(1);
  });

  it("takes an Arabic label after a pipe", () => {
    process.env.AI_MAILBOXES = "info@x.com|العام,procurement@x.com|المشتريات";
    clearMailboxCache();
    expect(mailboxes()[0].label).toBe("العام");
    // Without a label, the local part is the label.
    process.env.AI_MAILBOXES = "procurement@x.com";
    clearMailboxCache();
    expect(mailboxes()[0].label).toBe("procurement");
  });

  it("deduplicates a repeated address", () => {
    process.env.AI_MAILBOXES = "info@x.com,INFO@x.com,info@x.com";
    clearMailboxCache();
    expect(mailboxes()).toHaveLength(1);
  });

  it("ignores entries that are not addresses", () => {
    process.env.AI_MAILBOXES = "not-an-address,info@x.com,,";
    clearMailboxCache();
    expect(mailboxes().map((m) => m.email)).toEqual(["info@x.com"]);
  });

  it("falls back to the single legacy account", () => {
    process.env.IMAP_USER = "Sales@x.com";
    clearMailboxCache();
    expect(mailboxes().map((m) => m.email)).toEqual(["sales@x.com"]);
    expect(isMultiMailbox()).toBe(false);
  });

  it("prefers SMTP_USER over nothing when IMAP_USER is unset", () => {
    process.env.SMTP_USER = "procurement@x.com";
    clearMailboxCache();
    expect(defaultMailbox()?.email).toBe("procurement@x.com");
  });

  it("falls back to the legacy account when the list is unusable", () => {
    process.env.AI_MAILBOXES = " , ,";
    process.env.IMAP_USER = "info@x.com";
    clearMailboxCache();
    expect(mailboxes().map((m) => m.email)).toEqual(["info@x.com"]);
  });

  it("is empty when nothing at all is configured", () => {
    clearMailboxCache();
    expect(mailboxes()).toEqual([]);
    expect(defaultMailbox()).toBeUndefined();
    expect(mailboxListForDisplay()).toBe("");
  });

  it("reports multi-mailbox mode for three inboxes", () => {
    process.env.AI_MAILBOXES = "a@x.com,b@x.com,c@x.com";
    clearMailboxCache();
    expect(isMultiMailbox()).toBe(true);
    expect(mailboxes()).toHaveLength(3);
  });
});

describe("resolveMailbox", () => {
  beforeEach(() => {
    process.env.AI_MAILBOXES =
      "procurement@cortoba-supplies.com|المشتريات,info@cortoba-supplies.com|العام,sales@cortoba-supplies.com";
    clearMailboxCache();
  });

  it("returns the default when nothing is named", () => {
    expect(resolveMailbox(undefined)?.email).toBe("procurement@cortoba-supplies.com");
    expect(resolveMailbox("")?.email).toBe("procurement@cortoba-supplies.com");
  });

  it("resolves a full address", () => {
    expect(resolveMailbox("info@cortoba-supplies.com")?.email).toBe("info@cortoba-supplies.com");
  });

  it("resolves a bare local part, as people actually type it", () => {
    expect(resolveMailbox("sales@")?.email).toBe("sales@cortoba-supplies.com");
    expect(resolveMailbox("sales")?.email).toBe("sales@cortoba-supplies.com");
  });

  it("resolves the Arabic label", () => {
    expect(resolveMailbox("العام")?.email).toBe("info@cortoba-supplies.com");
    expect(resolveMailbox("المشتريات")?.email).toBe("procurement@cortoba-supplies.com");
  });

  it("returns undefined for an unknown mailbox, so the caller can list options", () => {
    expect(resolveMailbox("unknown@elsewhere.com")).toBeUndefined();
  });
});

describe("mailboxListForDisplay", () => {
  it("shows the address, plus the label when it adds information", () => {
    process.env.AI_MAILBOXES = "info@x.com|العام,procurement@x.com";
    clearMailboxCache();
    expect(mailboxListForDisplay()).toBe("info@x.com (العام), procurement@x.com");
  });
});

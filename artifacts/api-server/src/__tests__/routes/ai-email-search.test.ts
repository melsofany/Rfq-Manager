/**
 * Email search matching.
 *
 * Live failure (2/10): the operator asked for mail about a customer PO and the
 * agent reported «لا توجد رسائل من EDC» — the messages were in the mailbox.
 *
 * Root cause: `searchEmails` delegated matching to the IMAP server with
 * `search.or = [{subject}, {body}]`. BODY full-text search is unimplemented or
 * unreliable on many servers, it never matches the From DISPLAY NAME, and the
 * Arabic terms were mangled by charset handling. Matching now happens
 * client-side over the recent window, and the search scope is reported back.
 */
import { describe, it, expect } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

const { normalizeText, matchEmailFields, selectAttachment, isTextLikeMime, deriveImapHost } =
  await import("../../modules/ai-assistant/email");

describe("matchEmailFields (the search decision)", () => {
  it("matches a sender DISPLAY NAME, not just the address", () => {
    // The server-side IMAP search never does this — the live reason "رسائل من
    // EDC" came back empty.
    const haystack = "EDC - Egyptian Drilling Company <purchasing@edc.com.eg> PO-2026-000033";
    expect(matchEmailFields({ haystack, needle: "EDC" })).toBe(true);
    expect(matchEmailFields({ haystack, needle: "Egyptian Drilling" })).toBe(true);
    expect(matchEmailFields({ haystack, needle: "edc@nowhere.com" })).toBe(false);
  });

  it("matches Arabic regardless of hamza/taa spelling", () => {
    const haystack = "شركة الحفر المصرية — أمر شراء";
    expect(matchEmailFields({ haystack, needle: "شركه الحفر المصريه" })).toBe(true);
    expect(matchEmailFields({ haystack, needle: "شركة الحفر" })).toBe(true);
  });

  it("requires ALL tokens, not just one", () => {
    const haystack = "EDC purchasing PO-2026-000033";
    expect(matchEmailFields({ haystack, needle: "EDC PO-2026-000033" })).toBe(true);
    expect(matchEmailFields({ haystack, needle: "EDC PO-9999" })).toBe(false);
  });

  it("returns false for an empty needle rather than matching everything", () => {
    expect(matchEmailFields({ haystack: "anything", needle: "   " })).toBe(false);
  });

  it("matches body text when it is included in the haystack", () => {
    const haystack = "Re: your request ... please find attached PO-2026-000033 for review";
    expect(matchEmailFields({ haystack, needle: "PO-2026-000033" })).toBe(true);
  });
});

describe("normalizeText (Arabic-tolerant matching)", () => {
  it("ignores hamza/alef variants", () => {
    expect(normalizeText("أحمد")).toBe(normalizeText("احمد"));
    expect(normalizeText("إبراهيم")).toBe(normalizeText("ابراهيم"));
    expect(normalizeText("آمنة")).toBe(normalizeText("امنه"));
  });

  it("unifies taa marbuta and yaa", () => {
    expect(normalizeText("شركة")).toBe(normalizeText("شركه"));
    expect(normalizeText("مصرية")).toBe(normalizeText("مصريه"));
    expect(normalizeText("مصطفى")).toBe(normalizeText("مصطفي"));
  });

  it("strips harakat and tatweel", () => {
    expect(normalizeText("مُحَمَّد")).toBe(normalizeText("محمد"));
    expect(normalizeText("مـحـمـد")).toBe(normalizeText("محمد"));
  });

  it("is case-insensitive and drops punctuation", () => {
    expect(normalizeText("EDC - Company (Ltd.)")).toBe(normalizeText("edc company ltd"));
  });

  it("keeps numbers intact for PO references", () => {
    expect(normalizeText("PO-2026-000033")).toContain("2026");
    expect(normalizeText("P26E13477")).toBe("p26e13477");
  });
});

describe("isTextLikeMime", () => {
  it("treats text, csv, json and xml as readable", () => {
    expect(isTextLikeMime("text/plain")).toBe(true);
    expect(isTextLikeMime("text/csv")).toBe(true);
    expect(isTextLikeMime("application/json")).toBe(true);
    expect(isTextLikeMime("application/xml")).toBe(true);
  });

  it("treats PDFs and images as files to forward", () => {
    expect(isTextLikeMime("application/pdf")).toBe(false);
    expect(isTextLikeMime("image/jpeg")).toBe(false);
    expect(isTextLikeMime(null)).toBe(false);
  });
});

describe("deriveImapHost", () => {
  it("derives the IMAP host from common SMTP hosts", () => {
    expect(deriveImapHost("smtp.gmail.com")).toBe("imap.gmail.com");
    expect(deriveImapHost("smtp.office365.com")).toBe("imap.office365.com");
    expect(deriveImapHost("mail.example.com")).toBe("imap.example.com");
  });

  it("passes through an unknown host and handles empty input", () => {
    expect(deriveImapHost("mail.cortoba.local")).toBe("imap.cortoba.local");
    expect(deriveImapHost(undefined)).toBeUndefined();
  });
});

describe("selectAttachment", () => {
  const atts = [
    { index: 0, filename: "PO-customer.pdf", mimeType: "application/pdf", size: 10 },
    { index: 1, filename: "invoice.xlsx", mimeType: "application/vnd.ms-excel", size: 20 },
  ];

  it("picks by filename substring, case-insensitively", () => {
    expect(selectAttachment(atts, { filename: "INVOICE" }).filename).toBe("invoice.xlsx");
  });

  it("falls back to the index and defaults to the first attachment", () => {
    expect(selectAttachment(atts, { index: 1 }).filename).toBe("invoice.xlsx");
    expect(selectAttachment(atts).filename).toBe("PO-customer.pdf");
  });

  it("throws a helpful message listing what is available", () => {
    expect(() => selectAttachment(atts, { index: 9 })).toThrow(/PO-customer\.pdf/);
    expect(() => selectAttachment([])).toThrow(/لا توجد مرفقات/);
  });
});

/**
 * Sender shorthand resolution for the email census.
 *
 * Live failure (24/09): «هتخش للميل info وهتشوف اوامر الشراء كلها الواردة من
 * EDC» — the assistant answered «لم يتم العثور على أي مرفقات PDF … لا تحتوي على
 * ملفات POs» while 3,688 EDC messages sat in the mailbox. Cause: the model
 * passed `from: "EDC"`, the operator's SHORTHAND. `from` is narrowed
 * server-side and matched against the from header, and no address contains
 * "EDC" — the real sender is `noreply@egyptian-drilling.com` and the word only
 * appears in the SUBJECT («EDC PO No P26E14708»). Zero matches, reported as an
 * absence of documents.
 *
 * The fix resolves the shorthand against the senders the word actually reaches,
 * and — when it cannot — returns the senders it saw so the model asks instead of
 * announcing «لا توجد رسائل من هذا المُرسل».
 */
import { describe, it, expect } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

const { resolveSenderFromCandidates, aggregateSenders, senderAddress, isPdfContent } =
  await import("../../modules/ai-assistant/email");

describe("resolveSenderFromCandidates — a shorthand is not an address", () => {
  it("resolves «EDC» to the dominant sender among the messages it reaches", () => {
    // The senders of the messages whose subject says «EDC PO No …».
    const senders = [
      { from: "EDC - Egyptian Drilling <noreply@egyptian-drilling.com>", count: 3610 },
      { from: "youssef.elgohary@egyptian-drilling.com", count: 47 },
      { from: "mahmoud.abdrabu@egyptian-drilling.com", count: 15 },
      { from: "workspace-noreply@google.com", count: 4 },
    ];
    const { resolved } = resolveSenderFromCandidates("EDC", senders);
    // Same domain, so the busiest mailbox on it is the answer — not Google.
    expect(resolved).toBe("noreply@egyptian-drilling.com");
  });

  it("refuses to choose between two companies of comparable volume", () => {
    const senders = [
      { from: "sales@egyptian-drilling.com", count: 100 },
      { from: "info@edc-supplies.com", count: 90 },
    ];
    const { resolved, candidates } = resolveSenderFromCandidates("EDC", senders);
    // Guessing here answers about the WRONG company, which is worse than asking.
    expect(resolved).toBeNull();
    expect(candidates).toHaveLength(2);
  });

  it("picks the dominant company when the rival is a rounding error", () => {
    const senders = [
      { from: "noreply@egyptian-drilling.com", count: 3610 },
      { from: "no-reply@accounts.google.com", count: 2 },
    ];
    expect(resolveSenderFromCandidates("EDC", senders).resolved).toBe(
      "noreply@egyptian-drilling.com",
    );
  });

  it("returns null (never a guess) when there are no candidates", () => {
    expect(resolveSenderFromCandidates("EDC", []).resolved).toBeNull();
    expect(resolveSenderFromCandidates("", [{ from: "a@b.com", count: 1 }]).resolved).toBeNull();
  });

  it("sums senders on the same domain and reports the busiest address", () => {
    // A company writes from `noreply@` and from people's mailboxes; the domain is
    // the correspondent, so the counts must combine rather than compete.
    const senders = [
      { from: "person1@acme.com", count: 10 },
      { from: "person2@acme.com", count: 10 },
      { from: "noreply@other.com", count: 4 },
    ];
    // acme totals 20 vs other 4, so acme wins even though neither of its
    // individual mailboxes outranks `noreply@other.com` alone.
    const res = resolveSenderFromCandidates("x", senders);
    expect(res.resolved).toBe("person1@acme.com");
    // The DOMAIN travels with the answer so the caller keeps BOTH acme mailboxes:
    // filtering the single resolved address would drop person2's half of the mail.
    expect(res.domain).toBe("acme.com");
  });

  it("treats a comparable rival domain as ambiguous", () => {
    // 15 vs 20 is not a rounding error: picking either would be a coin flip, and
    // answering about the wrong company is the failure this refuses.
    const senders = [
      { from: "person1@acme.com", count: 10 },
      { from: "person2@acme.com", count: 10 },
      { from: "noreply@other.com", count: 15 },
    ];
    expect(resolveSenderFromCandidates("x", senders).resolved).toBeNull();
  });
});

describe("aggregateSenders", () => {
  it("keys on the address and sorts by volume", () => {
    const rows = aggregateSenders([
      { from: "EDC - Egyptian Drilling <noreply@egyptian-drilling.com>" },
      { from: "noreply@egyptian-drilling.com" },
      { from: "other@x.com" },
    ]);
    expect(rows[0]).toEqual({ from: "noreply@egyptian-drilling.com", count: 2 });
    expect(rows[1]).toEqual({ from: "other@x.com", count: 1 });
  });

  it("prefers the address over the display name", () => {
    // The envelope renders «Display Name addr@host»; taking the first token
    // reported the display name («EDC») as if it were the sender.
    expect(senderAddress("EDC - Egyptian Drilling Company <noreply@egyptian-drilling.com>")).toBe(
      "noreply@egyptian-drilling.com",
    );
  });
});

describe("isPdfContent — the sender's declared MIME is not evidence", () => {
  it("accepts real PDF bytes regardless of the declared type", () => {
    // EDC declares its PDFs `application/doc`; a mime-only filter found none.
    const bytes = Buffer.from("%PDF-1.4\n%âãÏÓ\n", "binary");
    expect(isPdfContent(bytes)).toBe(true);
  });

  it("rejects non-PDF bytes", () => {
    expect(isPdfContent(Buffer.from("PK\u0003\u0004 not a pdf"))).toBe(false);
  });
});

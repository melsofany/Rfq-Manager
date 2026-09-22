/**
 * The ONE outbound identity for the whole system.
 *
 * Every message this server sends — supplier POs, RFQ requests, and the AI
 * assistant's replies — must leave from the same authenticated mailbox. That is
 * what keeps SPF/DKIM aligned, keeps Reply-To pointing at a monitored inbox,
 * and keeps the sent copy in one archive. It is also the reason a supplier
 * never sees a reply come back from a stranger's address.
 *
 * The read side is deliberately separate: `mailboxes.ts` may read many
 * mailboxes (including other addresses on the domain), but reading can never
 * change what we send from. Keeping the sending identity in its own module —
 * with no reference to any read mailbox — makes that impossible by
 * construction, not by convention.
 *
 * Env (all optional; SMTP_USER is the fallback for every one of them):
 *   SMTP_FROM_EMAIL       the mailbox to send as       (default SMTP_USER)
 *   SMTP_FROM_NAME        display name                 (default "Cortoba Supplies قرطبة للتوريدات")
 *   SMTP_REPLY_TO_EMAIL   where replies should land    (default SMTP_FROM_EMAIL)
 *   SMTP_REPLY_TO_NAME    reply-to display name        (default SMTP_FROM_NAME)
 *   MAIL_READONLY         "true" refuses to send anything (see assertCanSend)
 */
import { logger } from "./logger";

export interface MailIdentity {
  /** The envelope/header address every message is sent as. */
  email: string;
  /** Display name shown next to the address. */
  name: string;
  /** Where a reply from the recipient is directed. */
  replyTo: string;
  replyToName: string;
}

/**
 * True when outbound mail must not be sent. A single switch that disables every
 * sender at once — useful for staging a read-only assistant, where the
 * operator wants the agent to answer questions about mail without any chance
 * of it replying to a supplier.
 */
export function isMailReadOnly(): boolean {
  return process.env.MAIL_READONLY === "true";
}

export class MailReadOnlyError extends Error {
  constructor() {
    super("إرسال البريد معطّل (MAIL_READONLY=true) — النظام للقراءة فقط حاليًا.");
    this.name = "MailReadOnlyError";
  }
}

/** Throws when the system is configured to never send. Call before every send. */
export function assertCanSend(): void {
  if (isMailReadOnly()) throw new MailReadOnlyError();
}

/**
 * Resolve the outbound identity. Never consults a read mailbox, so adding a
 * mailbox to the read list cannot alter the From header.
 */
export function senderIdentity(): MailIdentity {
  const email = (process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || "").trim();
  const name = (process.env.SMTP_FROM_NAME || "Cortoba Supplies قرطبة للتوريدات").trim();
  return {
    email,
    name,
    replyTo: (process.env.SMTP_REPLY_TO_EMAIL || email).trim(),
    replyToName: (process.env.SMTP_REPLY_TO_NAME || name).trim(),
  };
}

/** `"Display Name" <addr@host>` — quoted so Arabic and commas parse correctly. */
function formatAddress(name: string, email: string): string {
  // An empty address must yield no header at all: `"Name" <>` is malformed and
  // some MTAs accept it, sending the message with no usable return path.
  if (!email) return "";
  if (!name) return email;
  return `"${name.replace(/"/g, "'")}" <${email}>`;
}

/** The From header value to hand to nodemailer. */
export function fromHeader(): string {
  const id = senderIdentity();
  return formatAddress(id.name, id.email);
}

/** The Reply-To header value, or undefined when there is no usable reply address. */
export function replyToHeader(): string | undefined {
  const id = senderIdentity();
  if (!id.replyTo) return undefined;
  return formatAddress(id.replyToName, id.replyTo);
}

/**
 * Warn on a misconfiguration that would send unauthenticated-looking mail.
 * Called once at startup so the problem shows in the deploy log rather than in
 * a supplier's spam folder.
 */
export function verifySenderIdentity(): void {
  const id = senderIdentity();
  if (!id.email) {
    logger.error(
      "SMTP_FROM_EMAIL/SMTP_USER are both unset — outbound mail has no sender and will fail.",
    );
    return;
  }
  if (!id.email.includes("@")) {
    logger.error({ email: id.email }, "Sender email is not a valid address.");
  }
  // A different SMTP_FROM_EMAIL and SMTP_USER is legal (Google lets a user send
  // on behalf of another address once it is a verified alias), but it is the
  // classic way to break DKIM alignment by accident — so say so loudly.
  const auth = (process.env.SMTP_USER || "").trim().toLowerCase();
  if (auth && id.email.toLowerCase() !== auth) {
    logger.warn(
      { from: id.email, authenticatedAs: auth },
      "Sending as an address that differs from the authenticated SMTP_USER. " +
        "This only works if the address is a verified alias on the account, and " +
        "it can break DKIM alignment (SPF/DMARC). Confirm the alias exists in " +
        "the Google Workspace admin console.",
    );
  }
  if (isMailReadOnly()) logger.warn("MAIL_READONLY=true — all outbound email is disabled.");
}

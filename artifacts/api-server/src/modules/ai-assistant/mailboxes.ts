/**
 * The READ side: one or more mailboxes the assistant may read.
 *
 * Deliberately separate from `shared/mail-identity.ts` (the single SEND
 * identity). Increasing the number of mailboxes here must never change what the
 * system sends as — that separation is the whole point of the split.
 *
 * ## Configuration
 *
 * `AI_MAILBOXES` names the mailboxes, comma-separated. Each entry is either a
 * full address, or `email|Label`:
 *
 *     AI_MAILBOXES=procurement@cortoba-supplies.com,info@cortoba-supplies.com|العام
 *
 * The FIRST entry is the default mailbox when the operator does not name one.
 *
 * ## Authentication (Google Workspace — domain-wide delegation)
 *
 * Every mailbox authenticates as itself through a service account, using the
 * existing `GOOGLE_ACCOUNT_BASE_64` credentials (the same service account the
 * Sheets and Drive-backup modules use). No per-mailbox passwords are stored
 * anywhere, which is what makes it impossible to send from the wrong account.
 *
 * Required setup in Google Workspace Admin Console (once, by an admin):
 *   1. Add the service account's client ID to the domain-wide delegation list.
 *   2. Authorize the scope: https://mail.google.com/
 * Then every mailbox in `AI_MAILBOXES` is readable without further secrets.
 *
 * If there is exactly one mailbox, the legacy `IMAP_USER`/`IMAP_PASS` app
 * password path still works, so a single-mailbox deployment needs no Google
 * admin change.
 */
import { logger } from "../../shared/logger";

export interface Mailbox {
  /** The mailbox address, as used in the IMAP `user` field. */
  email: string;
  /** Human label shown to the model and the operator (Arabic-friendly). */
  label: string;
  /** True when this mailbox should be read by default. */
  isDefault: boolean;
}

/** Cache: the config is read at boot and after an env change, not per request. */
let cached: Mailbox[] | null = null;

/** Reset the cache (used by tests and after a settings change). */
export function clearMailboxCache(): void {
  cached = null;
}

function parseMailboxList(raw: string): Mailbox[] {
  const out: Mailbox[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [emailRaw, labelRaw] = trimmed.split("|");
    const email = (emailRaw || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      logger.warn({ entry: trimmed }, "AI_MAILBOXES: ignoring entry without a valid address");
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({
      email,
      label: (labelRaw || "").trim() || email.split("@")[0],
      isDefault: false,
    });
  }
  if (out.length) out[0].isDefault = true;
  return out;
}

/**
 * The configured read mailboxes.
 *
 * Falls back to the single legacy account (IMAP_USER or SMTP_USER) so an
 * existing deployment keeps working unchanged.
 */
export function mailboxes(): Mailbox[] {
  if (cached) return cached;

  const raw = process.env.AI_MAILBOXES;
  if (raw && raw.trim()) {
    cached = parseMailboxList(raw);
    if (cached.length) return cached;
    logger.warn("AI_MAILBOXES was set but contained no usable address — falling back.");
  }

  const single = (process.env.IMAP_USER || process.env.SMTP_USER || "").trim().toLowerCase();
  cached = single ? [{ email: single, label: single.split("@")[0], isDefault: true }] : [];
  return cached;
}

/** The mailbox used when the operator does not name one. */
export function defaultMailbox(): Mailbox | undefined {
  const all = mailboxes();
  return all.find((m) => m.isDefault) ?? all[0];
}

export function isMultiMailbox(): boolean {
  return mailboxes().length > 1;
}

/**
 * Log the readable mailboxes at startup.
 *
 * A missing or partial `AI_MAILBOXES` is otherwise invisible until someone asks
 * the assistant a question and gets "not found" — the mailboxes are read from
 * the environment, not from the database, so there is no settings screen to
 * check.
 */
export function logReadMailboxes(): void {
  const all = mailboxes();
  if (!all.length) {
    logger.warn("لا يوجد أي صندوق بريد قابل للقراءة — اضبط AI_MAILBOXES (غير مفعّل).");
    return;
  }
  logger.info(
    { mailboxes: all.map((m) => m.email), default: defaultMailbox()?.email },
    `البريد للقراءة: ${all.length} صندوق`,
  );
}

/**
 * Resolve an operator/model-supplied mailbox reference against the configured
 * list. Accepts a full address, a domain-less local part, or the label —
 * because people say "اقرأ من المبيعات" or "info@" rather than typing a full
 * address. Returns undefined when nothing matches, so callers can report the
 * available mailboxes instead of silently reading the wrong one.
 */
export function resolveMailbox(ref: string | undefined | null): Mailbox | undefined {
  if (!ref || !ref.trim()) return defaultMailbox();
  // People type "sales@" as readily as "sales", so drop a trailing @ rather
  // than failing the lookup on punctuation.
  const needle = ref.trim().toLowerCase().replace(/@+$/, "");
  const all = mailboxes();

  return (
    all.find((m) => m.email === needle) ||
    all.find((m) => m.email.split("@")[0] === needle) ||
    all.find((m) => m.label.toLowerCase() === needle) ||
    all.find((m) => m.email.startsWith(`${needle}@`)) ||
    all.find((m) => m.label.toLowerCase().includes(needle))
  );
}

/** The list to show the model / an error message. */
export function mailboxListForDisplay(): string {
  return mailboxes()
    .map((m) =>
      m.label && m.label !== m.email.split("@")[0] ? `${m.email} (${m.label})` : m.email,
    )
    .join(", ");
}

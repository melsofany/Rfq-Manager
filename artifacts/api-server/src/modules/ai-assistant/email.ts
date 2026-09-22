/**
 * AI Assistant — mailbox access (IMAP read/search + SMTP send).
 *
 * Sending reuses the shared SMTP credentials. Reading reuses those SAME
 * credentials against the matching IMAP host unless `IMAP_*` overrides are
 * given, so a working mail account needs no extra configuration. Everything
 * degrades gracefully: when reading is not configured the read tools report
 * that clearly instead of throwing.
 *
 * Env:
 *   IMAP_HOST (default: derived from SMTP_HOST), IMAP_PORT (default 993),
 *   IMAP_USER (default SMTP_USER), IMAP_PASS (default SMTP_PASS),
 *   IMAP_SECURE (default true), IMAP_FROM_NAME
 */
import { promises as dns } from "dns";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { logger } from "../../shared/logger";
import {
  assertCanSend,
  fromHeader,
  replyToHeader,
  senderIdentity,
} from "../../shared/mail-identity";
import { mailboxes, mailboxListForDisplay, resolveMailbox } from "./mailboxes";
import { gmailAccessToken, isDelegationConfigured } from "./gmail-auth";

const SMTP_TIMEOUT_MS = 15000;

/**
 * Recent messages examined per mailbox when searching.
 *
 * Envelope metadata is cheap, so the window can be generous — enough to cover
 * months of traffic in a busy inbox.
 */
const BODY_SCAN_BUDGET = 400;

/**
 * Messages whose FULL body is MIME-parsed when the envelopes alone matched
 * nothing. Parsing is the expensive part (measured: seconds for a full window),
 * so the second pass is bounded much more tightly than the envelope pass. A
 * body-only match older than this is rare, and the alternative is making every
 * email question slow for everyone.
 */
const BODY_PARSE_BUDGET = 60;

/**
 * Envelope budget for a CENSUS scan (`scanEmails`).
 *
 * An envelope fetch is cheap — measured against the live mailbox: 3,875
 * envelopes in ~4.5s, versus ~0.33s for 400 — so a census can afford to read
 * the whole mailbox. The search path's 400-message window is what made the
 * assistant answer «10 رسائل» for 1,582 real messages: it could not SEE the rest
 * of the year, so no amount of prompting could produce a correct count.
 *
 * Read per call (not a module constant) so the truncation path can be exercised
 * with a small mailbox instead of allocating 20,000 messages.
 */
export function censusEnvelopeBudget(): number {
  return Number(process.env.AI_CENSUS_ENVELOPE_BUDGET) || 20_000;
}

/** Envelopes fetched per IMAP round-trip, so the time budget can be checked. */
const CENSUS_CHUNK = 1_000;

/**
 * Wall-clock ceiling for one mailbox's census. A full-year scan of a large
 * inbox is seconds, not minutes; past this the answer is reported as partial
 * (with the scope that was covered) rather than blowing the agent's budget.
 */
const CENSUS_TIME_BUDGET_MS = 40_000;

/**
 * Document-number shapes worth extracting from subjects during a census. These
 * are the identifiers this business actually keys on: EDC-style customer RFQ
 * numbers (26R011936), supplier PO numbers (P26E11407), internal customer-RFQ
 * and customer-PO numbers, and external platform references (RFQ-6152439).
 */
export const DEFAULT_NUMBER_PATTERNS = [
  "\\b\\d{2}R\\d{5,9}\\b",
  "\\bP\\d{2}E\\d{5,8}\\b",
  "\\bC?RFQ-\\d{4}-\\d{4,6}\\b",
  "\\bCPO-\\d{4}-\\d{4,6}\\b",
  "\\bRFQ[- ]?\\d{5,10}\\b",
];

let cachedIpv4Host: string | null = null;
let cacheExpiry = 0;

async function resolveIpv4(hostname: string): Promise<string> {
  const now = Date.now();
  if (cachedIpv4Host && now < cacheExpiry) return cachedIpv4Host;
  try {
    const addrs = await dns.resolve4(hostname);
    if (addrs.length > 0) {
      cachedIpv4Host = addrs[0];
      cacheExpiry = now + 5 * 60 * 1000;
      return cachedIpv4Host;
    }
  } catch {
    /* fall back to hostname */
  }
  return hostname;
}

/**
 * Derive the IMAP host from the SMTP host so a single mail account configures
 * both directions: smtp.gmail.com -> imap.gmail.com, and the same swap for
 * outlook/office365/yahoo hosts. Falls back to the SMTP host unchanged.
 */
export function deriveImapHost(smtpHost: string | undefined): string | undefined {
  if (!smtpHost) return undefined;
  const host = smtpHost.trim().toLowerCase();
  if (!host) return undefined;
  if (host.startsWith("smtp.")) return `imap.${host.slice("smtp.".length)}`;
  if (host.startsWith("mail.")) return `imap.${host.slice("mail.".length)}`;
  return host;
}

export function imapConfig(): {
  host?: string;
  port: number;
  user?: string;
  pass?: string;
  secure: boolean;
} {
  const smtpHost = process.env.SMTP_HOST;
  const host = process.env.IMAP_HOST || deriveImapHost(smtpHost);
  return {
    host,
    port: Number(process.env.IMAP_PORT) || 993,
    user: process.env.IMAP_USER || process.env.SMTP_USER,
    pass: process.env.IMAP_PASS || process.env.SMTP_PASS,
    secure: process.env.IMAP_SECURE !== "false",
  };
}

/**
 * True when IMAP reading is usable. A Google service account makes reading
 * possible for any configured mailbox (no password needed); otherwise the
 * legacy path requires host + user + pass — checking only host+user would report
 * "configured" for a partially-set mailbox (e.g. SMTP_PASS unset) and then fail
 * at login with a confusing authentication error instead of the clear "not
 * configured" path.
 */
export function isEmailReadConfigured(): boolean {
  const cfg = imapConfig();
  if (!cfg.host) return false;
  if (isDelegationConfigured() && mailboxes().length > 0) return true;
  return Boolean(cfg.user && cfg.pass);
}

/**
 * Open an IMAP connection for `mailbox` and run `fn`.
 *
 * Two authentication paths, chosen per mailbox:
 *  1. Service account + domain-wide delegation (XOAUTH2) when
 *     `GOOGLE_ACCOUNT_BASE_64` is set. This is the multi-mailbox path: no
 *     password is stored for any mailbox, and each connection impersonates its
 *     own address.
 *  2. The legacy single-account app password (`IMAP_PASS`/`SMTP_PASS`), used
 *     only for the one legacy mailbox so an existing deployment is unaffected.
 */
export async function withMailbox<T>(
  fn: (client: ImapFlow) => Promise<T>,
  mailboxArg?: string,
): Promise<T> {
  const mailbox = resolveMailbox(mailboxArg);
  if (!mailbox) {
    throw new Error(
      `لم أجد بريدًا مطابقًا لـ «${mailboxArg}». المتاح: ${mailboxListForDisplay() || "لا يوجد"}.`,
    );
  }

  const cfg = imapConfig();
  if (!cfg.host) {
    throw new Error("قراءة البريد غير مهيّأة على الخادم (IMAP_HOST أو SMTP_HOST مطلوب).");
  }

  const usingDelegation = isDelegationConfigured();
  let auth: { user: string; pass?: string; accessToken?: string };

  if (usingDelegation) {
    auth = { user: mailbox.email, accessToken: await gmailAccessToken(mailbox.email) };
  } else {
    // Legacy path: a single mailbox with an app password. Refuse to read an
    // address other than the authenticated one — the password only works for it,
    // and attempting otherwise yields a confusing auth error.
    const legacyUser = (cfg.user ?? "").toLowerCase();
    if (mailbox.email !== legacyUser) {
      throw new Error(
        `قراءة البريد متعدّدة الصناديق تحتاج تفويض Google (GOOGLE_ACCOUNT_BASE_64). ` +
          `لا يمكن استخدام كلمة مرور التطبيق لبريد غير ${legacyUser || "(غير محدد)"}.`,
      );
    }
    if (!cfg.pass) {
      throw new Error("قراءة البريد غير مهيّأة: IMAP_PASS أو SMTP_PASS مطلوب.");
    }
    auth = { user: mailbox.email, pass: cfg.pass };
  }

  const host = await resolveIpv4(cfg.host);
  const client = new ImapFlow({
    host,
    port: cfg.port,
    secure: cfg.secure,
    auth: auth as never,
    tls: {
      servername: cfg.host,
      rejectUnauthorized: false,
    },
    logger: false,
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Which folder to read. Gmail exposes the Sent folder under a LOCALIZED name
 * (e.g. «[Gmail]/البريد المرسل» in Arabic), so a hardcoded "Sent" silently reads
 * nothing on a non-English Workspace. `resolveFolderPath` below finds the real
 * path instead.
 */
export type EmailFolder = "inbox" | "sent";

/** Special-use flag Gmail reports for the Sent folder (compared lowercased). */
const SENT_ATTRIBUTE = "\\sent";

/**
 * The real IMAP path of the requested folder.
 *
 * Prefers the `\Sent` special-use attribute (locale-independent), then falls
 * back to matching a path whose final segment looks like a sent folder in
 * English, Arabic, or French — Gmail's three most common UI languages here.
 */
export async function resolveFolderPath(client: ImapFlow, folder: EmailFolder): Promise<string> {
  if (folder === "inbox") return "INBOX";
  let boxes: { path: string; specialUse?: string }[] = [];
  try {
    boxes = await client.list();
  } catch {
    return "[Gmail]/Sent Mail";
  }
  return pickSentFolderPath(boxes);
}

/**
 * Known Sent-folder leaf names, across the UI languages this domain's users
 * might have set. Matching the LAST path segment exactly (rather than a regex
 * over the whole path) is what keeps a folder such as "[Gmail]/Sentinel" from
 * being mistaken for Sent.
 */
const SENT_FOLDER_NAMES = new Set([
  "sent",
  "sent mail",
  "sent items",
  "sent messages",
  "sent e-mail",
  "sent email",
  "المرسل",
  "البريد المرسل",
  "رسائل مرسلة",
  "messages envoyés",
  "éléments envoyés",
  "envoyés",
]);

/**
 * Choose the Sent path from a mailbox list. Extracted so the locale handling can
 * be tested without an IMAP connection.
 */
export function pickSentFolderPath(boxes: { path: string; specialUse?: string }[]): string {
  const byAttr = boxes.find((b) => (b.specialUse ?? "").toLowerCase().trim() === SENT_ATTRIBUTE);
  if (byAttr) return byAttr.path;

  const byName = boxes.find((b) => {
    const leaf = b.path.split("/").pop() ?? "";
    return SENT_FOLDER_NAMES.has(leaf.toLowerCase().trim());
  });
  if (byName) return byName.path;

  return "[Gmail]/Sent Mail";
}

export interface EmailSummary {
  uid: number;
  /**
   * Which mailbox this message lives in. A UID is only unique WITHIN a mailbox,
   * so with multiple mailboxes configured the UID alone is ambiguous — the
   * operator must pass this back when asked to open a message.
   */
  mailbox: string;
  /** "inbox" or "sent" — which folder it came from. */
  folder: EmailFolder;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  hasAttachments: boolean;
}

export interface EmailAttachmentMeta {
  index: number;
  filename: string;
  mimeType: string | null;
  size: number;
}

export interface EmailDetail extends EmailSummary {
  body: string;
  attachments: EmailAttachmentMeta[];
}

export interface EmailAttachmentContent extends EmailAttachmentMeta {
  /** Null when the attachment exceeds MAX_ATTACHMENT_BYTES. */
  content: Buffer | null;
  oversized: boolean;
}

/**
 * Attachments larger than this are reported, not downloaded — WhatsApp
 * documents max out around 100MB and an oversized fetch would just burn memory.
 * Overridable so the guard can be exercised without allocating 25MB.
 */
export const MAX_ATTACHMENT_BYTES = Number(process.env.AI_MAX_ATTACHMENT_BYTES) || 25 * 1024 * 1024;

/** Attachments worth handing back to the model as text rather than a file. */
export function isTextLikeMime(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  const mime = mimeType.toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    mime.includes("csv") ||
    mime.includes("x-www-form-urlencoded")
  );
}

/**
 * Pick one attachment out of a message. `filename` matches case-insensitively
 * as a substring so the model can ask for "the PO pdf" without knowing exact
 * naming; `index` is the fallback and defaults to the first attachment.
 */
export function selectAttachment<T extends EmailAttachmentMeta>(
  attachments: T[],
  opts: { index?: number; filename?: string } = {},
): T {
  if (attachments.length === 0) throw new Error("لا توجد مرفقات في هذه الرسالة.");
  if (opts.filename) {
    const needle = opts.filename.trim().toLowerCase();
    const hit = attachments.find((a) => a.filename.toLowerCase().includes(needle));
    if (hit) return hit;
  }
  const idx = Number.isInteger(opts.index) ? (opts.index as number) : 0;
  const byIndex = attachments[idx];
  if (!byIndex) {
    const names = attachments.map((a, i) => `${i}: ${a.filename}`).join(", ");
    throw new Error(`لا يوجد مرفق بالرقم ${idx}. المتاح: ${names}`);
  }
  return byIndex;
}

function snippetOf(text: string, len = 200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, len);
}

/**
 * Normalise text for loose matching: lowercase, strip Arabic diacritics/tatweel,
 * unify alef/ya/ta variants, and drop punctuation. A search for "شركة الحفر
 * المصرية" must match "شركه الحفر المصريه" and vice-versa.
 */
export function normalizeText(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // harakat + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when every whitespace-separated token of `needle` appears in `hay`. */
function matchesAllTokens(hay: string, needle: string): boolean {
  return matchEmailFields({ haystack: hay, needle });
}

/**
 * The client-side match rule, exported so it can be tested directly. `haystack`
 * is the searchable text (subject + from display name + addresses, and the body
 * when the envelope did not already match), `needle` the operator's phrase.
 */
export function matchEmailFields(opts: { haystack: string; needle: string }): boolean {
  const tokens = normalizeText(opts.needle).split(" ").filter(Boolean);
  if (!tokens.length) return false;
  const target = normalizeText(opts.haystack);
  return tokens.every((t) => target.includes(t));
}

export interface EmailScope {
  mailbox: string;
  /** Which folder was searched ("inbox" / "sent"). */
  folder: EmailFolder;
  sinceDays: number;
  /** How many messages were scanned client-side. */
  scanned: number;
  /** Set when the server-side search was skipped or reported an error. */
  note?: string;
}

export interface EmailSearchResult {
  emails: EmailSummary[];
  scope: EmailScope;
}

/**
 * Search recent messages by matching CLIENT-SIDE.
 *
 * Why not the server's `search.or = [{subject},{body}]`: BODY full-text search
 * is unimplemented or unreliable on many IMAP servers, it never matches the
 * From display name, and Arabic terms are mangled by charset handling. The
 * observable effect was "لا توجد رسائل من EDC" for mail that was right there. We
 * therefore fetch the recent window's envelopes and match in JS, so matching is
 * predictable and reported back to the caller.
 */
export async function searchEmails(opts: {
  query?: string;
  from?: string;
  sinceDays?: number;
  limit?: number;
  /**
   * Which mailbox to read. Omitted → the default mailbox. `"*"` → EVERY
   * configured mailbox (used when the operator asks without naming one, so an
   * answer is never "not found" merely because the message lives in a different
   * inbox).
   */
  mailbox?: string;
  /** Which folder to read. Defaults to the inbox. */
  folder?: EmailFolder;
  unseenOnly?: boolean;
}): Promise<EmailSearchResult[]> {
  const targets = opts.mailbox === "*" ? mailboxes() : [resolveMailbox(opts.mailbox)];
  const usable = targets.filter((m): m is NonNullable<typeof m> => Boolean(m));
  if (!usable.length) {
    throw new Error(
      `لم أجد بريدًا مطابقًا لـ «${opts.mailbox}». المتاح: ${mailboxListForDisplay() || "لا يوجد"}.`,
    );
  }
  const folder: EmailFolder = opts.folder ?? "inbox";

  // Read mailboxes in parallel — they are independent connections, and with
  // three inboxes a serial scan would make the operator wait three times as
  // long for the same answer.
  return Promise.all(usable.map((m) => searchOneMailbox(m.email, opts, folder)));
}

async function searchOneMailbox(
  mailboxAddress: string,
  opts: {
    query?: string;
    from?: string;
    sinceDays?: number;
    limit?: number;
    unseenOnly?: boolean;
  },
  folder: EmailFolder,
): Promise<EmailSearchResult> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 30);
  const sinceDays = Math.min(Math.max(opts.sinceDays ?? 60, 1), 3650);
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  // `mailboxAddress` MUST be forwarded: without it `withMailbox` falls back to
  // the DEFAULT mailbox and every "mailbox" in a fan-out would read the same
  // inbox, silently returning the first mailbox's mail three times.
  return withMailbox(async (client) => {
    const path = await resolveFolderPath(client, folder);
    const lock = await client.getMailboxLock(path);
    try {
      let uids = (await client.search({ since }, { uid: true })) || [];
      let note: string | undefined;
      if (!uids.length) {
        // Some servers reject a bare `since`; fall back to the whole mailbox so
        // an operator never gets an empty answer from a search quirk.
        uids = (await client.search({ all: true }, { uid: true })) || [];
        if (uids.length) note = "تعذّر التصفية بتاريخ الاستلام؛ تم فحص صندوق البريد بالكامل.";
      }
      // Bound the scan: newest last, so slice from the tail then reverse.
      const window = uids.slice(-BODY_SCAN_BUDGET);
      const out: EmailSummary[] = [];
      const hasQuery = Boolean(opts.query && opts.query.trim());
      const hasFrom = Boolean(opts.from && opts.from.trim());

      /*
       * Two passes, because a message body is expensive and usually unnecessary.
       * Fetching `source` for the whole window and MIME-parsing each message cost
       * seconds per mailbox (×3 mailboxes, on every search) — the dominant cost
       * of an email question. Subject and sender live in the envelope, so pass 1
       * reads ONLY metadata; pass 2 parses bodies, bounded tightly, and only
       * when pass 1 did not already fill the page.
       */
      const envelopeMatched = new Set<number>();
      const matched: EmailSummary[] = [];
      for await (const msg of client.fetch(window, { uid: true, envelope: true }, { uid: true })) {
        if (opts.unseenOnly && (msg.flags?.has("\\Seen") ?? false)) continue;
        const env = envelopeOf(msg, mailboxAddress, folder);
        if (hasQuery && !matchesAllTokens(`${env.subject} ${env.from} ${env.to}`, opts.query!)) {
          continue;
        }
        if (hasFrom && !matchesAllTokens(env.from, opts.from!)) continue;
        envelopeMatched.add(msg.uid);
        matched.push(env);
      }

      /*
       * Pass 2 is a FALLBACK, not a supplement: it runs only when the envelope
       * search found nothing. If the subject or sender matched, the operator's
       * question is already answered, and spending up to BODY_PARSE_BUDGET MIME
       * parses to also catch a body-only mention is not worth the seconds it
       * adds — that cost is exactly what made email questions slow.
       */
      if (hasQuery && matched.length === 0) {
        const bodyWindow = window.slice(-BODY_PARSE_BUDGET);
        for await (const msg of client.fetch(
          bodyWindow,
          { uid: true, envelope: true, source: true },
          { uid: true },
        )) {
          if (envelopeMatched.has(msg.uid)) continue;
          if (opts.unseenOnly && (msg.flags?.has("\\Seen") ?? false)) continue;
          const parsed = await safeParse(msg.source as Buffer);
          if (!parsed) continue;
          const env = envelopeOf(msg, mailboxAddress, folder);
          if (hasFrom && !matchesAllTokens(env.from, opts.from!)) continue;
          if (
            !matchesAllTokens(
              `${env.subject} ${env.from} ${env.to} ${parsed.text.slice(0, 20_000)}`,
              opts.query!,
            )
          ) {
            continue;
          }
          matched.push({
            ...env,
            snippet: snippetOf(parsed.text),
            hasAttachments: (parsed.attachments?.length ?? 0) > 0,
          });
        }
      }

      // Only the newest `limit` are returned, so only those need their body
      // parsed for the snippet. Parsing the whole matched set would make an
      // unfiltered "latest mail" question as slow as a full scan.
      const selected = matched.slice(-limit).reverse();
      for (const e of selected) {
        if (e.snippet || e.hasAttachments) continue; // already parsed in pass 2
        const text = await parseBodyText(e.uid, client);
        e.snippet = snippetOf(text.text);
        e.hasAttachments = text.hasAttachments;
      }

      return {
        emails: selected,
        scope: { mailbox: mailboxAddress, folder, sinceDays, scanned: window.length, note },
      };
    } finally {
      lock.release();
    }
  }, mailboxAddress);
}

/** Envelope-only summary fields, shared by both search passes. */
function envelopeOf(
  msg: {
    uid: number;
    envelope?: {
      from?: { name?: string; address?: string }[];
      to?: { address?: string }[];
      subject?: string;
      date?: Date | string;
    };
  },
  mailboxAddress: string,
  folder: EmailFolder,
): EmailSummary {
  const from =
    msg.envelope?.from?.map((a) => `${a.name ?? ""} ${a.address ?? ""}`).join(", ") || "";
  const to = msg.envelope?.to?.map((a) => a.address ?? "").join(", ") || "";
  const subject = msg.envelope?.subject || "";
  const d = msg.envelope?.date;
  return {
    uid: msg.uid,
    mailbox: mailboxAddress,
    folder,
    from,
    to,
    subject: subject || "(بدون موضوع)",
    date: (d instanceof Date ? d : new Date(d ?? Date.now())).toISOString(),
    snippet: "",
    hasAttachments: false,
  };
}

/** Parse one message's body, tolerating a malformed message. */
async function parseBodyText(
  uid: number,
  client: { fetchOne: (seq: string, opts: unknown, opts2?: unknown) => Promise<unknown> },
): Promise<{ text: string; hasAttachments: boolean }> {
  try {
    const raw = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    const source = (raw as { source?: Buffer } | undefined)?.source;
    if (!source) return { text: "", hasAttachments: false };
    const parsed = await simpleParser(source);
    return {
      text: parsed.text || "",
      hasAttachments: (parsed.attachments?.length ?? 0) > 0,
    };
  } catch {
    return { text: "", hasAttachments: false };
  }
}

async function safeParse(
  source: Buffer,
): Promise<{ text: string; attachments?: unknown[] } | null> {
  try {
    const parsed = await simpleParser(source);
    return { text: parsed.text || "", attachments: parsed.attachments };
  } catch {
    return null;
  }
}

/** One message matched by a census scan. */
export interface EmailCensusMatch {
  uid: number;
  mailbox: string;
  folder: EmailFolder;
  from: string;
  to: string;
  subject: string;
  date: string;
  /** Document numbers extracted from the subject (see `numberPatterns`). */
  numbers: string[];
}

/** How a census was narrowed and how much of the mailbox it actually covered. */
export interface EmailCensusScope {
  folder: EmailFolder;
  sinceDate: string | null;
  beforeDate: string | null;
  /** Per-mailbox coverage, including whether the budget cut the scan short. */
  mailboxes: Array<{
    mailbox: string;
    scanned: number;
    truncated: boolean;
    /** False when the server-side narrowing failed and the whole box was read. */
    serverNarrowed: boolean;
  }>;
  /** Envelopes examined in total. */
  scanned: number;
  /**
   * True when any mailbox was only PARTIALLY scanned (budget or time limit).
   * `matched` is then a LOWER BOUND, and the caller must say so — presenting a
   * partial scan as a total is the failure this capability exists to prevent.
   */
  truncated: boolean;
  elapsedMs: number;
}

/** One distinct document number found in the census, with an example message. */
export interface EmailCensusNumber {
  number: string;
  count: number;
  sample: { uid: number; mailbox: string; folder: EmailFolder; subject: string; date: string };
}

/** Result of reconciling extracted numbers against the system of record. */
export interface EmailNumberComparison {
  /** Which table/column the numbers were checked against. */
  table: string;
  column: string;
  /** Numbers present in the system. */
  found: number;
  /** Numbers seen in email but ABSENT from the system, with an example. */
  missing: Array<{ number: string; subject: string; date: string; mailbox: string }>;
  /** Numbers in email that the system already has (for spot-checking). */
  matchedSample: Array<{ number: string; value: string }>;
}

export interface EmailCensusResult {
  /** Total matched messages across every mailbox — the exact count when not truncated. */
  matched: number;
  /** How many messages are returned in `emails` (bounded by `limit`). */
  returned: number;
  emails: EmailCensusMatch[];
  byMailbox: Record<string, number>;
  /** Matched messages per YYYY-MM — the basis for paging a large census. */
  byMonth: Record<string, number>;
  bySender: Array<{ from: string; count: number }>;
  /** Distinct document numbers (bounded; see `numbersTruncated`). */
  numbers: EmailCensusNumber[];
  distinctNumbers: number;
  numbersTruncated: boolean;
  compare?: EmailNumberComparison;
  scope: EmailCensusScope;
  note: string;
}

/** Extract document numbers from a subject using the given regex sources. */
export function extractNumbers(subject: string, patterns: string[]): string[] {
  const found = new Set<string>();
  for (const src of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(src, "gi");
    } catch {
      continue; // an invalid model-supplied pattern must not fail the scan
    }
    for (const m of subject.matchAll(re)) {
      const token = (m[0] || "").replace(/\s+/g, " ").trim().toUpperCase();
      if (token) found.add(token);
    }
  }
  return [...found];
}

/** The bare address out of a "Name <addr@host>" header value. */
export function senderAddress(from: string): string {
  // Prefer a real address token: the envelope's `from` is rendered as
  // "Display Name addr@host", so taking the first whitespace token would report
  // the display name ("edc") instead of the address the operator recognizes.
  const address = /[^\s<>",;]+@[^\s<>",;]+/.exec(from);
  if (address) return address[0].toLowerCase();
  const angled = /<([^>]+)>/.exec(from);
  const raw = (angled?.[1] ?? from).trim().toLowerCase();
  return raw.split(/\s+/)[0] || "";
}

/** Max distinct numbers returned before the list is declared truncated. */
const CENSUS_NUMBER_CAP = 400;

/**
 * Census / reconciliation scan over a whole mailbox (or a date range of one).
 *
 * `searchEmails` answers "show me messages matching X" and is bounded to the
 * recent window and 30 results — correct for that question, but it cannot answer
 * "how many RFQs arrived this year" or "which numbers are in the mail but not in
 * the system". The assistant answered those anyway, presenting a 30-row page as
 * a total (live: «10 رسائل» / «أكثر من 30» for 1,582 real messages), because no
 * tool could count.
 *
 * This one is built for enumeration:
 *  - narrows SERVER-SIDE (from/subject/date) so the whole mailbox is reachable;
 *  - reads envelopes only, so a few thousand messages cost seconds;
 *  - reports coverage explicitly (`scope.truncated`) so a partial scan is never
 *    presented as a complete answer;
 *  - aggregates (totals, by month, by sender, distinct numbers) instead of
 *    handing back a page the caller has to add up itself;
 *  - can reconcile the extracted numbers against a table via `compare`.
 */
export async function scanEmails(opts: {
  from?: string;
  subject?: string;
  query?: string;
  sinceDate?: string;
  beforeDate?: string;
  mailbox?: string;
  folder?: EmailFolder;
  limit?: number;
  /** Regex sources used to pull document numbers out of the subject. */
  numberPatterns?: string[];
  /** Reconcile extracted numbers against the system of record. */
  compare?: (
    numbers: string[],
    target: { table: string; column: string },
  ) => Promise<{
    found: number;
    /** Numbers the system does NOT have (enriched with an email sample below). */
    missingNumbers: string[];
    matchedSample: Array<{ number: string; value: string }>;
  }>;
  compareTarget?: { table: string; column: string };
  unseenOnly?: boolean;
}): Promise<EmailCensusResult> {
  const startedAt = Date.now();
  // A census defaults to EVERY configured mailbox, not the default one. Reading
  // only the default inbox would silently produce a partial count while the note
  // still claimed completeness — the precise failure this capability exists to
  // prevent. An explicit mailbox still narrows it.
  const targets =
    !opts.mailbox || opts.mailbox === "*" ? mailboxes() : [resolveMailbox(opts.mailbox)];
  const usable = targets.filter((m): m is NonNullable<typeof m> => Boolean(m));
  if (!usable.length) {
    throw new Error(
      `لم أجد بريدًا مطابقًا لـ «${opts.mailbox}». المتاح: ${mailboxListForDisplay() || "لا يوجد"}.`,
    );
  }
  const folder: EmailFolder = opts.folder ?? "inbox";

  const since = parseDateArg(opts.sinceDate);
  const before = parseDateArg(opts.beforeDate);
  const patterns = opts.numberPatterns?.length ? opts.numberPatterns : DEFAULT_NUMBER_PATTERNS;

  const perMailbox = await Promise.all(
    usable.map((m) =>
      scanOneMailbox(m.email, {
        from: opts.from,
        subject: opts.subject,
        query: opts.query,
        unseenOnly: opts.unseenOnly,
        since,
        before,
        folder,
        startedAt: Date.now(),
        patterns,
      }),
    ),
  );

  const all: EmailCensusMatch[] = perMailbox.flatMap((r) => r.matches);
  all.sort((a, b) => b.date.localeCompare(a.date));

  const byMailbox: Record<string, number> = {};
  for (const r of perMailbox) byMailbox[r.mailbox] = r.matches.length;

  const byMonth: Record<string, number> = {};
  for (const e of all) {
    const month = e.date.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + 1;
  }

  const senderCounts = new Map<string, number>();
  for (const e of all) {
    const addr = senderAddress(e.from) || e.from;
    senderCounts.set(addr, (senderCounts.get(addr) ?? 0) + 1);
  }
  const bySender = [...senderCounts.entries()]
    .map(([from, count]) => ({ from, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  // Distinct numbers, with one example message each — the identifiers the
  // operator actually reconciles against the system.
  const numberMap = new Map<string, EmailCensusNumber>();
  for (const e of all) {
    for (const n of e.numbers) {
      const hit = numberMap.get(n);
      if (hit) hit.count += 1;
      else
        numberMap.set(n, {
          number: n,
          count: 1,
          sample: {
            uid: e.uid,
            mailbox: e.mailbox,
            folder: e.folder,
            subject: e.subject,
            date: e.date,
          },
        });
    }
  }
  const allNumbers = [...numberMap.values()].sort((a, b) => a.number.localeCompare(b.number));
  const distinctNumbers = allNumbers.length;
  const numbersTruncated = distinctNumbers > CENSUS_NUMBER_CAP;

  const truncated = perMailbox.some((r) => r.truncated);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  let compare: EmailNumberComparison | undefined;
  if (opts.compare && opts.compareTarget) {
    // Reconcile against the FULL number set, not the capped sample: a number
    // missing from the system is exactly what the operator is hunting for, and
    // dropping it because the list was long would hide the answer.
    const res = await opts.compare(
      allNumbers.map((n) => n.number),
      opts.compareTarget,
    );
    // Attach the email that carried each missing number — a bare number is not
    // actionable, the subject and date are.
    const byNumber = numberMap;
    compare = {
      table: opts.compareTarget.table,
      column: opts.compareTarget.column,
      found: res.found,
      missing: res.missingNumbers.map((n) => {
        const sample = byNumber.get(n)?.sample;
        return {
          number: n,
          subject: sample?.subject ?? "",
          date: sample?.date ?? "",
          mailbox: sample?.mailbox ?? "",
        };
      }),
      matchedSample: res.matchedSample,
    };
  }

  const scope: EmailCensusScope = {
    folder,
    sinceDate: since ? since.toISOString() : null,
    beforeDate: before ? before.toISOString() : null,
    mailboxes: perMailbox.map((r) => ({
      mailbox: r.mailbox,
      scanned: r.scanned,
      truncated: r.truncated,
      serverNarrowed: r.narrowed,
    })),
    scanned: perMailbox.reduce((sum, r) => sum + r.scanned, 0),
    truncated,
    elapsedMs: Date.now() - startedAt,
  };

  return {
    matched: all.length,
    returned: Math.min(all.length, limit),
    emails: all.slice(0, limit),
    byMailbox,
    byMonth,
    bySender,
    numbers: allNumbers.slice(0, CENSUS_NUMBER_CAP),
    distinctNumbers,
    numbersTruncated,
    compare,
    scope,
    note: censusNote(scope, all.length),
  };
}

/**
 * The coverage caveat, stated for the model. A count is only a total when the
 * scan was complete; otherwise it is a lower bound, and saying so is what keeps
 * the answer honest.
 */
function censusNote(scope: EmailCensusScope, matched: number): string {
  const covered = scope.mailboxes
    .map((m) => `${m.mailbox}: ${m.scanned} رسالة${m.truncated ? " (ناقص)" : ""}`)
    .join("؛ ");
  const range =
    scope.sinceDate || scope.beforeDate
      ? ` الفترة: ${scope.sinceDate?.slice(0, 10) ?? "البداية"} ← ${scope.beforeDate?.slice(0, 10) ?? "الآن"}.`
      : " الفترة: كل البريد المتاح.";
  const base = `حصر كامل${range} تم فحص ${scope.scanned} رسالة (${covered}) وطابق ${matched}.`;
  if (scope.truncated) {
    return (
      base +
      " تحذير: لم تُفحص كل الرسائل في هذه الصناديق، فالعدد أعلاه حدّ أدنى وليس الإجمالي — " +
      "أعد الحصر بفترة أضيق (sinceDate/beforeDate) أو صندوق واحد."
    );
  }
  return base + " العدد أعلاه إجمالي وليس عيّنة.";
}

/** Parse a YYYY-MM-DD (or full ISO) argument; undefined when absent/unparseable. */
export function parseDateArg(value: string | undefined): Date | undefined {
  if (!value || !value.trim()) return undefined;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Census scan of a single mailbox. Envelope-only, chunked, budget-aware. */
async function scanOneMailbox(
  mailboxAddress: string,
  opts: {
    from?: string;
    subject?: string;
    query?: string;
    unseenOnly?: boolean;
    since?: Date;
    before?: Date;
    folder: EmailFolder;
    startedAt: number;
    patterns: string[];
  },
): Promise<{
  mailbox: string;
  matches: EmailCensusMatch[];
  scanned: number;
  truncated: boolean;
  /** False when the server-side narrowing failed and the whole box was read. */
  narrowed: boolean;
}> {
  // `mailboxAddress` MUST be forwarded or every mailbox in a fan-out reads the
  // default inbox (see `searchOneMailbox`).
  return withMailbox(async (client) => {
    const path = await resolveFolderPath(client, opts.folder);
    const lock = await client.getMailboxLock(path);
    try {
      const hasFrom = Boolean(opts.from?.trim());
      const hasSubject = Boolean(opts.subject?.trim());
      const hasQuery = Boolean(opts.query?.trim());

      // Narrow SERVER-SIDE first: this is what makes the whole mailbox reachable
      // within a sane budget. Measured on the live mailbox: a `from` search over
      // 3,875 messages takes ~0.2s versus ~4.5s to fetch every envelope.
      const criteria: Record<string, unknown> = {};
      if (hasFrom) criteria.from = opts.from!.trim();
      if (hasSubject) criteria.subject = opts.subject!.trim();
      if (opts.since) criteria.since = opts.since;
      if (opts.before) criteria.before = opts.before;
      if (opts.unseenOnly) criteria.seen = false;

      let uids =
        (await client.search(Object.keys(criteria).length ? criteria : { all: true }, {
          uid: true,
        })) || [];

      // A server-side narrowing that finds nothing could be a server quirk
      // (charset, display-name handling). Fall back to the whole mailbox so a
      // census never reports zero for mail that is present — the client-side
      // filters below then re-apply every criterion, so a fallback cannot widen
      // the result set.
      let narrowed = true;
      if (!uids.length && (hasFrom || hasSubject)) {
        uids = (await client.search({ all: true }, { uid: true })) || [];
        narrowed = false;
      }

      const window = uids.slice(-censusEnvelopeBudget());
      const matches: EmailCensusMatch[] = [];
      let scanned = 0;
      let truncated = uids.length > window.length;

      // Chunked so the time budget can be honoured mid-scan instead of after a
      // single unbounded fetch.
      for (let i = 0; i < window.length; i += CENSUS_CHUNK) {
        if (Date.now() - opts.startedAt > CENSUS_TIME_BUDGET_MS) {
          truncated = true;
          break;
        }
        const chunk = window.slice(i, i + CENSUS_CHUNK);
        for await (const msg of client.fetch(chunk, { uid: true, envelope: true }, { uid: true })) {
          scanned += 1;
          if (opts.unseenOnly && (msg.flags?.has("\\Seen") ?? false)) continue;
          const env = envelopeOf(msg, mailboxAddress, opts.folder);
          const haystack = `${env.subject} ${env.from} ${env.to}`;
          // EVERY criterion is re-verified client-side, dates included. The
          // server narrowing is an optimisation, not the source of truth: when
          // the fallback above triggers (or a server ignores a criterion), an
          // unverified scan silently returns the whole mailbox as the answer —
          // a March slice reported the full year's 3,710 messages that way.
          if (opts.since && new Date(env.date) < opts.since) continue;
          if (opts.before && new Date(env.date) >= opts.before) continue;
          if (hasFrom && !matchesAllTokens(env.from, opts.from!)) continue;
          if (hasSubject && !matchesAllTokens(env.subject, opts.subject!)) continue;
          if (hasQuery && !matchesAllTokens(haystack, opts.query!)) continue;
          matches.push({ ...env, numbers: [] });
        }
      }

      // Extraction happens after filtering, on the matched set only.
      for (const m of matches) {
        m.numbers = extractNumbers(m.subject, opts.patterns);
      }

      return { mailbox: mailboxAddress, matches, scanned, truncated, narrowed };
    } finally {
      lock.release();
    }
  }, mailboxAddress);
}

export interface ReadEmailLocation {
  /** Which mailbox the message lives in (UIDs are per-mailbox). */
  mailbox?: string;
  /** Which folder it lives in. */
  folder?: EmailFolder;
}

/**
 * Fetch a message by UID, trying each candidate mailbox in turn until one has it.
 *
 * A UID is only unique inside one folder of one mailbox, so `mailbox` says where
 * to look FIRST. Two things make the fallbacks necessary rather than optional:
 * the caller may omit the mailbox (a bare `read_email`), and the model may pass
 * a mailbox it inferred rather than the one the search actually tagged. Failing
 * the read outright in either case is what made an existing message look
 * unreadable ("مرفق هذه الرسالة" — a technical error).
 *
 * The requested mailbox is tried first, so the normal path costs one connection.
 * Only a genuine not-found advances to the next mailbox: a configuration or auth
 * failure would fail identically everywhere, and retrying it three times would
 * burn the operator's latency budget to report the same error.
 */
async function readFromCandidateMailboxes<T>(
  mailbox: string | undefined,
  read: (mailboxArg: string | undefined) => Promise<T>,
): Promise<T> {
  const preferred = resolveMailbox(mailbox);
  if (!preferred) return read(mailbox);

  const candidates = [
    preferred.email,
    ...mailboxes()
      .filter((m) => m.email !== preferred.email)
      .map((m) => m.email),
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await read(candidate);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Whether an error means "this mailbox does not hold that message".
 *
 * Matched on the message because `withMailbox` throws plain `Error`s (imapflow
 * supplies no typed not-found), and the imapflow fetch path reports absence the
 * same way. Anything else — auth, TLS, IMAP not configured — is a real fault
 * that the next mailbox would hit too, so the caller must not mask it.
 */
function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not found/i.test(msg);
}

/**
 * Fetch a single message by UID, returning the full text body + attachments.
 *
 * `mailbox` and `folder` must be the values the search returned: a UID is only
 * unique within one folder of one mailbox, so opening a UID from the wrong
 * mailbox returns a different message (or nothing).
 */
export async function readEmail(
  uid: number,
  mailbox?: string,
  folder: EmailFolder = "inbox",
): Promise<EmailDetail> {
  return readFromCandidateMailboxes(mailbox, (mailboxArg) =>
    readEmailFrom(mailboxArg, uid, folder),
  );
}

async function readEmailFrom(
  mailboxArg: string | undefined,
  uid: number,
  folder: EmailFolder,
): Promise<EmailDetail> {
  return withMailbox(async (client) => {
    const path = await resolveFolderPath(client, folder);
    const lock = await client.getMailboxLock(path);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, source: true },
        { uid: true },
      );
      if (!msg || !msg.source) throw new Error(`Email UID ${uid} not found`);
      const parsed = await simpleParser(msg.source as Buffer);
      const text = parsed.text || (parsed.html ? String(parsed.html) : "");
      const parsedDate =
        parsed.date instanceof Date ? parsed.date : new Date(parsed.date ?? Date.now());
      return {
        uid: msg.uid,
        mailbox: resolveMailbox(mailboxArg)?.email ?? mailboxArg ?? "",
        folder,
        from: parsed.from?.text || "",
        to: Array.isArray(parsed.to)
          ? parsed.to.map((t: { text: string }) => t.text).join(", ")
          : parsed.to?.text || "",
        subject: parsed.subject || "(بدون موضوع)",
        date: parsedDate.toISOString(),
        snippet: snippetOf(text),
        hasAttachments: (parsed.attachments?.length ?? 0) > 0,
        body: text.slice(0, 12_000),
        attachments: (parsed.attachments ?? []).map((a, i) => ({
          index: i,
          filename: a.filename ?? "attachment",
          mimeType: a.contentType ?? null,
          size: a.size ?? 0,
        })),
      };
    } finally {
      lock.release();
    }
  }, mailboxArg);
}

/**
 * Download one attachment's bytes from a message. `index`/`filename` pick which
 * one (see `selectAttachment`). Oversized attachments come back with
 * `oversized: true` and no content rather than blowing up the request.
 */
export async function readEmailAttachment(
  uid: number,
  opts: { index?: number; filename?: string } = {},
  mailbox?: string,
  folder: EmailFolder = "inbox",
): Promise<EmailAttachmentContent> {
  return readFromCandidateMailboxes(mailbox, (mailboxArg) =>
    readEmailAttachmentFrom(mailboxArg, uid, opts, folder),
  );
}

async function readEmailAttachmentFrom(
  mailboxArg: string | undefined,
  uid: number,
  opts: { index?: number; filename?: string },
  folder: EmailFolder,
): Promise<EmailAttachmentContent> {
  return withMailbox(async (client) => {
    const path = await resolveFolderPath(client, folder);
    const lock = await client.getMailboxLock(path);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, source: true },
        { uid: true },
      );
      if (!msg || !msg.source) throw new Error(`Email UID ${uid} not found`);
      const parsed = await simpleParser(msg.source as Buffer);
      const metas: EmailAttachmentMeta[] = (parsed.attachments ?? []).map((a, i) => ({
        index: i,
        filename: a.filename ?? "attachment",
        mimeType: a.contentType ?? null,
        size: a.size ?? 0,
      }));
      const chosen = selectAttachment(metas, opts);
      const raw = parsed.attachments[chosen.index];
      const size = chosen.size || raw?.content?.length || 0;
      if (size > MAX_ATTACHMENT_BYTES) {
        return { ...chosen, size, content: null, oversized: true };
      }
      return { ...chosen, size, content: raw?.content ?? null, oversized: false };
    } finally {
      lock.release();
    }
  }, mailboxArg);
}

/** Send an email via the shared SMTP transport. */
export async function sendAssistantEmail(opts: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
}): Promise<void> {
  // The assistant is the sender most likely to be misconfigured (its own env
  // fallbacks) and the one whose mail people reply to conversationally, so it
  // must use the shared identity rather than deriving its own.
  assertCanSend();
  const { default: nodemailer } = await import("nodemailer");
  const rawHost = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT) || 587;
  const host = await resolveIpv4(rawHost);
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { servername: rawHost, rejectUnauthorized: false },
  });
  const identity = senderIdentity();
  if (!identity.email) throw new Error("لا يوجد بريد مُرسِل مُهيّأ (SMTP_USER/SMTP_FROM_EMAIL).");
  await transporter.sendMail({
    from: fromHeader(),
    replyTo: replyToHeader(),
    to: opts.to,
    cc: opts.cc,
    subject: opts.subject,
    text: opts.body,
  });
  logger.info(
    { to: opts.to, subject: opts.subject, from: identity.email },
    "AI assistant: email sent",
  );
}

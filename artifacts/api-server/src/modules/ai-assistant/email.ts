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

const SMTP_TIMEOUT_MS = 15000;
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
 * True when IMAP reading is usable. All THREE of host/user/pass are required —
 * checking only host+user would report "configured" for a partially-set
 * mailbox (e.g. SMTP_PASS unset) and then fail at login with a confusing
 * authentication error instead of the clear "not configured" path.
 */
export function isEmailReadConfigured(): boolean {
  const cfg = imapConfig();
  return Boolean(cfg.host && cfg.user && cfg.pass);
}

async function withMailbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const cfg = imapConfig();
  if (!isEmailReadConfigured()) {
    // Arabic so the model relays a clear message to the operator instead of
    // echoing an English env-var hint.
    throw new Error(
      "قراءة البريد غير مهيّأة على الخادم (مطلوب SMTP_HOST/SMTP_USER/SMTP_PASS أو IMAP_HOST/IMAP_USER/IMAP_PASS).",
    );
  }
  const host = await resolveIpv4(cfg.host as string);
  const client = new ImapFlow({
    host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.user as string,
      pass: cfg.pass as string,
    },
    tls: {
      servername: cfg.host as string,
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

export interface EmailSummary {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  hasAttachments: boolean;
}

export interface EmailDetail extends EmailSummary {
  body: string;
  attachments: Array<{ filename: string; mimeType: string | null; size: number }>;
}

function snippetOf(text: string, len = 200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, len);
}

/** Search recent messages. `query` matches subject/from/body text loosely. */
export async function searchEmails(opts: {
  query?: string;
  from?: string;
  sinceDays?: number;
  limit?: number;
  mailbox?: string;
  unseenOnly?: boolean;
}): Promise<EmailSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 30);
  const sinceDays = Math.min(Math.max(opts.sinceDays ?? 14, 1), 180);
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  return withMailbox(async (client) => {
    const mailbox = opts.mailbox || "INBOX";
    const lock = await client.getMailboxLock(mailbox);
    try {
      const search: Record<string, unknown> = { since };
      if (opts.from) search.from = opts.from;
      if (opts.unseenOnly) search.seen = false;
      if (opts.query) search.or = [{ subject: opts.query }, { body: opts.query }];

      const uids = (await client.search(search, { uid: true })) || [];
      const picked = uids.slice(-limit).reverse();
      const out: EmailSummary[] = [];
      if (picked.length === 0) return out;
      for await (const msg of client.fetch(
        picked,
        { uid: true, envelope: true, source: true, bodyStructure: true },
        { uid: true },
      )) {
        let text = "";
        let hasAttachments = false;
        try {
          const parsed = await simpleParser(msg.source as Buffer);
          text = parsed.text || (parsed.html ? String(parsed.html) : "");
          hasAttachments = (parsed.attachments?.length ?? 0) > 0;
        } catch {
          /* keep envelope-only summary */
        }
        out.push({
          uid: msg.uid,
          from:
            msg.envelope?.from?.map((a) => `${a.name ?? ""} <${a.address ?? ""}>`).join(", ") || "",
          to: msg.envelope?.to?.map((a) => a.address ?? "").join(", ") || "",
          subject: msg.envelope?.subject || "(بدون موضوع)",
          date: (() => {
            const d = msg.envelope?.date;
            return d instanceof Date ? d.toISOString() : new Date(d ?? Date.now()).toISOString();
          })(),
          snippet: snippetOf(text),
          hasAttachments,
        });
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

/** Fetch a single message by UID, returning the full text body + attachments. */
export async function readEmail(uid: number, mailbox = "INBOX"): Promise<EmailDetail> {
  return withMailbox(async (client) => {
    const lock = await client.getMailboxLock(mailbox);
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
        from: parsed.from?.text || "",
        to: Array.isArray(parsed.to)
          ? parsed.to.map((t: { text: string }) => t.text).join(", ")
          : parsed.to?.text || "",
        subject: parsed.subject || "(بدون موضوع)",
        date: parsedDate.toISOString(),
        snippet: snippetOf(text),
        hasAttachments: (parsed.attachments?.length ?? 0) > 0,
        body: text.slice(0, 12_000),
        attachments: (parsed.attachments ?? []).map((a) => ({
          filename: a.filename ?? "attachment",
          mimeType: a.contentType ?? null,
          size: a.size ?? 0,
        })),
      };
    } finally {
      lock.release();
    }
  });
}

/** Send an email via the shared SMTP transport. */
export async function sendAssistantEmail(opts: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
}): Promise<void> {
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
  const from = process.env.SMTP_USER || "info@cortoba-supplies.com";
  await transporter.sendMail({
    from,
    to: opts.to,
    cc: opts.cc,
    subject: opts.subject,
    text: opts.body,
  });
  logger.info({ to: opts.to, subject: opts.subject }, "AI assistant: email sent");
}

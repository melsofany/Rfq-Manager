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
import pdfParse from "pdf-parse/lib/pdf-parse.js";
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

/**
 * Short-lived result cache for the expensive mailbox reads.
 *
 * A follow-up question about the SAME mail («ليه السخانات الأريستون مش في
 * التقرير؟» right after «اكتر بند اتكرر») re-ran the whole scan — measured live
 * at ~30s for a 400-message item census, and up to ~100s for 1000 — so a second
 * question blew the agent's 150s ceiling and answered with a timeout. Mail does
 * not change in the seconds between two questions, so the result is reused.
 *
 * Deliberately short (see `cacheTtlMs`) and bounded, and only ever applied to
 * read-only scans — a stale entry can at worst report mail that arrived moments
 * ago as missing, which the TTL keeps to a single conversation turn.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}
const scanCache = new Map<string, CacheEntry<unknown>>();
const SCAN_CACHE_MAX = 24;

/** How long a scan result stays warm. Overridable so tests can disable it. */
export function cacheTtlMs(): number {
  return Number(process.env.AI_SCAN_CACHE_TTL_MS ?? 5 * 60 * 1000);
}

export function clearScanCache(): void {
  scanCache.clear();
}

/**
 * Read a cached value without producing one.
 *
 * A resumable scan needs to READ its session (to continue it) without the
 * producer semantics of `memoizeScan`, which would recompute on a miss. A miss
 * here means "no session yet", which is exactly the first batch.
 */
export function getScanCacheEntry<T>(key: string): T | undefined {
  const ttl = cacheTtlMs();
  if (ttl <= 0) return undefined;
  const hit = scanCache.get(key) as CacheEntry<T> | undefined;
  if (!hit || hit.expiresAt <= Date.now()) return undefined;
  return hit.value;
}

/** Store a value under `key`, evicting the oldest entry when the cache is full. */
export function putScanCacheEntry<T>(key: string, value: T): void {
  const ttl = cacheTtlMs();
  if (ttl <= 0) return;
  if (scanCache.size >= SCAN_CACHE_MAX) {
    const oldest = scanCache.keys().next().value;
    if (oldest !== undefined) scanCache.delete(oldest);
  }
  scanCache.set(key, { value, expiresAt: Date.now() + ttl });
}

/**
 * Persist a scan session to Postgres so a restart resumes instead of restarting.
 *
 * Best-effort and fire-and-forget: the in-memory cache is the fast path and the
 * source of truth while the process lives, so a database hiccup must never fail
 * the scan. Writes are coalesced per key (the census writes after every parsed
 * chunk) so a long scan does not issue a statement per chunk.
 */
const persisting = new Set<string>();
export function persistScanSession(key: string, session: unknown): void {
  if (!process.env.DATABASE_URL || persisting.has(key)) return;
  persisting.add(key);
  void (async () => {
    try {
      const db = await scanSessionStore();
      if (!db) return;
      await db.save(key, session);
    } catch {
      // Ignored on purpose — persistence is an optimisation, not a requirement.
    } finally {
      persisting.delete(key);
    }
  })();
}

/** Load a persisted session (used when the in-memory cache misses after a restart). */
export async function loadPersistedScanSession<T>(key: string): Promise<T | undefined> {
  if (!process.env.DATABASE_URL) return undefined;
  try {
    const db = await scanSessionStore();
    return db ? ((await db.load(key)) as T | undefined) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Drop every persisted scan session.
 *
 * A reset («ابدأ من جديد») means the operator wants NO prior result reused, and
 * the in-process cache is only half the state: the Postgres mirror would let the
 * next question resume a census — and reuse the row set — produced before the
 * reset. Clearing the memory cache alone therefore looked like a reset while the
 * old results were still reachable, which is the same class of silent
 * wrong-answer this assistant keeps having to be cured of.
 */
export async function clearPersistedScanSessions(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    const { db, aiAssistantScanSessionsTable } = await import("@workspace/db");
    await db.delete(aiAssistantScanSessionsTable);
  } catch {
    // Best-effort: the in-memory cache is already cleared, and a reset must not
    // fail the operator's message.
  }
}

/**
 * The scan-session store, resolved once. `@workspace/db` is imported lazily so
 * this module stays importable (and testable) without a live database, and its
 * absence simply disables persistence.
 */
let storePromise: Promise<ScanSessionStore | null> | undefined;
interface ScanSessionStore {
  save(key: string, session: unknown): Promise<void>;
  load(key: string): Promise<unknown>;
  remove(key: string): Promise<void>;
}
async function scanSessionStore(): Promise<ScanSessionStore | null> {
  if (!storePromise) {
    storePromise = (async () => {
      try {
        const { db, aiAssistantScanSessionsTable } = await import("@workspace/db");
        const { eq } = await import("drizzle-orm");
        return {
          save: async (key, session) => {
            await db
              .insert(aiAssistantScanSessionsTable)
              .values({ key, session, updatedAt: new Date() })
              .onConflictDoUpdate({
                target: aiAssistantScanSessionsTable.key,
                set: { session, updatedAt: new Date() },
              });
          },
          load: async (key) => {
            const rows = await db
              .select()
              .from(aiAssistantScanSessionsTable)
              .where(eq(aiAssistantScanSessionsTable.key, key))
              .limit(1);
            return rows[0]?.session;
          },
          remove: async (key) => {
            await db
              .delete(aiAssistantScanSessionsTable)
              .where(eq(aiAssistantScanSessionsTable.key, key));
          },
        } satisfies ScanSessionStore;
      } catch {
        return null;
      }
    })();
  }
  return storePromise;
}

/** Stable string key for a scan's options — argument order must not matter. */
export function scanCacheKey(prefix: string, opts: Record<string, unknown>): string {
  const norm: Record<string, unknown> = {};
  for (const k of Object.keys(opts).sort()) {
    const v = opts[k];
    if (v === undefined || v === null || v === "" || v === false) continue;
    // Functions (compare callbacks) are identified by name so two callers that
    // pass different comparators never share an entry.
    norm[k] = typeof v === "function" ? `fn:${(v as { name?: string }).name || "anon"}` : v;
  }
  return `${prefix}:${JSON.stringify(norm)}`;
}

/**
 * Run `produce` once per key within the TTL window.
 *
 * Exported so the tool layer can memoize a small DERIVED result (e.g. the
 * aggregated item summary) without retaining the downloaded PDF buffers the
 * heavy scan produced — those are ~35MB per scan and must not be kept around.
 */
export async function memoizeScan<T>(key: string, produce: () => Promise<T>): Promise<T> {
  const ttl = cacheTtlMs();
  if (ttl > 0) {
    const hit = scanCache.get(key) as CacheEntry<T> | undefined;
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }
  const value = await produce();
  if (ttl > 0) {
    // Evict the oldest entry once bounded rather than growing without limit —
    // the process is long-lived and every distinct question adds a key.
    if (scanCache.size >= SCAN_CACHE_MAX) {
      const oldest = scanCache.keys().next().value;
      if (oldest !== undefined) scanCache.delete(oldest);
    }
    scanCache.set(key, { value, expiresAt: Date.now() + ttl });
  }
  return value;
}

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

/**
 * Resolve a sender filter that matched nothing to the address the mail really
 * carries.
 *
 * A census with `from` is narrowed SERVER-SIDE, so a filter the server does not
 * recognise («EDC» is nobody's address, and no display name either) returns
 * empty — and the caller then cannot tell "no mail from this company" from "I
 * searched the wrong string". Live, that produced «no readable PO attachments»
 * over 3,688 real EDC messages whose SUBJECTS all read «EDC PO No …».
 *
 * So resolution is driven by the OPERATOR'S WORD, not by string distance on an
 * address: the caller supplies the senders of the messages that word matches
 * (subject OR sender), and the dominant sender among them is the company the
 * operator means. Pure and deterministic so the rule is testable:
 *  - no candidate senders ⇒ `resolved: null`, so the caller reports what it saw
 *    rather than substituting a sender of its own choosing;
 *  - candidates on two different domains with comparable volume ⇒ null, because
 *    answering about the wrong company is worse than asking which one.
 */
export function resolveSenderFromCandidates(
  requested: string,
  senders: Array<{ from: string; count: number }>,
): { resolved: string | null; domain: string | null; candidates: string[] } {
  const term = (requested ?? "").trim();
  if (!term) return { resolved: null, domain: null, candidates: [] };

  const scored: Array<{ address: string; count: number }> = [];
  for (const s of senders) {
    const addr = senderAddress(s.from);
    if (!addr) continue;
    scored.push({ address: addr, count: s.count });
  }
  if (!scored.length) return { resolved: null, domain: null, candidates: [] };

  // Merge senders on the SAME domain: a company writes from `noreply@` and from
  // individuals' mailboxes, and every one of them is the same correspondent.
  // Counts SUM per domain; the address reported is the busiest one on it.
  const byDomain = new Map<string, { address: string; count: number; top: number }>();
  for (const s of scored) {
    const domain = s.address.slice(s.address.lastIndexOf("@") + 1);
    const hit = byDomain.get(domain);
    if (!hit) byDomain.set(domain, { address: s.address, count: s.count, top: s.count });
    else {
      hit.count += s.count;
      if (s.count > hit.top) {
        hit.top = s.count;
        hit.address = s.address;
      }
    }
  }
  const domains = [...byDomain.entries()]
    .map(([domain, v]) => ({ domain, ...v }))
    .sort((a, b) => b.count - a.count || a.address.localeCompare(b.address));
  const best = domains[0];
  const rival = domains[1];
  if (rival && rival.count >= best.count / 4) {
    return {
      resolved: null,
      domain: null,
      candidates: domains.slice(0, 8).map((d) => d.address),
    };
  }
  // `domain` travels with the answer because the COMPANY is the unit the operator
  // named, not one mailbox on it: filtering on `resolved` alone would drop the
  // colleagues' mail (live EDC: 3,610 from `noreply@` plus 62 from two people).
  return { resolved: best.address, domain: best.domain, candidates: [] };
}

/**
 * Sender histogram for a set of matches, keyed on the ADDRESS.
 *
 * The address (not the display name) is what a follow-up filter must use: the
 * same company writes from `noreply@` and from people's mailboxes, and every one
 * of them is the same company. Shared by `bySender` aggregation and the
 * sender-resolution fallback so both describe senders the same way.
 */
export function aggregateSenders(
  matches: Array<{ from: string }>,
): Array<{ from: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of matches) {
    const addr = senderAddress(e.from) || e.from;
    if (!addr) continue;
    counts.set(addr, (counts.get(addr) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([from, count]) => ({ from, count }))
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
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

/**
 * What happened to a sender filter that matched nothing.
 *
 * Present only when `from` produced zero matches — the case where "no mail from
 * this company" and "I searched the wrong string" are indistinguishable. When
 * `resolved` is set the census was re-run for that address and the counts
 * describe the CORRECTED set; otherwise the caller must tell the operator the
 * filter was not recognised, and name the senders actually seen.
 */
export interface EmailSenderResolution {
  /** The filter as the caller supplied it. */
  requested: string;
  /** The real sender address it resolved to, or null when unresolvable. */
  resolved: string | null;
  /**
   * The domain the resolved address belongs to.
   *
   * The matches are filtered on the DOMAIN, because the operator named a COMPANY
   * and its colleagues' mailboxes are that company — filtering on the single
   * `resolved` address would drop them (live EDC: 3,610 from `noreply@` plus 62
   * from two individuals, all EDC orders).
   */
  domain?: string | null;
  /** Messages matched for the resolved company (0 when unresolved). */
  matched: number;
  /** Plural candidate addresses when the filter was ambiguous. */
  candidates: string[];
  /** Senders actually observed, for an actionable "did you mean" reply. */
  observed?: string[];
}

/** One distinct document number found in the census, with an example message. */
export interface EmailCensusNumber {
  number: string;
  count: number;
  sample: { uid: number; mailbox: string; folder: EmailFolder; subject: string; date: string };
  /** Where the number was found: the subject, or inside a PDF attachment. */
  source?: "subject" | "attachment";
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
  /** Present when a `from` filter matched nothing and had to be resolved. */
  senderResolution?: EmailSenderResolution;
  /** Present when `includeAttachments` was set — how much of the mail was opened. */
  attachmentCoverage?: AttachmentCoverage;
  /**
   * The downloaded attachments, for an internal caller that wants to parse them
   * too (the item census). NEVER send this to the model — the tool strips it.
   */
  attachmentMessages?: MessageAttachments[];
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

/**
 * One PDF text row, reconstructed from the glyph positions on the page.
 *
 * pdf-parse's default renderer concatenates items in reading order WITHOUT a
 * separator, so "Line No." becomes "LineNo." and a table row's columns run
 * together ("124Each5720.001."). Rebuilding each visual line from the item
 * coordinates (items share a baseline; `transform[4]` is x, `transform[5]` is y)
 * keeps columns separable, which is what makes the line-item tables of the EDC
 * RFQ/PO attachments parseable at all.
 */
async function renderPdfPage(pageData: unknown): Promise<string> {
  const page = pageData as {
    getTextContent: (opts?: Record<string, unknown>) => Promise<{
      items?: Array<{ str?: string; transform?: number[] }>;
    }>;
  };
  const content = await page.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });
  const rows: Array<{ y: number; parts: Array<{ x: number; str: string }> }> = [];
  for (const item of content.items ?? []) {
    const str = (item.str ?? "").trim();
    if (!str) continue;
    const t = item.transform ?? [1, 0, 0, 1, 0, 0];
    const x = Number(t[4] ?? 0);
    const y = Number(t[5] ?? 0);
    const row = rows.find((r) => Math.abs(r.y - y) < 2);
    if (row) row.parts.push({ x, str });
    else rows.push({ y, parts: [{ x, str }] });
  }
  return rows
    .map((r) =>
      r.parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.str)
        .join(" "),
    )
    .join("\n");
}

/**
 * Read a PDF's text LOCALLY, with no model call.
 *
 * The Gemini `inline_data` path is the fallback for scanned documents and
 * images, but it is quota-limited (20 requests/day/model) and returns null the
 * moment the day's budget is spent — which is how a request for an EDC
 * attachment ended as «تعذّر معالجة طلبك». A text-layer PDF (which is what EDC
 * sends) needs no model at all, so this runs first for bulk work and as the
 * fallback for a single attachment.
 *
 * Returns "" when the file has no text layer (a scan) or cannot be parsed, so
 * the caller reports "could not read" instead of inventing content.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const res = await pdfParse(buffer, { pagerender: renderPdfPage });
    return (res.text || "").replace(/\n{3,}/g, "\n\n").trim();
  } catch (err) {
    logger.warn({ err }, "AI assistant: local PDF text extraction failed");
    return "";
  }
}

/**
 * Whether the BYTES are a PDF, by magic number.
 *
 * The declared MIME type is not trustworthy evidence of the content. EDC's
 * «Quotation Import» / «RFQ» notices label their PDF attachments
 * `application/doc` (verified on live mail: 281 of 305 EDC attachments), so a
 * filter that accepted only `application/pdf` scanned a whole year of mail and
 * opened nothing — the assistant then truthfully reported that the item tables
 * were inside files it could not read. Content is the only signal that cannot
 * be mislabelled, so it is checked whenever the bytes are available.
 */
export function isPdfContent(buffer: Buffer | null | undefined): boolean {
  if (!buffer || buffer.length < 5) return false;
  return buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

/**
 * Whether an attachment is a PDF, using every available signal.
 *
 * MIME, filename and magic bytes are ORed rather than demanded together: the
 * declared type is the MOST likely to be wrong (see `isPdfContent`), the
 * extension is what a human sees, and the bytes are only present once the
 * attachment has been fetched. Requiring all three would keep EDC's mail
 * unreadable, which is the exact failure being fixed.
 */
export function isPdfAttachment(a: {
  mimeType?: string | null;
  filename?: string | null;
  content?: Buffer | null;
}): boolean {
  if ((a.mimeType ?? "").trim().toLowerCase() === "application/pdf") return true;
  if (/\.pdf$/i.test((a.filename ?? "").trim())) return true;
  return isPdfContent(a.content);
}

/**
 * Messages whose attachments are opened per census.
 *
 * Envelope+body fetch is the expensive part (measured live: ~67ms/message on
 * EDC's 35KB PDFs, so 400 messages ≈ 27s). The default is set so a year of a
 * genuinely large sender fits inside one call: this mailbox matched 3,749
 * messages from a single sender, and the previous 120-message cap analysed a
 * thirty-second of it while reporting a total. Overridable so the truncation
 * path is testable.
 */
export function attachmentScanBudget(): number {
  // Raised from 400 after a live report: a mailbox matched 480 messages and the
  // pass opened only 381 of them while the answer read as a full census. The
  // message cap is a safety valve, not a sampling strategy, so it now sits well
  // above a realistic year of orders. When a mailbox genuinely exceeds it the
  // time budget bites first and `coverage.truncated` reports the shortfall —
  // the operator is told the scan was partial instead of being shown a sample.
  return Number(process.env.AI_ATTACHMENT_SCAN_BUDGET) || 1_200;
}

/**
 * Wall-clock ceiling for ONE attachment fetch pass.
 *
 * One pass is one BATCH of a resumable scan, so this is pacing, not a limit on
 * completeness: when it bites, the cursor stops and the next call continues.
 * Set comfortably below the per-call scan budget in the tool layer (45s) so a
 * batch returns its own honest "partial" result instead of being cut by the
 * generic per-tool timeout. Overridable so the truncation path is testable.
 */
function attachmentScanTimeBudget(): number {
  return Number(process.env.AI_ATTACHMENT_TIME_BUDGET_MS) || 40_000;
}

/** Coverage of an attachment pass — never report a partial read as complete. */
export interface AttachmentCoverage {
  /** Matched messages the pass considered. */
  messages: number;
  /** Messages whose attachments were downloaded and parsed. */
  scanned: number;
  /** Messages with at least one readable PDF. */
  readable: number;
  /** Messages that could not be downloaded or had no readable attachment. */
  unreadable: number;
  /** PDF attachments opened. */
  attachments: number;
  /** True when the budget stopped the pass short of every matched message. */
  truncated: boolean;
  /**
   * Matched messages this pass did NOT reach (because of the count cap or the
   * clock). Lets a resumable caller ask for the next window instead of
   * presenting the first batch as the whole year.
   */
  remaining?: number;
  /**
   * Exclusive index into the matched list where the next resumable call should
   * start. Advances by exactly the messages this pass fetched, so consecutive
   * batches tile the whole set without overlap or gaps.
   */
  nextSkip?: number;
  /**
   * WHY the pass stopped: `count` when the message cap was reached, `time` when
   * the wall-clock ceiling was. Null when the pass was complete. The model must
   * quote this instead of guessing a cause — a live answer invented «الحد 400»
   * because the reason was not exposed and it filled the gap.
   */
  truncatedReason?: "count" | "time" | "error" | null;
}

/** The attachments of one message, ready for local parsing. */
export interface MessageAttachments {
  uid: number;
  mailbox: string;
  folder: EmailFolder;
  subject: string;
  date: string;
  from: string;
  attachments: Array<{ filename: string; mimeType: string | null; content: Buffer | null }>;
}

/**
 * Download the attachments of the matched messages.
 *
 * This is the ONE place the mail is opened for content, so the number census
 * (numbers hidden in the PDF) and the item census (the line tables) share a
 * single IMAP pass instead of doubling the connections. Grouped by mailbox — a
 * UID is unique only inside one mailbox — and chunked so the time budget can be
 * honoured mid-pass rather than after an unbounded fetch.
 */
export async function fetchMessageAttachments(
  matches: EmailCensusMatch[],
  budget = attachmentScanBudget(),
  skip = 0,
): Promise<{ messages: MessageAttachments[]; coverage: AttachmentCoverage }> {
  // The caller's set is the matched list. `skip` walks FORWARD from the previous
  // batch's end so a large year is read in resumable windows: each call opens
  // the next slice instead of re-opening the same newest one. The list is fixed
  // for the life of a scan session, so windows do not overlap or leave gaps.
  const start = Math.max(0, skip);
  const considered = matches.slice(start, start + budget);
  const notReached = Math.max(0, matches.length - start - considered.length);
  const coverage: AttachmentCoverage = {
    messages: considered.length,
    scanned: 0,
    readable: 0,
    unreadable: 0,
    attachments: 0,
    truncated: notReached > 0,
    truncatedReason: notReached > 0 ? "count" : null,
    remaining: notReached,
  };
  const out: MessageAttachments[] = [];

  const byMailbox = new Map<string, EmailCensusMatch[]>();
  for (const m of considered) {
    const list = byMailbox.get(m.mailbox) ?? [];
    list.push(m);
    byMailbox.set(m.mailbox, list);
  }

  const startedAt = Date.now();
  for (const [mailboxAddress, group] of byMailbox) {
    if (Date.now() - startedAt > attachmentScanTimeBudget()) {
      coverage.truncated = true;
      coverage.truncatedReason = "time";
      break;
    }
    try {
      await withMailbox(async (client) => {
        const path = await resolveFolderPath(client, group[0].folder);
        const lock = await client.getMailboxLock(path);
        try {
          const uids = group.map((m) => m.uid);
          for (let i = 0; i < uids.length; i += 25) {
            if (Date.now() - startedAt > attachmentScanTimeBudget()) {
              coverage.truncated = true;
              coverage.truncatedReason = "time";
              break;
            }
            const chunk = uids.slice(i, i + 25);
            for await (const msg of client.fetch(
              chunk,
              { uid: true, source: true },
              { uid: true },
            )) {
              coverage.scanned += 1;
              const source = (msg as { source?: Buffer }).source;
              const match = group.find((m) => m.uid === msg.uid);
              if (!source) {
                coverage.unreadable += 1;
                continue;
              }
              try {
                const parsed = await simpleParser(source);
                // Match on content as well as the declared type: EDC labels its
                // PDFs `application/doc`, so an exact-mime filter silently found
                // nothing and the whole census came back empty.
                const attachments = (parsed.attachments ?? [])
                  .filter((a) =>
                    isPdfAttachment({
                      mimeType: a.contentType,
                      filename: a.filename,
                      content: a.content as Buffer,
                    }),
                  )
                  .map((a) => ({
                    filename: a.filename ?? "attachment.pdf",
                    mimeType: a.contentType ?? null,
                    content: (a.content as Buffer) ?? null,
                  }));
                coverage.attachments += attachments.length;
                if (attachments.length) coverage.readable += 1;
                else coverage.unreadable += 1;
                out.push({
                  uid: msg.uid,
                  mailbox: mailboxAddress,
                  folder: group[0].folder,
                  subject: match?.subject ?? parsed.subject ?? "",
                  date: match?.date ?? "",
                  from: match?.from ?? parsed.from?.text ?? "",
                  attachments,
                });
              } catch {
                coverage.unreadable += 1;
              }
            }
          }
        } finally {
          lock.release();
        }
      }, mailboxAddress);
    } catch (err) {
      logger.warn({ err, mailbox: mailboxAddress }, "AI assistant: attachment fetch failed");
      coverage.truncated = true;
      coverage.truncatedReason = "error";
    }
  }

  // How far the cursor advanced. `scanned` is the number of messages actually
  // fetched — fewer than `considered` only when the clock stopped a chunk early,
  // and those unread messages are deliberately retried by the next batch rather
  // than counted as done.
  coverage.nextSkip = start + coverage.scanned;
  coverage.remaining = Math.max(0, matches.length - coverage.nextSkip);
  if (coverage.remaining > 0) {
    coverage.truncated = true;
    coverage.truncatedReason = coverage.truncatedReason ?? "time";
  } else {
    coverage.truncatedReason = null;
  }

  return { messages: out, coverage };
}

/** Max distinct numbers returned before the list is declared truncated. */
const CENSUS_NUMBER_CAP = 400;

/**
 * Document numbers found INSIDE the attachments, not just in the subject.
 *
 * EDC's «Quotation Import» notices carry the number in the document, so a
 * subject-only census under-counts them. Returns census-shaped rows so the
 * caller can merge them without a second code path. Lives here (not in
 * `email-items`) so `scanEmails` does not depend on the item parser.
 */
async function numbersInAttachments(
  messages: MessageAttachments[],
  patterns: string[],
): Promise<EmailCensusNumber[]> {
  const map = new Map<string, EmailCensusNumber>();
  for (const message of messages) {
    for (const att of message.attachments) {
      if (!att.content) continue;
      const text = await extractPdfText(att.content);
      if (!text) continue;
      for (const n of extractNumbers(text, patterns)) {
        const hit = map.get(n);
        if (hit) hit.count += 1;
        else
          map.set(n, {
            number: n,
            count: 1,
            source: "attachment",
            sample: {
              uid: message.uid,
              mailbox: message.mailbox,
              folder: message.folder,
              subject: message.subject,
              date: message.date,
            },
          });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.number.localeCompare(b.number));
}

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
  /**
   * Also open each matched message's PDF attachments and extract numbers from
   * them. A subject-only census cannot see a number that lives inside the
   * document (EDC's «Quotation Import» notices), so it under-counts. Bounded by
   * `attachmentScanBudget()` and reported via `attachmentCoverage`.
   */
  includeAttachments?: boolean;
  /**
   * Exclusive index into the matched list at which to begin the attachment pass.
   * A resumable caller advances it by the window it actually read, so a year too
   * large for one pass is read in successive windows without overlap or gaps.
   */
  attachmentSkip?: number;
  /**
   * Return every matched envelope to an internal aggregation caller. The public
   * tool still caps `emails` at `limit`; a year-wide item census must not inherit
   * that cap and accidentally analyse only the newest 500 messages.
   */
  returnAllMatches?: boolean;
  unseenOnly?: boolean;
}): Promise<EmailCensusResult> {
  // Cache the whole scan (including the downloaded attachments when
  // `includeAttachments` is set). Without this a follow-up question about the
  // same mail re-ran a ~30-100s scan and timed the answer out. Accesses
  // (timestamps) are not part of the key so the cached envelopes keep working.
  //
  // A scan WITH attachments is NOT cached here: its result carries every
  // downloaded PDF buffer (~35MB per run), which must not be held in a
  // long-lived process. The item census memoizes its small DERIVED result
  // instead (see `scan_email_items` in tools.ts).
  if (opts.includeAttachments) return runScanEmails(opts);
  const key = scanCacheKey("census", {
    from: opts.from,
    subject: opts.subject,
    query: opts.query,
    sinceDate: opts.sinceDate,
    beforeDate: opts.beforeDate,
    mailbox: opts.mailbox,
    folder: opts.folder,
    limit: opts.limit,
    includeAttachments: opts.includeAttachments,
    returnAllMatches: opts.returnAllMatches,
    unseenOnly: opts.unseenOnly,
    compareTarget: opts.compareTarget,
    patterns: (opts.numberPatterns ?? DEFAULT_NUMBER_PATTERNS).join("|"),
  });
  return memoizeScan(key, () => runScanEmails(opts));
}

async function runScanEmails(opts: {
  from?: string;
  subject?: string;
  query?: string;
  sinceDate?: string;
  beforeDate?: string;
  mailbox?: string;
  folder?: EmailFolder;
  limit?: number;
  numberPatterns?: string[];
  compare?: (
    numbers: string[],
    target: { table: string; column: string },
  ) => Promise<{
    found: number;
    missingNumbers: string[];
    matchedSample: Array<{ number: string; value: string }>;
  }>;
  compareTarget?: { table: string; column: string };
  includeAttachments?: boolean;
  attachmentSkip?: number;
  returnAllMatches?: boolean;
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

  // The ENVELOPE result is memoized across the resumable attachment windows.
  //
  // `attachmentSkip` moves the window, but the matched list itself is fixed for
  // the life of one census — yet every `scan_email_items` batch called this with
  // `includeAttachments: true` and paid for a full envelope re-scan, plus a
  // second full-mailbox pass whenever a sender shorthand had to be resolved. A
  // live background job spent ~40 minutes "running" for that reason alone. The
  // key EXCLUDES `attachmentSkip`, so all the windows of one census reuse the
  // same envelopes (and the same sender resolution).
  const envelopeKey = scanCacheKey("envelope", {
    from: opts.from,
    subject: opts.subject,
    query: opts.query,
    sinceDate: opts.sinceDate,
    beforeDate: opts.beforeDate,
    mailbox: opts.mailbox,
    folder,
    unseenOnly: opts.unseenOnly,
    patterns: patterns.join("|"),
  });
  type MailboxEnvelope = Awaited<ReturnType<typeof scanOneMailbox>>;
  const cachedEnvelope = getScanCacheEntry<{
    all: EmailCensusMatch[];
    perMailbox: MailboxEnvelope[];
    senderResolution?: EmailSenderResolution;
  }>(envelopeKey);

  let perMailbox: MailboxEnvelope[] = cachedEnvelope
    ? cachedEnvelope.perMailbox
    : await Promise.all(
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
  let all: EmailCensusMatch[] = cachedEnvelope
    ? cachedEnvelope.all
    : perMailbox.flatMap((r) => r.matches);
  let senderResolution: EmailSenderResolution | undefined = cachedEnvelope?.senderResolution;

  if (!cachedEnvelope) {
    /*
     * A sender filter that matched NOTHING is the failure this guards against.
     * `from` is narrowed server-side, so a filter the server does not recognise
     * («EDC» — the operator's shorthand, and nobody's address) returns zero and the
     * caller cannot tell it apart from "this company never wrote to us". Live, that
     * produced «no readable PO attachments» over 3,688 real EDC messages.
     *
     * So: re-scan without the sender (the other criteria still apply), resolve the
     * shorthand against the senders actually present, and keep those matches. One
     * extra envelope pass on the failure path only — the successful path is
     * untouched.
     */
    let senderResolutionInner: EmailSenderResolution | undefined;
    if (opts.from?.trim() && all.length === 0) {
      // Search the operator's WORD across subject AND sender (a mailbox-wide
      // term), so a shorthand that exists only in the subject («EDC PO No …»
      // sent by `noreply@egyptian-drilling.com`) is still findable.
      const fallback = await Promise.all(
        usable.map((m) =>
          scanOneMailbox(m.email, {
            from: undefined,
            // The OTHER criteria must survive the retry, or resolving a sender
            // would widen the census beyond what the operator asked for.
            subject: opts.subject,
            query: opts.from!.trim(),
            unseenOnly: opts.unseenOnly,
            since,
            before,
            folder,
            startedAt: Date.now(),
            patterns,
          }),
        ),
      );
      const observed = aggregateSenders(fallback.flatMap((r) => r.matches));
      const { resolved, domain, candidates } = resolveSenderFromCandidates(opts.from, observed);
      if (resolved && domain) {
        // Filter on the DOMAIN, not the single address: the operator named a
        // company, and its people's mailboxes are that company (live EDC writes
        // from `noreply@` plus two individuals).
        const onDomain = (m: EmailCensusMatch) => {
          const addr = senderAddress(m.from).toLowerCase();
          return addr.endsWith(`@${domain.toLowerCase()}`);
        };
        const filtered = fallback.flatMap((r) => r.matches.filter(onDomain));
        senderResolutionInner = {
          requested: opts.from,
          resolved,
          domain,
          matched: filtered.length,
          candidates: [],
        };
        // Swap in the resolved company's matches so every downstream aggregate
        // (byMonth/bySender/numbers/note) describes the CORRECTED census, not the
        // empty one the shorthand produced.
        perMailbox.forEach((r, i) => {
          const box = usable[i]?.email;
          r.matches = fallback.find((f) => f.mailbox === box)?.matches.filter(onDomain) ?? [];
        });
        all = filtered;
      } else {
        senderResolutionInner = {
          requested: opts.from,
          resolved: null,
          matched: 0,
          candidates,
          observed: observed.slice(0, 8).map((s) => s.from),
        };
      }
    }
    senderResolution = senderResolutionInner;
    putScanCacheEntry(envelopeKey, { all, perMailbox, senderResolution });
  }

  all.sort((a, b) => b.date.localeCompare(a.date));

  const byMailbox: Record<string, number> = {};
  for (const r of perMailbox) byMailbox[r.mailbox] = r.matches.length;

  const byMonth: Record<string, number> = {};
  for (const e of all) {
    const month = e.date.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + 1;
  }

  const bySender = aggregateSenders(all).slice(0, 15);

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
          source: "subject",
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

  /*
   * A number can live INSIDE the attached document rather than the subject —
   * EDC's «Quotation Import» notices do exactly that — so a subject-only census
   * under-counts them. When asked, the matched messages are opened once here and
   * the numbers found in their PDFs are merged in, tagged `source: "attachment"`
   * so the model can tell the two apart. The same downloaded attachments are
   * handed back for the item census, so the mail is never fetched twice.
   */
  let attachmentCoverage: AttachmentCoverage | undefined;
  let attachmentMessages: MessageAttachments[] | undefined;
  if (opts.includeAttachments && all.length) {
    const fetched = await fetchMessageAttachments(
      all,
      attachmentScanBudget(),
      opts.attachmentSkip ?? 0,
    );
    attachmentCoverage = fetched.coverage;
    attachmentMessages = fetched.messages;
    for (const n of await numbersInAttachments(fetched.messages, patterns)) {
      const hit = numberMap.get(n.number);
      if (hit) hit.count += n.count;
      else numberMap.set(n.number, n);
    }
  }

  const allNumbers = [...numberMap.values()].sort((a, b) => a.number.localeCompare(b.number));
  const distinctNumbers = allNumbers.length;
  const numbersTruncated = distinctNumbers > CENSUS_NUMBER_CAP;

  // `truncated` must mean "some matched mail was not inspected", so an
  // attachment pass that stopped at its budget counts too. Previously only the
  // ENVELOPE scan fed this flag, so a run that opened 381 of 480 attachments
  // still reported `scope.truncated: false` — and the model relayed "حصر كامل"
  // over a sample. That is the exact false claim this flag exists to prevent.
  const truncated = perMailbox.some((r) => r.truncated) || Boolean(attachmentCoverage?.truncated);
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
    returned: opts.returnAllMatches ? all.length : Math.min(all.length, limit),
    emails: opts.returnAllMatches ? all : all.slice(0, limit),
    byMailbox,
    byMonth,
    bySender,
    numbers: allNumbers.slice(0, CENSUS_NUMBER_CAP),
    distinctNumbers,
    numbersTruncated,
    compare,
    senderResolution,
    attachmentCoverage,
    attachmentMessages,
    scope,
    note: censusNote(scope, all.length, senderResolution),
  };
}

/**
 * The coverage caveat, stated for the model. A count is only a total when the
 * scan was complete; otherwise it is a lower bound, and saying so is what keeps
 * the answer honest.
 */
function censusNote(
  scope: EmailCensusScope,
  matched: number,
  senderResolution?: EmailSenderResolution,
): string {
  const covered = scope.mailboxes
    .map((m) => `${m.mailbox}: ${m.scanned} رسالة${m.truncated ? " (ناقص)" : ""}`)
    .join("؛ ");
  const range =
    scope.sinceDate || scope.beforeDate
      ? ` الفترة: ${scope.sinceDate?.slice(0, 10) ?? "البداية"} ← ${scope.beforeDate?.slice(0, 10) ?? "الآن"}.`
      : " الفترة: كل البريد المتاح.";
  const base = `حصر كامل${range} تم فحص ${scope.scanned} رسالة (${covered}) وطابق ${matched}.`;
  // A corrected sender is stated up front: the filter the operator gave matched
  // no address, and silently reporting a different sender's mail as theirs would
  // be its own wrong answer.
  const senderNote = senderNoteFor(senderResolution);
  if (scope.truncated) {
    return (
      senderNote +
      base +
      " تحذير: لم تُفحص كل الرسائل في هذه الصناديق، فالعدد أعلاه حدّ أدنى وليس الإجمالي — " +
      "أعد الحصر بفترة أضيق (sinceDate/beforeDate) أو صندوق واحد."
    );
  }
  return senderNote + base + " العدد أعلاه إجمالي وليس عيّنة.";
}

/**
 * The sentence that tells the model what happened to a sender filter.
 *
 * Two distinct outcomes, and they must not be conflated: a RESOLVED filter means
 * the census was re-run for the real address (the counts that follow are for
 * that sender, and the model must name it); an UNRESOLVED one means nothing
 * matched, so «لا توجد رسائل من X» is not a supported claim — the model has to
 * ask which sender was meant, naming the ones actually seen.
 */
function senderNoteFor(resolution?: EmailSenderResolution): string {
  if (!resolution) return "";
  if (resolution.resolved) {
    const scope = resolution.domain ? ` (كل رسائل نطاق ${resolution.domain})` : "";
    return `تنبيه: «${resolution.requested}» ليس عنوان مُرسل؛ طابقناه مع المُرسل الفعلي «${resolution.resolved}»${scope} وأُعيد الحصر عليه. `;
  }
  const seen = resolution.observed?.length
    ? ` المُرسلون الموجودون فعلًا: ${resolution.observed.join("، ")}.`
    : "";
  const amb = resolution.candidates.length
    ? ` أكثر من مُرسل يطابق «${resolution.requested}»: ${resolution.candidates.join("، ")}.`
    : "";
  return (
    `تنبيه: لم يطابق أي مُرسل «${resolution.requested}».${amb}${seen} ` +
    "لا تقل «لا توجد رسائل من هذا المُرسل» — اسأل عن المُرسل الصحيح أو استخدم أحد العناوين أعلاه."
  );
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

/**
 * A resumable item census.
 *
 * Live failure: asked «ادخل الميل وافحص كل أوامر الشراء وقولي أكتر بند اتكرر»,
 * the assistant opened only the newest window — a 75s fetch budget against
 * ~0.43s/message reaches roughly 170 messages, not the 480 matched — and then
 * reported a ranked list as though it covered the year. Raising the budget does
 * not fix this: 480 messages need ~3.5 minutes, above any ceiling the operator
 * will wait. So the scan became RESUMABLE instead of larger.
 *
 * The mailbox census runs once per window and the parsed rows accumulate in a
 * session kept in the shared scan cache. A cursor walks the matched list: each
 * batch opens the next window, parses it in message-sized chunks, and SAVES the
 * session after every chunk. A follow-up question continues the same census
 * instead of restarting it, and a call cut by the per-tool timeout still keeps
 * the chunks it already parsed. `complete` is a fact about the cursor reaching
 * the end — never an assumption.
 */
import {
  scanEmails,
  getScanCacheEntry,
  putScanCacheEntry,
  persistScanSession,
  loadPersistedScanSession,
  type AttachmentCoverage,
  type EmailCensusResult,
  type MessageAttachments,
} from "./email";
import {
  parseItemsFromAttachments,
  type ItemScanCoverage,
  type MessageItems,
  type ParsedLineItem,
} from "./email-items";
import { logger } from "../../shared/logger";

/** The filter arguments that identify one census. */
export interface ItemScanArgs {
  from?: string;
  subject?: string;
  query?: string;
  sinceDate?: string;
  beforeDate?: string;
  mailbox: string;
  limit?: number;
}

/** Accumulated state of one resumable census. */
export interface ItemScanSession {
  /** The newest window's census — holds the authoritative `matched` count. */
  census: EmailCensusResult;
  /** Rows parsed so far, across every batch. */
  items: ParsedLineItem[];
  /** Messages with rows so far. */
  messages: MessageItems[];
  /** Item coverage summed over the batches. */
  coverage: ItemScanCoverage;
  /** Attachment coverage summed over the batches. */
  attachmentCoverage: AttachmentCoverage;
  /** Cursor: index into the matched list where the next batch starts. */
  nextSkip: number;
  /** Matched messages not yet opened. */
  remaining: number;
  /** Batches run so far — surfacing it shows the scan was staged, not single-shot. */
  batches: number;
  /** True only once the cursor has reached the end of the matched list. */
  complete: boolean;
  /** Census arguments, replayed per batch so the walk is reproducible. */
  args: ItemScanArgs;
}

export interface ItemScanOutcome {
  session: ItemScanSession;
  /** Batches executed by THIS call. */
  ranBatches: number;
}

function emptyItemCoverage(): ItemScanCoverage {
  return {
    messages: 0,
    readable: 0,
    withItems: 0,
    noItems: 0,
    unreadable: 0,
    noAttachment: 0,
    attachments: 0,
    lines: 0,
    pages: 0,
    poDocuments: 0,
    rfqDocuments: 0,
    unknownDocuments: 0,
  };
}

const ITEM_COVERAGE_KEYS: Array<keyof ItemScanCoverage> = [
  "messages",
  "readable",
  "withItems",
  "noItems",
  "unreadable",
  "noAttachment",
  "attachments",
  "lines",
  "poDocuments",
  "rfqDocuments",
  "unknownDocuments",
];

function addItemCoverage(acc: ItemScanCoverage, add: ItemScanCoverage): void {
  for (const k of ITEM_COVERAGE_KEYS) acc[k] += add[k];
}

/** The numeric counters of an attachment pass (never the reason/flag fields). */
type AttachmentCoverageCounter = Exclude<
  keyof AttachmentCoverage,
  "truncated" | "truncatedReason" | "remaining" | "nextSkip"
>;

const ATTACHMENT_COVERAGE_KEYS: AttachmentCoverageCounter[] = [
  "messages",
  "scanned",
  "readable",
  "unreadable",
  "attachments",
];

function emptyAttachmentCoverage(): AttachmentCoverage {
  return {
    messages: 0,
    scanned: 0,
    readable: 0,
    unreadable: 0,
    attachments: 0,
    truncated: false,
    truncatedReason: null,
    remaining: 0,
    nextSkip: 0,
  };
}

function addAttachmentCoverage(acc: AttachmentCoverage, add: AttachmentCoverage): void {
  for (const k of ATTACHMENT_COVERAGE_KEYS) acc[k] += add[k];
}

/** Messages parsed (and cursor-advanced) per step, so the deadline can bite. */
function parseChunkSize(): number {
  return Number(process.env.AI_ITEM_PARSE_CHUNK) || 150;
}

/**
 * Did this session actually inspect anything?
 *
 * `batches === 0` alone is NOT "no work": a window whose messages carry no
 * readable attachment parses zero chunks yet still examined every message, which
 * is recorded in the coverage counters. So work is judged by what was EXAMINED,
 * not by how many parse chunks ran.
 */
function sessionDidWork(s: ItemScanSession): boolean {
  return (
    (s.batches ?? 0) > 0 ||
    (s.coverage?.messages ?? 0) > 0 ||
    (s.attachmentCoverage?.messages ?? 0) > 0 ||
    (s.attachmentCoverage?.scanned ?? 0) > 0
  );
}

/**
 * Is this restored session a RESULT, or the imprint of a failed scan?
 *
 * A session that inspected nothing and matched nothing asserts an empty census
 * that was never performed — and the two cases are indistinguishable from here:
 * a `from` filter the mail server does not recognise returns zero envelopes
 * exactly like an empty mailbox. Live, that is how a year of EDC purchase orders
 * was answered «رسائل مطابقة: 0 — مكتمل» INSTANTLY: the empty session written
 * while the sender shorthand was still unresolved was persisted, reloaded after
 * the next deploy, believed because it said `complete`, and reused forever — each
 * new request re-confirmed the zero without ever opening a message. Discarding
 * it costs one envelope scan (already memoized) and is the only way a census that
 * failed to start can ever start.
 */
function isUnstartedEmpty(s: ItemScanSession): boolean {
  return !sessionDidWork(s) && (s.census?.matched ?? 0) === 0;
}

/**
 * Parse a window of messages in chunks, folding each chunk into the session and
 * persisting it — so the cursor and the rows are durable if a later chunk is cut
 * by the deadline or the per-tool timeout. Returns false when the deadline was
 * reached (the caller stops and the next call resumes).
 */
async function parseChunks(
  session: ItemScanSession,
  key: string,
  messages: MessageAttachments[],
  deadline: number,
): Promise<boolean> {
  const chunk = Math.max(1, parseChunkSize());
  for (let i = 0; i < messages.length; i += chunk) {
    const slice = messages.slice(i, i + chunk);
    const parsed = await parseItemsFromAttachments(slice);
    addItemCoverage(session.coverage, parsed.coverage);
    session.items.push(...parsed.items);
    session.messages.push(...parsed.messages);

    // The cursor advances by messages actually PARSED, so a message is never
    // counted as read before its rows are in the session.
    session.nextSkip += slice.length;
    session.remaining = Math.max(0, session.census.matched - session.nextSkip);
    session.complete = session.remaining === 0;
    session.batches += 1;
    putScanCacheEntry(key, session);
    // Mirror to Postgres so the cursor survives a restart mid-census.
    persistScanSession(key, session);

    if (Date.now() >= deadline) return false;
  }
  return true;
}

/**
 * Open the next window of the matched list, add its coverage, parse it, and
 * advance the cursor. Returns false when the batch did not move the cursor (the
 * caller then stops, instead of re-fetching the same window to the deadline).
 */
async function runBatch(session: ItemScanSession, key: string, deadline: number): Promise<boolean> {
  const before = session.nextSkip;
  const census = await scanEmails({
    ...session.args,
    folder: "inbox",
    includeAttachments: true,
    returnAllMatches: true,
    attachmentSkip: session.nextSkip,
  });
  // `matched` and `emails` describe the WHOLE ask and are identical on every
  // window; only `attachmentMessages` is windowed. Keeping the latest census
  // therefore keeps the authoritative totals — EXCEPT when a window comes back
  // with zero matches for an ask that has already matched: a transient IMAP
  // failure narrows silently, and adopting its `matched: 0` would mark the census
  // complete and end it on the spot. Only an authoritative answer may replace the
  // total, so a zero that contradicts a known non-zero is refused.
  if (census.matched > 0 || (session.census?.matched ?? 0) === 0) {
    session.census = census;
  }

  // A `from` shorthand that is not an address gets resolved on the first window
  // (the census matched nothing). Persist the REAL address into the session's
  // args so every later window filters on it directly: without this the
  // resolution — and its extra full-mailbox pass — would be redone per window,
  // and a resumed scan after a restart would start from the bad filter again.
  if (census.senderResolution?.resolved && session.args.from !== census.senderResolution.resolved) {
    session.args = { ...session.args, from: census.senderResolution.resolved };
  }

  if (census.attachmentCoverage) {
    addAttachmentCoverage(session.attachmentCoverage, census.attachmentCoverage);
  }

  const batch = census.attachmentMessages ?? [];
  await parseChunks(session, key, batch, deadline);

  // `matched` is the authoritative size of the ask; the cursor measures against
  // it. A window the source could not fill still leaves `remaining > 0`, so the
  // next call continues rather than treating the short window as the end.
  session.remaining = Math.max(0, session.census.matched - session.nextSkip);
  session.complete = session.remaining === 0;

  return session.nextSkip > before && Date.now() < deadline;
}

/**
 * Run one call's worth of the census: create the session if absent, then open
 * windows until the census completes or the deadline is reached.
 *
 * A call always opens at least ONE window, even when its deadline has already
 * passed — that guarantees forward progress on every call, so a resumed scan can
 * never stall on a zero budget. Completion is then guaranteed across calls: the
 * cursor and the accumulated rows ride in the shared cache, and the next call
 * continues from where this one stopped.
 */
export async function runItemScan(
  key: string,
  args: ItemScanArgs,
  deadline: number,
): Promise<ItemScanOutcome> {
  let session = getScanCacheEntry<ItemScanSession>(key);
  let ranBatches = 0;

  if (!session) {
    // A restart (deploy/crash) clears the in-process cache. Restore the session
    // from Postgres so the census CONTINUES from its cursor instead of re-reading
    // a multi-minute scan from zero — or, for a large mailbox, never finishing.
    session = await loadPersistedScanSession<ItemScanSession>(key);
    if (session && isUnstartedEmpty(session)) {
      // A claimed-empty session that examined nothing is not a result: it is the
      // imprint of a scan that never started (see `isUnstartedEmpty`). Trusting it
      // answers every future request «0 مطابقة» without opening a single message.
      // Drop it and run a real scan — the persisted claim carries no evidence, so
      // there is nothing to lose by re-checking.
      logger.warn(
        { key },
        "AI assistant: discarding an unstarted empty scan session and re-scanning",
      );
      session = undefined;
    } else if (session) {
      putScanCacheEntry(key, session);
    }
  }

  if (!session) {
    session = {
      // Filled by the first `runBatch`, which this function always runs before
      // returning. Only `nextSkip`/`args` are needed to seed the walk.
      census: undefined as unknown as EmailCensusResult,
      items: [],
      messages: [],
      coverage: emptyItemCoverage(),
      attachmentCoverage: emptyAttachmentCoverage(),
      nextSkip: 0,
      remaining: 0,
      batches: 0,
      complete: false,
      args,
    };
  }

  if (!session.complete || !sessionDidWork(session)) {
    do {
      const keepGoing = await runBatch(session, key, deadline);
      ranBatches += 1;
      if (!keepGoing) break;
    } while (!session.complete && Date.now() < deadline);
  }

  putScanCacheEntry(key, session);
  persistScanSession(key, session);

  return { session, ranBatches };
}

/**
 * Attachment coverage for the session, with `truncated` reflecting the CURSOR: a
 * session is truncated while it still has messages to open, whatever any one
 * batch reported about itself.
 */
export function sessionAttachmentCoverage(session: ItemScanSession): AttachmentCoverage {
  const cov = { ...session.attachmentCoverage };
  cov.truncated = !session.complete;
  cov.truncatedReason = session.complete
    ? null
    : cov.truncatedReason === "error"
      ? "error"
      : "time";
  cov.remaining = session.remaining;
  cov.nextSkip = session.nextSkip;
  return cov;
}

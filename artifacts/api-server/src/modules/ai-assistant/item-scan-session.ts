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
  // therefore keeps the authoritative totals.
  session.census = census;

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

  if (!session.complete) {
    do {
      const keepGoing = await runBatch(session, key, deadline);
      ranBatches += 1;
      if (!keepGoing) break;
    } while (!session.complete && Date.now() < deadline);
  }

  putScanCacheEntry(key, session);

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

/**
 * Resolving the message a supplier replied to.
 *
 * A reply arrives as `msg.context.id` — the `wamid` of the message being
 * answered. Looking that id up by exact match is the obvious approach and it
 * fails in two recorded ways:
 *
 * 1. **The same message can carry more than one `wamid`.** Chatwoot documents
 *    this in `in_reply_to_message_finder.rb`: «Phone-scoped and BSUID-scoped
 *    WAMIDs can carry the same message token even when their complete source
 *    IDs differ.» The id we stored when sending is not always the id the
 *    supplier's reply quotes back, so exact match misses a message we DO have.
 * 2. **Many outbound messages were stored without any id at all** — 2,980 rows
 *    as of 2026-11, including every interactive menu. Those can never resolve,
 *    whatever the lookup does; only recording at send time fixes them.
 *
 * This module handles case 1 and is deliberately conservative about ambiguity:
 * Chatwoot's finder returns nothing when two messages share a token, because
 * attributing a quote to the WRONG message is worse than showing none — the
 * operator would read a price or a specification that belongs to another item.
 */

/**
 * The message token inside a `wamid`, or null when it cannot be determined.
 *
 * Meta base64-encodes the id. Decoded, the layout is a small binary header, the
 * ASCII phone number, a scope marker, then the message token as an ASCII hex
 * run, NUL-terminated.
 *
 * **Two measured facts drove this implementation, and both differ from the
 * obvious port.**
 *
 * 1. Chatwoot's `WHATSAPP_WAMID_TOKEN_PATTERN` accepts only 32- or 20-character
 *    runs. Measured over 1,200 real rows here: outbound tokens are 18
 *    characters in every case, and the population spans 10, 18, 20, 22 and 32.
 *    Copied verbatim, the regex resolves **263 of 1,200** ids — a fix that
 *    looks ported while 78% of replies still report «غير موجودة», which is
 *    worse than no fix because the console has a confident implementation
 *    behind it.
 * 2. A plain hex-run search cannot work either: the ASCII phone number
 *    (`201032301606`) is itself a valid 12-character hex run, so the match is
 *    ambiguous on nearly every id. The token is the run that ends the payload,
 *    so it is anchored on the NUL terminator.
 *
 * This extracts a token from **1,200 of 1,200** rows. It is a per-id string,
 * never an index into a shared list, so two different messages cannot collide
 * unless they genuinely share the token.
 */
const WAMID_TOKEN_RE = /(?<![0-9a-f])([0-9a-f]{8,})(?=\x00|$)/gi;

export function wamidToken(wamid: string | null | undefined): string | null {
  if (!wamid || !wamid.startsWith("wamid.")) return null;
  try {
    const decoded = Buffer.from(wamid.slice("wamid.".length), "base64").toString("latin1");
    const tokens = decoded.match(WAMID_TOKEN_RE);
    // More than one candidate means the split is not unambiguous — refuse
    // rather than guess which run is the id.
    return tokens && tokens.length === 1 ? tokens[0].toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The minimum a candidate needs for the resolver to work with it. */
export interface QuotedCandidate {
  waMessageId: string | null;
}

/**
 * Find the message a reply quotes.
 *
 * Exact match first — it is the correct answer whenever the ids agree. Only on
 * a miss does the token comparison run, and it returns nothing when more than
 * one candidate shares the token. `undefined` means "no candidate is the
 * target"; the caller decides what to show instead.
 */
export function matchQuotedMessage<T extends QuotedCandidate>(
  target: string | null | undefined,
  candidates: T[],
): T | undefined {
  if (!target) return undefined;
  const exact = candidates.find((c) => c.waMessageId === target);
  if (exact) return exact;

  const token = wamidToken(target);
  if (!token) return undefined;

  let found: T | undefined;
  for (const candidate of candidates) {
    if (!candidate.waMessageId || wamidToken(candidate.waMessageId) !== token) continue;
    // Two different messages carrying the same token make the answer a guess.
    if (found) return undefined;
    found = candidate;
  }
  return found;
}

/**
 * Whether a quoted target can NEVER be resolved because it was never stored.
 * Distinguished from "not in this page of history" so the console can say
 * which one it is instead of a blanket «رسالة غير موجودة».
 */
export function looksLikeUnstoredQuote(target: string | null | undefined): boolean {
  return !target;
}

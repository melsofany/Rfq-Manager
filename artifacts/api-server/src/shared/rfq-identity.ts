/**
 * RFQ identity — هوية طلب التسعير
 *
 * A supplier RFQ is identified by the CUSTOMER's request number
 * (`customer_rfq_no`). The same customer request is routinely sent again — to a
 * supplier who was missed, or with a longer closing date when the first one
 * lapsed. Because every send created a NEW `rfq` row, one customer request can
 * be scattered across several supplier RFQs:
 *
 *   measured on production: 29 duplicated customer numbers, 36 surplus rows,
 *   `26R007225` alone has 5 rows with the SAME three items (`CB640A`), 55
 *   supplier sends, and its 3 offers split across two of those rows.
 *
 * The damage is not cosmetic: the offers land on different RFQs, so the
 * comparison screen, the analysis and the KPIs each see a fragment. This module
 * is the ONE rule that decides whether two RFQs describe the same customer
 * request, so the console cannot compare a request against itself.
 *
 * Pure on purpose — no database, no network — so the rule is unit-testable and
 * both the route and the portal can apply it identically.
 */
import { sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Normalise a customer RFQ number for comparison.
 *
 * Real data carries cosmetic variants of the same number: 5 rows have leading
 * or trailing spaces and 18 mix letter case (`Almaza0005` / `almaza0005`,
 * ` Mohamed Alaa Soliman` / `Mohamed Alaa Soliman`). Two rows that differ only
 * by case or padding are the SAME request, so comparing the raw string would
 * miss exactly the duplicates this module exists to catch.
 *
 * Whitespace is collapsed rather than removed: an internal space is part of the
 * number as the customer wrote it, and joining words could merge two different
 * names (`AB CD` vs `ABCD`).
 */
export function normalizeRfqNumber(value: string | null | undefined): string {
  if (value == null) return "";
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The minimum an existing RFQ needs for the reuse decision. */
export interface ExistingRfqCandidate {
  id: number;
  customerRfqNo: string;
  status: string | null;
  itemCount?: number;
  /** Offers already recorded against the row — where the comparison lives. */
  offerCount?: number;
  /** Closing timestamp, ISO string or Date. Absent when never set. */
  expiresAt?: string | Date | null;
  createdAt?: string | Date | null;
}

/** Statuses that mean the request is still live and can still take suppliers. */
const OPEN_STATUSES = new Set(["DRAFT", "SENT", "QUOTED"]);

/** Terminal statuses: the request is finished and must NOT be reopened. */
const CLOSED_STATUSES = new Set(["SUCCESS", "FAILED", "CANCELLED", "COMPLETED"]);

export function isOpenRfqStatus(status: string | null | undefined): boolean {
  return status != null && OPEN_STATUSES.has(status.toUpperCase());
}

export function isClosedRfqStatus(status: string | null | undefined): boolean {
  return status != null && CLOSED_STATUSES.has(status.toUpperCase());
}

function timeOf(value: string | Date | null | undefined): number {
  if (value == null) return 0;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Order candidates so the BEST row to continue is first.
 *
 * A reused RFQ must be the one that already holds the work, so the ranking
 * prefers, in order:
 *
 *   1. a still-open RFQ — continuing it keeps the live comparison together.
 *      A `FAILED` row is preferred last: it was auto-closed by the expiry sweep
 *      and continuing it would resurrect a request the system already gave up
 *      on, while its sibling may still be open.
 *   2. the most OFFERS — the offers are the work, and the whole point of the
 *      fix is to gather them in one place. Continuing a row that already holds
 *      2 offers keeps the comparison intact; picking a newer sibling with 1
 *      offer would split it further, which is the defect being repaired.
 *   3. the most items — that row is the one carrying the full request.
 *   4. the newest — the most recent wording of the request.
 *
 * The ranking never decides alone: `pickExistingRfq` returns null when nothing
 * matches, and the caller creates a new RFQ. Guessing here would merge two
 * genuinely different customer requests.
 */
export function rankExistingRfqs<T extends ExistingRfqCandidate>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const openA = isOpenRfqStatus(a.status) ? 0 : isClosedRfqStatus(a.status) ? 2 : 1;
    const openB = isOpenRfqStatus(b.status) ? 0 : isClosedRfqStatus(b.status) ? 2 : 1;
    if (openA !== openB) return openA - openB;
    const offersA = a.offerCount ?? 0;
    const offersB = b.offerCount ?? 0;
    if (offersA !== offersB) return offersB - offersA;
    const itemsA = a.itemCount ?? 0;
    const itemsB = b.itemCount ?? 0;
    if (itemsA !== itemsB) return itemsB - itemsA;
    const created = timeOf(b.createdAt) - timeOf(a.createdAt);
    if (created !== 0) return created;
    // Stable final tiebreak so the result never depends on input order.
    return b.id - a.id;
  });
}

/**
 * The RFQ that should receive a new send for this customer number, or null.
 *
 * `rows` are the RFQs already stored for the SAME normalized customer number.
 * Returns null when the list is empty — the caller then creates a new RFQ.
 */
export function pickExistingRfq<T extends ExistingRfqCandidate>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  return rankExistingRfqs(rows)[0] ?? null;
}

/** Whether an RFQ is still within its closing date at `now`. */
export function isWithinCloseDate(
  rfq: { expiresAt?: string | Date | null },
  now: Date = new Date(),
): boolean {
  const t = timeOf(rfq.expiresAt);
  // No closing date recorded means "not expired" — an RFQ without a deadline
  // must not be treated as lapsed, or every reuse would look like a new one.
  if (t === 0) return true;
  return t >= now.getTime();
}

/**
 * Which fields of the reused RFQ need updating.
 *
 * The operator's case: the old request's closing date has PASSED and they want
 * to send again with a LONGER window. Extending is the point of the reuse — a
 * reused RFQ whose deadline is still in the past cannot take a new supplier
 * reply, so the new closing date is applied whenever it is LATER than the
 * stored one. An earlier date is NOT applied: it would shorten a live request
 * the operator did not ask to shorten.
 *
 * A status that is closed (FAILED/SUCCESS) is reopened to SENT so the request
 * can accept offers again; an already-open status is left untouched.
 */
export function reuseUpdate(
  existing: ExistingRfqCandidate,
  incoming: { expiresAt?: string | Date | null },
): { status?: string; expiresAt?: Date } {
  const patch: { status?: string; expiresAt?: Date } = {};

  const incomingTime = timeOf(incoming.expiresAt);
  if (incomingTime > 0) {
    const currentTime = timeOf(existing.expiresAt);
    // Apply only when it genuinely extends the window (or none was set).
    if (currentTime === 0 || incomingTime > currentTime) {
      patch.expiresAt = new Date(incomingTime);
    }
  }

  const status = (existing.status ?? "").toUpperCase();
  if (isClosedRfqStatus(status)) {
    // A terminal RFQ is revived to SENT: it now carries a live request again.
    patch.status = "SENT";
  } else if (!status) {
    patch.status = "DRAFT";
  }

  return patch;
}

/**
 * Item identity for the "already present" check.
 *
 * Matches the ladder the rest of the codebase uses (`findItemByKey`,
 * `canonicalPartNo`): part number, then line item, then a normalized
 * description. A row that identifies itself by description alone still counts,
 * because the entry form allows that.
 */
export function itemKey(it: {
  partNo?: string | null;
  lineItem?: string | null;
  description?: string | null;
}): string | null {
  const norm = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, "").trim().toLowerCase();
  const partNo = norm(it.partNo);
  if (partNo) return `p:${partNo}`;
  const lineItem = norm(it.lineItem);
  if (lineItem) return `l:${lineItem}`;
  const description = norm(it.description);
  if (description) return `d:${description}`;
  return null;
}

/**
 * The items from `incoming` that the existing RFQ does not already carry.
 *
 * A re-send is usually the SAME items, so appending blindly would duplicate
 * every line and double every quantity in the analysis. Only genuinely new
 * lines are added, and a row with no identity at all is skipped rather than
 * guessed at.
 */
export function newItemsOnly<
  T extends { partNo?: string | null; lineItem?: string | null; description?: string | null },
>(existing: T[], incoming: T[]): T[] {
  const seen = new Set<string>();
  for (const row of existing) {
    const key = itemKey(row);
    if (key) seen.add(key);
  }
  const out: T[] = [];
  for (const row of incoming) {
    const key = itemKey(row);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Plan a reuse: which incoming lines to INSERT and what to report.
 *
 * A re-send is usually the SAME items, so appending blindly would duplicate
 * every line and double every quantity in the analysis. This is the ONE place
 * that decision is made, so the route cannot drift from the tested rule.
 *
 * `toInsert` keeps the caller's own row objects (not the trimmed copies), so
 * the insert can carry every field the form supplied.
 */
export function planReuseItems<
  T extends {
    partNo?: string | null;
    lineItem?: string | null;
    description?: string | null;
  },
>(stored: unknown[], incoming: T[]): { toInsert: T[]; addedCount: number; existingCount: number } {
  const keys = newItemsOnly(
    stored as { partNo?: string | null; lineItem?: string | null; description?: string | null }[],
    incoming,
  ).map((r) => itemKey(r));
  const wanted = new Set(keys.filter((k): k is string => k != null));
  const toInsert = incoming.filter((it) => {
    const key = itemKey(it);
    return key != null && wanted.has(key);
  });
  return { toInsert, addedCount: toInsert.length, existingCount: stored.length };
}

/**
 * SQL predicate matching a customer number to the NORMALIZED form.
 *
 * It must agree with `normalizeRfqNumber` exactly, or the route would recognise
 * a duplicate the query never returned. Postgres `regexp_replace(..., '\s+',
 * ' ')` is the SQL counterpart of the JS `replace(/\s+/g, " ")`, and `btrim` of
 * `trim`. Kept as a named fragment so a live test can assert it against a real
 * engine — a mocked `select` cannot see a function call.
 */
export function customerNoMatchSql(column: PgColumn, normalized: string) {
  return sql`lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g')) = ${normalized}`;
}

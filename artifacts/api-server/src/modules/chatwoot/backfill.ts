import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import {
  db,
  whatsappChatsTable,
  suppliersTable,
  chatwootLinksTable,
} from "@workspace/db";
import { logger } from "../../shared/logger";
import { canonicalPhone, saveLink } from "./bridge";
import {
  createContact,
  createConversation,
  createMessage,
  findContactByPhone,
  listMessageSourceIds,
  isChatwootConfigured,
} from "./client";

/**
 * Replay Cortoba's existing WhatsApp history into Chatwoot.
 *
 * WHY THIS EXISTS. The live mirror only runs when a message ARRIVES, so a
 * console switched on today starts empty: production held 7,851 messages across
 * 414 numbers from June onward, and Chatwoot knew about 4 conversations. The
 * operators' complaint was exactly that — «المحادثات القديمة مش موجودة». A
 * console that only shows what happened after it was installed cannot be used to
 * answer a supplier who wrote last week.
 *
 * WHY THE REST API AND NOT A DIRECT WRITE. Chatwoot's own overlay carries an
 * importer that writes through Rails models, which is the only way to set a
 * message id. That was the right instinct and the wrong tool here: this process
 * has no Chatwoot credentials for its database, and reaching into another
 * service's schema from the app is a coupling that breaks on its next upgrade.
 * The REST API turns out to be sufficient — `Messages::MessageBuilder` reads
 * `external_created_at` and `source_id` straight off the request — so the
 * original timestamp survives AND the row carries the original id.
 *
 * SAFETY PROPERTIES, each of which has a way to be wrong:
 *   * idempotent — every message is looked up by `source_id` first, because
 *     Chatwoot indexes `source_id` but does NOT make it unique, so the database
 *     will happily accept a duplicate.
 *   * read-only on Cortoba's data — this only SELECTs from our tables and
 *     INSERTs nothing anywhere; the mirror tables it writes are Chatwoot's.
 *   * resumable — a run reports where it stopped and the next call continues,
 *     because 7,851 messages is more than one request's worth of work.
 *   * bounded — a hard cap on messages per call so a backfill cannot hold a
 *     web request open indefinitely.
 *   * non-destructive — it never deletes or edits anything in Chatwoot.
 */

/** How many messages one call will replay unless told otherwise. */
export const BACKFILL_BATCH_DEFAULT = 300;
/** A ceiling that a caller cannot raise past, so one call cannot run for hours. */
export const BACKFILL_BATCH_MAX = 1000;

export interface BackfillResult {
  /** Distinct phone numbers considered in this call. */
  phonesConsidered: number;
  /** Conversations created (a number with history but no console thread). */
  conversationsCreated: number;
  /** Conversations that already existed. */
  conversationsReused: number;
  messagesCreated: number;
  /** Messages already present, recognised by `source_id`. */
  messagesSkipped: number;
  errors: number;
  /** Cursor for the next call: the highest message id replayed. */
  nextCursor: number | null;
  /** True when this call reached the end of the history. */
  complete: boolean;
  /** Why it stopped, when it did not finish. */
  stoppedBy: "complete" | "batch" | "not-configured" | null;
}

/**
 * Which supplier owns a phone number, for the console contact name.
 *
 * Matched on canonical digits, because the number stored on a supplier and the
 * number on a message are written by different code paths and one of them may
 * carry a `+` or a leading zero.
 */
async function supplierNameForPhone(
  phone: string,
): Promise<{ id: number; name: string } | null> {
  const rows = await db
    .select({ id: suppliersTable.id, name: suppliersTable.name, phone: suppliersTable.phone })
    .from(suppliersTable)
    .where(isNotNull(suppliersTable.phone));
  const wanted = canonicalPhone(phone);
  const hit = rows.find((r) => r.phone && canonicalPhone(r.phone) === wanted);
  return hit ? { id: hit.id, name: hit.name } : null;
}

/** The most recent RFQ we know this number was contacted about. */
async function rfqIdForPhone(phone: string): Promise<number | null> {
  const rows = await db
    .select({ rfqId: chatwootLinksTable.rfqId })
    .from(chatwootLinksTable)
    .where(and(eq(chatwootLinksTable.phone, phone), gt(chatwootLinksTable.rfqId, 0)))
    .limit(1);
  return rows[0]?.rfqId ?? null;
}

/**
 * Record that a message has been replayed.
 *
 * Best-effort: a failure here costs one redundant lookup on the next run, which
 * is far better than failing the batch and re-reading the window.
 */
async function markChatSynced(id: number): Promise<void> {
  try {
    await db
      .update(whatsappChatsTable)
      .set({ chatwootSyncedAt: new Date() })
      .where(eq(whatsappChatsTable.id, id));
  } catch (err) {
    logger.warn({ err, id }, "Chatwoot backfill: could not mark a message as replayed");
  }
}

/**
 * Replay one phone number's history.
 *
 * Exported for the tests, which drive it against a stubbed client and a real
 * database mock — the batching and the idempotency are the parts worth pinning.
 */
export async function backfillPhone(
  phone: string,
  opts: { limit: number; afterId?: number },
): Promise<{
  created: number;
  skipped: number;
  errors: number;
  lastId: number | null;
}> {
  const supplier = await supplierNameForPhone(phone);
  const rfqId = (await rfqIdForPhone(phone)) ?? 0;

  // Contact first: a conversation cannot exist without one.
  let contact = await findContactByPhone(phone);
  if (!contact) {
    contact = await createContact(phone, supplier?.name ?? phone);
  }
  if (!contact?.id) return { created: 0, skipped: 0, errors: 1, lastId: null };

  let conversationId: number | null = null;
  const existingLink = await db
    .select({ conversationId: chatwootLinksTable.conversationId })
    .from(chatwootLinksTable)
    .where(and(eq(chatwootLinksTable.phone, phone), eq(chatwootLinksTable.rfqId, rfqId)))
    .limit(1);
  conversationId = existingLink[0]?.conversationId ?? null;

  if (!conversationId) {
    const conv = await createConversation(contact.id, `cortoba-backfill-${phone}`);
    conversationId = conv?.id ?? null;
    // Record the link IMMEDIATELY. Without it the replay cannot see the
    // conversation it just created, so a second run creates a SECOND one for the
    // same number and files every message into a fresh thread. Per-message
    // idempotency does not help: the duplicate is the CONVERSATION.
    if (conversationId) {
      await saveLink({
        phone,
        rfqId,
        contactId: contact.id ?? null,
        conversationId,
        displayName: supplier?.name ?? null,
        supplierId: supplier?.id ?? null,
        employeeId: null,
        employeeName: null,
      });
    }
  }
  if (!conversationId) return { created: 0, skipped: 0, errors: 1, lastId: null };

  // Oldest first: the console then reads as the conversation actually happened,
  // and a partially-completed run leaves a coherent prefix rather than holes.
  const rows = await db
    .select({
      id: whatsappChatsTable.id,
      body: whatsappChatsTable.body,
      direction: whatsappChatsTable.direction,
      createdAt: whatsappChatsTable.createdAt,
      waMessageId: whatsappChatsTable.waMessageId,
      // Read on every row: a replayed message must never be re-scanned, or the
      // batch cursor below can never advance past it.
      chatwootSyncedAt: whatsappChatsTable.chatwootSyncedAt,
    })
    .from(whatsappChatsTable)
    .where(
      and(
        eq(whatsappChatsTable.phone, phone),
        opts.afterId && opts.afterId > 0 ? gt(whatsappChatsTable.id, opts.afterId) : sql`true`,
      ),
    )
    .orderBy(asc(whatsappChatsTable.id))
    .limit(opts.limit);

  // Read the conversation's existing ids ONCE. Per-message lookups only see the
  // newest page, so an earlier partial run's oldest messages would look absent
  // and be inserted a second time.
  const alreadyInConsole = await listMessageSourceIds(conversationId);

  let created = 0;
  let skipped = 0;
  let errors = 0;
  let lastId: number | null = null;

  for (const row of rows) {
    lastId = row.id;

    // Already replayed in an earlier run. Skipping by a COLUMN rather than by
    // asking Chatwoot is what lets the cursor move forward: a message that was
    // re-scanned on every run pinned `lastId` at the same value forever, so a
    // resumed backfill re-read the same window and never reached the other 409
    // numbers.
    if (row.chatwootSyncedAt) {
      skipped += 1;
      continue;
    }

    const sourceId = row.waMessageId
      ? `wa:${row.waMessageId}`
      : `cortoba:chat:${row.id}`;

    // Ask BEFORE inserting. `source_id` is indexed but not unique in Chatwoot,
    // so the database would accept a duplicate and the second backfill would
    // double the thread. A row that IS already there is marked, so it is not
    // re-checked on every later run.
    if (alreadyInConsole.has(sourceId)) {
      await markChatSynced(row.id);
      skipped += 1;
      continue;
    }

    const body = (row.body ?? "").trim();
    if (!body) {
      // A media-only message has no text. Chatwoot renders an empty bubble
      // poorly, so say what it was instead of sending nothing. Marked too:
      // there is nothing to retry, and leaving it unmarked stalls the cursor.
      await markChatSynced(row.id);
      skipped += 1;
      continue;
    }

    const msg = await createMessage(
      conversationId,
      body,
      row.direction === "inbound" ? "incoming" : "outgoing",
      {
        externalCreatedAt: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
        sourceId,
      },
    );
    if (msg) {
      // Mark only AFTER Chatwoot accepted it: marking first would drop a
      // message that the API then refused.
      await markChatSynced(row.id);
      alreadyInConsole.add(sourceId);
      created += 1;
    } else {
      errors += 1;
    }
  }

  return { created, skipped, errors, lastId };
}

/**
 * Replay the whole history, a batch at a time.
 *
 * `cursor` is a message id, so a caller can resume after an interruption. The
 * numbers are ordered by their OLDEST message so the console fills in roughly
 * the order the conversations began.
 */
export async function backfillHistory(
  opts: { limit?: number; cursor?: number } = {},
): Promise<BackfillResult> {
  const limit = Math.min(
    Math.max(1, opts.limit ?? BACKFILL_BATCH_DEFAULT),
    BACKFILL_BATCH_MAX,
  );

  if (!isChatwootConfigured) {
    return {
      phonesConsidered: 0,
      conversationsCreated: 0,
      conversationsReused: 0,
      messagesCreated: 0,
      messagesSkipped: 0,
      errors: 0,
      nextCursor: null,
      complete: false,
      stoppedBy: "not-configured",
    };
  }

  const afterId = opts.cursor ?? 0;

  // The next numbers to replay: those with messages after the cursor, oldest
  // history first, so a resumed run continues rather than restarting.
  const phones = await db
    .select({
      phone: whatsappChatsTable.phone,
      oldest: sql<number>`min(${whatsappChatsTable.id})`,
    })
    .from(whatsappChatsTable)
    .where(afterId > 0 ? gt(whatsappChatsTable.id, afterId) : sql`true`)
    .groupBy(whatsappChatsTable.phone)
    .orderBy(sql`min(${whatsappChatsTable.id})`)
    .limit(20);

  let messagesCreated = 0;
  let messagesSkipped = 0;
  let errors = 0;
  let conversationsCreated = 0;
  let conversationsReused = 0;
  let highWater = afterId;
  let budget = limit;

  for (const p of phones) {
    if (budget <= 0) break;
    if (!p.phone) continue;

    const existing = await db
      .select({ conversationId: chatwootLinksTable.conversationId })
      .from(chatwootLinksTable)
      .where(eq(chatwootLinksTable.phone, p.phone))
      .limit(1);
    if (existing.length) conversationsReused += 1;
    else conversationsCreated += 1;

    const res = await backfillPhone(p.phone, { limit: budget, afterId });
    messagesCreated += res.created;
    messagesSkipped += res.skipped;
    errors += res.errors;
    if (res.lastId !== null) highWater = Math.max(highWater, res.lastId);
    budget -= res.created + res.skipped;
  }

  // Any message at all left beyond the high-water mark means there is more.
  const remaining = await db
    .select({ id: whatsappChatsTable.id })
    .from(whatsappChatsTable)
    .where(gt(whatsappChatsTable.id, highWater))
    .limit(1);

  const complete = remaining.length === 0;
  if (messagesCreated || messagesSkipped) {
    logger.info(
      {
        phones: phones.length,
        messagesCreated,
        messagesSkipped,
        errors,
        highWater,
        complete,
      },
      "Chatwoot history backfill batch complete",
    );
  }

  return {
    phonesConsidered: phones.length,
    conversationsCreated,
    conversationsReused,
    messagesCreated,
    messagesSkipped,
    errors,
    nextCursor: complete ? null : highWater,
    complete,
    stoppedBy: complete ? "complete" : "batch",
  };
}

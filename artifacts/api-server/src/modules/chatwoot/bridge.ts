/**
 * Chatwoot console bridge.
 *
 * Design constraint that shapes this file: our own Meta webhook stays the ONE
 * gateway to WhatsApp. It drives RFQ/PO sending, the representative bot and the
 * AI assistant, and it is the only place inbound pricing replies are handled.
 * Chatwoot's own WhatsApp channel would take that webhook over and break all of
 * it, so Chatwoot is wired as an agent CONSOLE on an API inbox instead:
 *
 *   inbound  : our webhook → mirror into Chatwoot (so agents can read/reply)
 *   outbound : we send → mirror into Chatwoot (so agents see what was sent)
 *   agent    : a human agent replies in Chatwoot → we send it out via our own
 *              Meta plumbing and record it in whatsapp_chats
 *
 * Every function here is best-effort. A Chatwoot outage degrades the console; it
 * must never stop an RFQ from being sent or a supplier reply from being stored.
 */
import { db, chatwootLinksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../shared/logger";
import {
  isChatwootConfigured,
  findContactByPhone,
  createContact,
  createConversation,
  createMessage,
  getConversationContactPhone,
} from "./client";

export { isChatwootConfigured };

/** Message ids we created ourselves. Chatwoot echoes every message back on its
 *  webhook; without this the agent-reply handler would forward our own sends to
 *  WhatsApp a second time. Bounded so a long-running process cannot grow it
 *  without limit. */
const ownMessageIds = new Set<number>();
const OWN_MESSAGE_CAP = 2000;

function rememberOwnMessage(id: number | undefined): void {
  if (id == null) return;
  if (ownMessageIds.size >= OWN_MESSAGE_CAP) {
    const first = ownMessageIds.values().next().value;
    if (first !== undefined) ownMessageIds.delete(first);
  }
  ownMessageIds.add(id);
}

export function isOwnChatwootMessage(id: number | undefined): boolean {
  return id != null && ownMessageIds.has(id);
}

interface LinkRow {
  phone: string;
  contactId: number | null;
  conversationId: number | null;
  displayName: string | null;
  supplierId: number | null;
}

async function loadLink(phone: string): Promise<LinkRow | undefined> {
  const [row] = await db
    .select()
    .from(chatwootLinksTable)
    .where(eq(chatwootLinksTable.phone, phone))
    .limit(1);
  return row as LinkRow | undefined;
}

async function saveLink(link: LinkRow): Promise<void> {
  await db
    .insert(chatwootLinksTable)
    .values({ ...link, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: chatwootLinksTable.phone,
      set: {
        contactId: link.contactId,
        conversationId: link.conversationId,
        displayName: link.displayName,
        supplierId: link.supplierId,
        updatedAt: new Date(),
      },
    });
}

/**
 * Resolve (creating when needed) the Chatwoot contact + conversation for a
 * phone number. Returns null when Chatwoot is unconfigured or the inbox is
 * missing — the caller then simply skips mirroring.
 */
async function ensureConversation(
  phone: string,
  displayName?: string | null,
  supplierId?: number | null,
): Promise<LinkRow | null> {
  if (!isChatwootConfigured) return null;
  if (!process.env.CHATWOOT_INBOX_ID) {
    logger.warn("Chatwoot: CHATWOOT_INBOX_ID is not set — cannot mirror conversations");
    return null;
  }

  const existing = await loadLink(phone);
  if (existing?.conversationId && existing?.contactId) {
    // Keep the name fresh when Meta sends a better one later.
    if (displayName && displayName !== existing.displayName) {
      const updated = { ...existing, displayName };
      await saveLink(updated);
      return updated;
    }
    return existing;
  }

  let contactId = existing?.contactId ?? null;
  if (!contactId) {
    const found = await findContactByPhone(phone);
    contactId = found?.id ?? (await createContact(displayName || phone, phone))?.id ?? null;
  }
  if (!contactId) return null;

  let conversationId = existing?.conversationId ?? null;
  if (!conversationId) {
    const convo = await createConversation(contactId, phone);
    conversationId = convo?.id ?? null;
  }
  if (!conversationId) return null;

  const link: LinkRow = {
    phone,
    contactId,
    conversationId,
    displayName: displayName ?? existing?.displayName ?? null,
    supplierId: supplierId ?? existing?.supplierId ?? null,
  };
  await saveLink(link);
  return link;
}

/** Mirror a supplier message into Chatwoot. Called from our inbound webhook. */
export async function mirrorInboundMessage(opts: {
  phone: string;
  body: string;
  contactName?: string | null;
  supplierId?: number | null;
}): Promise<void> {
  try {
    const link = await ensureConversation(opts.phone, opts.contactName, opts.supplierId);
    if (!link?.conversationId) return;
    const msg = await createMessage(link.conversationId, opts.body, "incoming");
    rememberOwnMessage(msg?.id);
  } catch (err) {
    logger.warn({ err, phone: opts.phone }, "Chatwoot mirror (inbound) failed — non-fatal");
  }
}

/** Mirror a message WE sent into Chatwoot, so agents see the full thread. */
export async function mirrorOutboundMessage(opts: {
  phone: string;
  body: string;
  supplierId?: number | null;
}): Promise<void> {
  try {
    const link = await ensureConversation(opts.phone, null, opts.supplierId);
    if (!link?.conversationId) return;
    const msg = await createMessage(link.conversationId, opts.body, "outgoing");
    rememberOwnMessage(msg?.id);
  } catch (err) {
    logger.warn({ err, phone: opts.phone }, "Chatwoot mirror (outbound) failed — non-fatal");
  }
}

/** Resolve the phone number a Chatwoot conversation belongs to.
 *
 *  Prefers our own link row, then asks Chatwoot. The fallback matters for
 *  conversations the migration script created (they have no link row), so an
 *  agent reply to a historical thread still reaches the supplier. */
export async function phoneForConversation(conversationId: number): Promise<string | null> {
  const [row] = await db
    .select({ phone: chatwootLinksTable.phone })
    .from(chatwootLinksTable)
    .where(eq(chatwootLinksTable.conversationId, conversationId))
    .limit(1);
  if (row?.phone) return row.phone;
  return getConversationContactPhone(conversationId);
}

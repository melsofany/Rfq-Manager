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
import {
  db,
  chatwootLinksTable,
  suppliersTable,
  sentLogTable,
  rfqTable,
  employeesTable,
} from "@workspace/db";
import { and, eq, ne, ilike } from "drizzle-orm";
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

/** Digits-only canonical phone, matching the form Meta sends. */
export function canonicalPhone(phone: string): string {
  let c = (phone || "").replace(/[^\d]/g, "");
  if (c.startsWith("00")) c = c.slice(2);
  if (c.length === 11 && c.startsWith("0")) c = "2" + c;
  if (c.length === 10 && c.startsWith("1")) c = "20" + c;
  return c;
}

export interface OpenRequest {
  rfqId: number;
  internalRfqNo: string;
  employeeId: number | null;
  employeeName: string | null;
}

/** Resolve the supplier behind a phone number, comparing canonical forms. */
export async function supplierByPhone(phone: string): Promise<{
  id: number;
  name: string;
  phone: string | null;
} | null> {
  const target = canonicalPhone(phone);
  if (!target) return null;
  const tail = target.slice(-9);
  try {
    const rows = await db
      .select({ id: suppliersTable.id, name: suppliersTable.name, phone: suppliersTable.phone })
      .from(suppliersTable)
      .where(ilike(suppliersTable.phone, `%${tail}%`))
      .limit(5);
    return rows.find((r) => canonicalPhone(r.phone ?? "") === target) ?? null;
  } catch (err) {
    logger.warn({ err, phone }, "Chatwoot: supplier lookup by phone failed");
    return null;
  }
}

/**
 * Open pricing requests for a supplier: sent to them, not yet answered, and not
 * failed. This is the list the console bot offers as buttons, and what decides
 * which conversation an inbound message belongs to.
 */
export async function openPricingRequestsForSupplier(supplierId: number): Promise<OpenRequest[]> {
  try {
    const rows = await db
      .select({
        rfqId: sentLogTable.rfqId,
        internalRfqNo: rfqTable.internalRfqNo,
        employeeId: sentLogTable.employeeId,
        employeeName: employeesTable.name,
      })
      .from(sentLogTable)
      .innerJoin(rfqTable, eq(sentLogTable.rfqId, rfqTable.id))
      .leftJoin(employeesTable, eq(sentLogTable.employeeId, employeesTable.id))
      .where(
        and(
          eq(sentLogTable.supplierId, supplierId),
          eq(sentLogTable.offerSubmitted, false),
          ne(rfqTable.status, "FAILED"),
        ),
      );
    return rows.map((r) => ({
      rfqId: r.rfqId,
      internalRfqNo: r.internalRfqNo,
      employeeId: r.employeeId ?? null,
      employeeName: r.employeeName ?? null,
    }));
  } catch (err) {
    logger.warn({ err, supplierId }, "Chatwoot: open-request lookup failed");
    return [];
  }
}

/**
 * Decide which request an inbound supplier message answers.
 *
 * Order matters. An explicit request number in the text is authoritative — the
 * supplier telling us which request they mean must never be overruled. Failing
 * that, a supplier with exactly ONE open request is unambiguous. Anything else
 * is ambiguous on purpose: the caller must ask rather than guess, because
 * attributing a reply to the wrong request silently misfiles a price.
 */
export function pickRequestFromText(
  text: string,
  open: OpenRequest[],
): { rfqId: number; ambiguous: false } | { rfqId: null; ambiguous: true } {
  // Compare on alphanumerics only: a supplier retyping the number in WhatsApp
  // drops the separators («RFQ 2026 000222» for «RFQ-2026-000222»), and a
  // separator-sensitive match would miss the very reply naming its request.
  const squeeze = (s: string) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const norm = squeeze(text);
  const explicit = open.find((r) => norm.includes(squeeze(r.internalRfqNo)));
  if (explicit) return { rfqId: explicit.rfqId, ambiguous: false };
  if (open.length === 1) return { rfqId: open[0].rfqId, ambiguous: false };
  return { rfqId: null, ambiguous: true };
}

interface LinkRow {
  id?: number;
  phone: string;
  rfqId: number;
  contactId: number | null;
  conversationId: number | null;
  displayName: string | null;
  supplierId: number | null;
  employeeId: number | null;
  employeeName: string | null;
}

async function loadLink(phone: string, rfqId: number): Promise<LinkRow | undefined> {
  const [row] = await db
    .select()
    .from(chatwootLinksTable)
    .where(and(eq(chatwootLinksTable.phone, phone), eq(chatwootLinksTable.rfqId, rfqId)))
    .limit(1);
  return row as LinkRow | undefined;
}

async function saveLink(link: LinkRow): Promise<void> {
  const now = new Date();
  await db
    .insert(chatwootLinksTable)
    .values({ ...link, updatedAt: now })
    .onConflictDoUpdate({
      target: [chatwootLinksTable.phone, chatwootLinksTable.rfqId],
      set: {
        contactId: link.contactId,
        conversationId: link.conversationId,
        displayName: link.displayName,
        supplierId: link.supplierId,
        employeeId: link.employeeId,
        employeeName: link.employeeName,
        updatedAt: now,
      },
    });
}

/**
 * Resolve (creating when needed) the Chatwoot contact + conversation for a
 * (phone, request) pair. Returns null when Chatwoot is unconfigured or the inbox
 * is missing — the caller then simply skips mirroring.
 *
 * The CONTACT is per phone (one supplier), the CONVERSATION is per request, so
 * each open request gets its own thread under the same contact.
 */
async function ensureConversation(
  phone: string,
  rfqId: number,
  opts: {
    displayName?: string | null;
    supplierId?: number | null;
    employeeId?: number | null;
    employeeName?: string | null;
  } = {},
): Promise<LinkRow | null> {
  if (!isChatwootConfigured) return null;
  if (!process.env.CHATWOOT_INBOX_ID) {
    logger.warn("Chatwoot: CHATWOOT_INBOX_ID is not set — cannot mirror conversations");
    return null;
  }

  const existing = await loadLink(phone, rfqId);
  if (existing?.conversationId && existing?.contactId) {
    // Keep ownership/name fresh when a later send knows more than the first did.
    const displayName = opts.displayName ?? existing.displayName;
    const employeeId = opts.employeeId ?? existing.employeeId;
    const employeeName = opts.employeeName ?? existing.employeeName;
    if (
      displayName !== existing.displayName ||
      employeeId !== existing.employeeId ||
      employeeName !== existing.employeeName
    ) {
      const updated = { ...existing, displayName, employeeId, employeeName };
      await saveLink(updated);
      return updated;
    }
    return existing;
  }

  let contactId = existing?.contactId ?? null;
  if (!contactId) {
    const found = await findContactByPhone(phone);
    contactId = found?.id ?? (await createContact(opts.displayName || phone, phone))?.id ?? null;
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
    rfqId,
    contactId,
    conversationId,
    displayName: opts.displayName ?? existing?.displayName ?? null,
    supplierId: opts.supplierId ?? existing?.supplierId ?? null,
    employeeId: opts.employeeId ?? existing?.employeeId ?? null,
    employeeName: opts.employeeName ?? existing?.employeeName ?? null,
  };
  await saveLink(link);
  return link;
}

/** Mirror a supplier message into Chatwoot. Called from our inbound webhook. */
export async function mirrorInboundMessage(opts: {
  phone: string;
  body: string;
  rfqId?: number | null;
  contactName?: string | null;
  supplierId?: number | null;
  employeeId?: number | null;
  employeeName?: string | null;
}): Promise<void> {
  try {
    const link = await ensureConversation(opts.phone, opts.rfqId ?? 0, {
      displayName: opts.contactName ?? null,
      supplierId: opts.supplierId ?? null,
      employeeId: opts.employeeId ?? null,
      employeeName: opts.employeeName ?? null,
    });
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
  rfqId?: number | null;
  supplierId?: number | null;
  employeeId?: number | null;
  employeeName?: string | null;
}): Promise<void> {
  try {
    const link = await ensureConversation(opts.phone, opts.rfqId ?? 0, {
      supplierId: opts.supplierId ?? null,
      employeeId: opts.employeeId ?? null,
      employeeName: opts.employeeName ?? null,
    });
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

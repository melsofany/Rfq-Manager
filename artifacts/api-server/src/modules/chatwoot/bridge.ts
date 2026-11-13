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
  findAgentByEmail,
  createAgent,
  listAgents,
  assignConversation,
  setConversationCustomAttributes,
  addConversationLabels,
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

/** Conversation custom attribute keys. These MUST match the overlay's defaults
 *  in chatwoot-cortoba/lib/cortoba/config.rb, or the console shows an unlabelled
 *  thread: the bridge would write a key the console never declared. */
export const RFQ_ATTRIBUTE_KEY = process.env.CORTOBA_RFQ_ATTRIBUTE_KEY || "cortoba_rfq_no";
export const OWNER_ATTRIBUTE_KEY = process.env.CORTOBA_OWNER_ATTRIBUTE_KEY || "cortoba_owner_name";

/** Employee emails we have already resolved to an agent, so a busy thread does
 *  not re-list the whole agent roster on every message. Only successful
 *  resolutions are cached — a failure must be retried, or one transient error
 *  would leave that employee unassignable for the process lifetime. */
const agentIdByEmail = new Map<string, number>();

/** Resolve the Chatwoot agent for an employee email, creating it on first use.
 *
 *  Best-effort by contract: returns null on any failure, and the caller simply
 *  leaves the conversation unassigned rather than blocking the mirror. */
export async function ensureAgentForEmail(
  email: string | null | undefined,
  name?: string | null,
): Promise<number | null> {
  const key = (email || "").trim().toLowerCase();
  if (!key) return null;
  const cached = agentIdByEmail.get(key);
  if (cached != null) return cached;
  try {
    const existing = await findAgentByEmail(key);
    if (existing?.id) {
      agentIdByEmail.set(key, existing.id);
      return existing.id;
    }
    const created = await createAgent(name || key, key);
    if (created?.id) {
      agentIdByEmail.set(key, created.id);
      return created.id;
    }
  } catch (err) {
    logger.warn({ err, email: key }, "Chatwoot: agent resolution failed — non-fatal");
  }
  return null;
}

/** Test seam: forget resolved agents so a test can exercise the resolution. */
export function resetAgentCache(): void {
  agentIdByEmail.clear();
}

/** Routing labels written onto a conversation so a supervisor can see, at a
 *  glance, HOW the thread was routed and whether it still needs attention. */
export const ROUTE_LABEL_OWNER = "cortoba:مسؤول الطلب";
export const ROUTE_LABEL_ONLINE = "cortoba:مندوب متاح";
export const ROUTE_LABEL_SUPERVISOR = "cortoba:مشرف";
export const ROUTE_LABEL_UNASSIGNED = "cortoba:بلا مسؤول";

/** Which agent a conversation was routed to, and why. `reason` is the audit
 *  trail: an operator asking "why is this thread with someone else?" gets an
 *  answer instead of a mystery. */
export interface RoutingDecision {
  agentId: number | null;
  reason: "owner" | "online" | "supervisor" | "unassigned";
  label: string;
}

/**
 * Choose who should handle a conversation.
 *
 * Priority, and the reasoning behind each step:
 *  1. `owner` — the employee responsible for the pricing request. A reply about
 *     THEIR request belongs with them; routing it anywhere else means the person
 *     who can answer the supplier has to go looking for it.
 *  2. `online` — any agent currently online. Only used when the owner has no
 *     console account or is not at their desk, so the supplier is not left
 *     waiting for someone who is away.
 *  3. `supervisor` — an administrator. Last resort before leaving it unassigned:
 *     Community Edition has no supervisor role, so the administrators are the
 *     escalation tier.
 *  4. `unassigned` — nobody can take it. Labelled so it appears in the console's
 *     unassigned view rather than silently disappearing.
 *
 * `availability_status` is COMPUTED by Chatwoot (stored preference + live Redis
 * presence), so an agent who has never opened the console reports `offline` even
 * when their preference is online. Step 2 therefore picks among agents actually
 * using the console, which is the intended meaning of "available".
 */
export async function pickAssignee(opts: {
  ownerAgentId?: number | null;
  ownerAvailable?: boolean;
}): Promise<RoutingDecision> {
  const agents = await listAgents();
  if (agents.length === 0) return { agentId: null, reason: "unassigned", label: ROUTE_LABEL_UNASSIGNED };

  if (opts.ownerAgentId != null && opts.ownerAvailable !== false) {
    return { agentId: opts.ownerAgentId, reason: "owner", label: ROUTE_LABEL_OWNER };
  }

  const online = agents.find((a) => a.availability_status === "online");
  if (online?.id) return { agentId: online.id, reason: "online", label: ROUTE_LABEL_ONLINE };

  const admin = agents.find((a) => a.role === "administrator");
  if (admin?.id) return { agentId: admin.id, reason: "supervisor", label: ROUTE_LABEL_SUPERVISOR };

  return { agentId: null, reason: "unassigned", label: ROUTE_LABEL_UNASSIGNED };
}

/** Look up an employee's email by id. Split out so tests can stub it. */
async function employeeEmail(employeeId: number | null | undefined): Promise<string | null> {
  if (employeeId == null) return null;
  try {
    const [row] = await db
      .select({ email: employeesTable.email })
      .from(employeesTable)
      .where(eq(employeesTable.id, employeeId))
      .limit(1);
    return row?.email ?? null;
  } catch (err) {
    logger.warn({ err, employeeId }, "Chatwoot: employee email lookup failed");
    return null;
  }
}

/**
 * Make a conversation OWNED: write the request/owner attributes and assign it to
 * the responsible employee's agent.
 *
 * Without this an inbound reply lands in a shared pile and nobody knows whose
 * request it answers — the request number and owner are the reason this console
 * exists. Called after the conversation is ensured, so the attributes are
 * written once per (phone, request) rather than on every message.
 */
export async function applyConversationOwnership(
  conversationId: number,
  opts: { internalRfqNo?: string | null; employeeId?: number | null; employeeName?: string | null },
): Promise<boolean> {
  try {
    const attributes: Record<string, string> = {};
    if (opts.internalRfqNo) attributes[RFQ_ATTRIBUTE_KEY] = opts.internalRfqNo;
    if (opts.employeeName) attributes[OWNER_ATTRIBUTE_KEY] = opts.employeeName;
    const attributesOk = await setConversationCustomAttributes(conversationId, attributes);

    // The responsible employee's console account, when they have one.
    const email = await employeeEmail(opts.employeeId);
    const ownerAgentId = email ? await ensureAgentForEmail(email, opts.employeeName) : null;

    // Decide who actually gets it: the owner when they have an account, else
    // someone online, else an administrator, else nobody (and say so).
    const decision = await pickAssignee({ ownerAgentId });

    // The label is the visible audit trail of that decision. A failure to label
    // is not a failure to route, so it is attempted before the assignment and
    // does not decide the result.
    const labelled = await addConversationLabels(conversationId, [decision.label]);

    if (decision.agentId == null) {
      // Unassigned on purpose — labelled so a supervisor can find it. This is a
      // successful outcome, not an error to retry.
      return attributesOk && labelled;
    }

    const assigned = await assignConversation(conversationId, decision.agentId);
    // Report failure so the caller does not cache a half-done result and leave
    // the thread unassigned forever.
    return attributesOk && labelled && assigned;
  } catch (err) {
    logger.warn({ err, conversationId }, "Chatwoot: ownership application failed — non-fatal");
    return false;
  }
}

/** Conversations whose ownership is already applied, keyed by the ownership
 *  signature. In-memory and bounded: it exists only to avoid re-issuing the same
 *  two REST calls on every message of a long thread, not to be a durable record.
 *  A FAILED application is deliberately NOT recorded, so it is retried. */
const ownershipApplied = new Map<number, string>();
const OWNERSHIP_CAP = 2000;

/** Test seam. */
export function resetOwnershipCache(): void {
  ownershipApplied.clear();
}

/**
 * Ensure the conversation exists AND is owned by the responsible employee.
 *
 * Ownership is applied once per (conversation, request, owner) rather than per
 * message, and retried on the next message if it failed — so a transient
 * Chatwoot fault delays ownership instead of losing it.
 */
async function ensureConversationOwned(
  phone: string,
  rfqId: number,
  opts: {
    displayName?: string | null;
    supplierId?: number | null;
    employeeId?: number | null;
    employeeName?: string | null;
    internalRfqNo?: string | null;
  } = {},
): Promise<LinkRow | null> {
  const link = await ensureConversation(phone, rfqId, opts);
  if (!link?.conversationId) return link;

  const signature = `${rfqId}:${opts.employeeId ?? ""}`;
  if (ownershipApplied.get(link.conversationId) === signature) return link;

  // The attribute the operator reads is the REQUEST NUMBER, which callers do
  // not always carry (an inbound text may only have told us the phone). Resolve
  // it here rather than making every caller remember to pass it.
  let rfqNo = opts.internalRfqNo ?? null;
  if (!rfqNo && rfqId > 0) rfqNo = await internalRfqNoFor(rfqId);

  const ok = await applyConversationOwnership(link.conversationId, {
    internalRfqNo: rfqNo,
    employeeId: opts.employeeId ?? null,
    employeeName: opts.employeeName ?? null,
  });
  if (ok) {
    if (ownershipApplied.size >= OWNERSHIP_CAP) {
      const first = ownershipApplied.keys().next().value;
      if (first !== undefined) ownershipApplied.delete(first);
    }
    ownershipApplied.set(link.conversationId, signature);
  }
  return link;
}

/** The human-facing request number for an id. Best-effort: a lookup failure
 *  leaves the attribute unwritten rather than failing the mirror. */
async function internalRfqNoFor(rfqId: number): Promise<string | null> {
  try {
    const [row] = await db
      .select({ internalRfqNo: rfqTable.internalRfqNo })
      .from(rfqTable)
      .where(eq(rfqTable.id, rfqId))
      .limit(1);
    return row?.internalRfqNo ?? null;
  } catch (err) {
    logger.warn({ err, rfqId }, "Chatwoot: request-number lookup failed");
    return null;
  }
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

/**
 * Persist a conversation link.
 *
 * Exported because the history replay needs it: without a link row the replay
 * cannot SEE the conversation it just created, so a second run creates a
 * SECOND conversation for the same number — every message duplicated into a new
 * thread. Idempotency at the message level is not enough on its own.
 */
export async function saveLink(link: LinkRow): Promise<void> {
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
    const link = await ensureConversationOwned(opts.phone, opts.rfqId ?? 0, {
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
    const link = await ensureConversationOwned(opts.phone, opts.rfqId ?? 0, {
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

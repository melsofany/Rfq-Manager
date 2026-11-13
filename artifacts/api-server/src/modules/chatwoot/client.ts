/**
 * Chatwoot REST client.
 *
 * Every call here is best-effort: Chatwoot is an agent console layered on top of
 * our WhatsApp plumbing, so a Chatwoot outage must never block sending an RFQ or
 * receiving a supplier reply. Callers wrap these in try/catch and log.
 */
import { logger } from "../../shared/logger";

export const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/$/, "");

/**
 * Headers that let a server-to-server call through the Cortoba gateway.
 *
 * The console refuses every request that does not carry this header once
 * `CORTOBA_GATEWAY_SECRET` is set on it (see chatwoot-cortoba/lib/cortoba/
 * gateway.rb — the console's only reachable entry point is the app's own
 * origin, because `onrender.com` puts the two services on different SITES and
 * the browser then refuses the console's session cookie).
 *
 * Every caller MUST spread this, in one place: a header attached to some calls
 * and forgotten on others works until the gate is armed and then fails on the
 * one path nobody tested. The secret is read per call, not at import, so a
 * value set after boot still applies.
 */
export function gatewayHeaders(): Record<string, string> {
  const secret = process.env.CHATWOOT_GATEWAY_SECRET?.trim();
  return secret ? { "x-cortoba-gateway": secret } : {};
}

export const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || "";
export const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID || "";
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || "";

/** Configured means: we can reach the account API. The inbox is optional until
 *  mirroring starts (a missing inbox id only disables conversation creation). */
export const isChatwootConfigured = Boolean(
  CHATWOOT_URL && CHATWOOT_ACCOUNT_ID && CHATWOOT_API_TOKEN,
);

export interface ChatwootContact {
  id: number;
  name?: string;
  phone_number?: string;
}

export interface ChatwootConversation {
  id: number;
}

export interface ChatwootMessage {
  id: number;
  content?: string;
  message_type?: number | string;
  created_at?: number;
  conversation_id?: number;
  sender?: { id?: number; type?: string; name?: string };
  /** The original id a replay carried; how a backfill recognises its own rows. */
  source_id?: string | null;
  attachments?: Array<{ id?: number; file_type?: string; data_url?: string }>;
}

async function cw(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...gatewayHeaders(),
        api_access_token: CHATWOOT_API_TOKEN,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Find a contact by exact phone number. Chatwoot's search is fuzzy, so we
 *  verify the returned number ourselves before trusting a match. */
export async function findContactByPhone(phone: string): Promise<ChatwootContact | undefined> {
  const res = await cw(`/contacts/search?q=${encodeURIComponent(phone)}&include_contacts=true`);
  if (!res.ok) {
    logger.warn({ status: res.status, phone }, "Chatwoot: contact search failed");
    return undefined;
  }
  const data = (await res.json()) as { payload?: ChatwootContact[] };
  const digits = phone.replace(/\D/g, "");
  return (data.payload || []).find((c) => (c.phone_number || "").replace(/\D/g, "") === digits);
}

/** Create a contact. The phone must be E.164-ish for Chatwoot to match future
 *  inbound, so we prefix `+` when the caller stored bare digits. */
export async function createContact(
  name: string,
  phone: string,
): Promise<ChatwootContact | undefined> {
  const phoneNumber = phone.startsWith("+") ? phone : `+${phone}`;
  const res = await cw(`/contacts`, {
    method: "POST",
    body: JSON.stringify({ name: name || phoneNumber, phone_number: phoneNumber }),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.warn({ status: res.status, body, phone }, "Chatwoot: create contact failed");
    return undefined;
  }
  const data = (await res.json()) as { payload?: { contact?: ChatwootContact } };
  return data.payload?.contact;
}

/** Create a conversation for a contact in the configured API inbox. */
export async function createConversation(
  contactId: number,
  sourceId = "",
): Promise<ChatwootConversation | undefined> {
  const res = await cw(`/conversations`, {
    method: "POST",
    body: JSON.stringify({
      inbox_id: Number(CHATWOOT_INBOX_ID),
      contact_id: contactId,
      source_id: sourceId,
      status: "open",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.warn({ status: res.status, body, contactId }, "Chatwoot: create conversation failed");
    return undefined;
  }
  const data = (await res.json()) as ChatwootConversation;
  return data;
}

/** Resolve the phone number of the contact behind a conversation.
 *
 *  Used as a fallback when our own link table has no row — which is the normal
 *  case for conversations created by the migration script or directly inside
 *  Chatwoot. Without this, an agent reply to a historical conversation would
 *  find no phone number and be silently dropped. */
export async function getConversationContactPhone(conversationId: number): Promise<string | null> {
  const res = await cw(`/conversations/${conversationId}`);
  if (!res.ok) {
    logger.warn({ status: res.status, conversationId }, "Chatwoot: conversation lookup failed");
    return null;
  }
  const data = (await res.json()) as {
    meta?: { sender?: { phone_number?: string } };
    messages?: unknown;
  };
  const phone = data.meta?.sender?.phone_number;
  return phone ? phone.replace(/\D/g, "") : null;
}

export async function createMessage(
  conversationId: number,
  content: string,
  direction: "incoming" | "outgoing",
  meta: { externalCreatedAt?: string; sourceId?: string } = {},
): Promise<ChatwootMessage | undefined> {
  const res = await cw(`/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      message_type: direction,
      private: false,
      // Chatwoot's message builder reads these straight off the request
      // (`Messages::MessageBuilder#message_params`), so a historical replay can
      // keep the ORIGINAL time and carry the original id.
      //
      // `external_created_at` is what makes a backfill a backfill rather than a
      // pile of messages all stamped "now"; `source_id` is the id the replay
      // checks before inserting, so a second run adds nothing.
      ...(meta.externalCreatedAt
        ? { external_created_at: meta.externalCreatedAt }
        : {}),
      ...(meta.sourceId ? { source_id: meta.sourceId } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.warn({ status: res.status, body, conversationId }, "Chatwoot: create message failed");
    return undefined;
  }
  const data = (await res.json()) as ChatwootMessage;
  return data;
}

// ── Agents & conversation ownership ────────────────────────────────────────
//
// An inbound supplier reply is filed under the pricing request it answers, and
// that request has a RESPONSIBLE EMPLOYEE. Making the console useful means the
// conversation is assigned to that employee, not left in a shared pile where
// nobody owns it. Everything below is best-effort for the same reason as the
// rest of this file: a console problem must not break the WhatsApp pipeline.

export interface ChatwootAgent {
  id: number;
  name?: string;
  email?: string;
  /** `online` | `offline` | `busy` — Chatwoot's own availability state. */
  availability_status?: string;
  role?: string;
  confirmed?: boolean;
}

export type ConversationStatus = "open" | "pending" | "resolved";

/** List the account's agents. Used to resolve an employee → agent mapping. */
/**
 * Has a message carrying this `source_id` already been mirrored?
 *
 * Chatwoot's `messages.source_id` is indexed but NOT unique, so a replay must
 * ask before it inserts. Without this a second run of the backfill duplicates
 * every message — and a duplicate is invisible in the UI until someone counts.
 */
export async function findMessageBySourceId(
  conversationId: number,
  sourceId: string,
): Promise<ChatwootMessage | undefined> {
  // The list endpoint is newest-first and paginated; a backfill inserts
  // chronologically, so the rows it cares about are the most recent ones.
  const res = await cw(`/conversations/${conversationId}/messages?page=1`);
  if (!res.ok) return undefined;
  const data = (await res.json()) as { payload?: ChatwootMessage[] };
  return (data.payload ?? []).find((m) => m.source_id === sourceId);
}

export async function listAgents(): Promise<ChatwootAgent[]> {
  const res = await cw(`/agents`);
  if (!res.ok) {
    logger.warn({ status: res.status }, "Chatwoot: agent list failed");
    return [];
  }
  const data = (await res.json()) as ChatwootAgent[];
  return Array.isArray(data) ? data : [];
}

/** Find an agent by email. Email is the identity both systems share, so it is
 *  the only safe key to match an employee to an agent — a name is not unique. */
export async function findAgentByEmail(email: string): Promise<ChatwootAgent | undefined> {
  if (!email) return undefined;
  const wanted = email.trim().toLowerCase();
  const agents = await listAgents();
  return agents.find((a) => (a.email || "").trim().toLowerCase() === wanted);
}

/** Create an agent. Chatwoot emails an invitation; when SMTP is not configured
 *  the record is still created and assignable, which is what we need. */
export async function createAgent(
  name: string,
  email: string,
  role: "agent" | "administrator" = "agent",
): Promise<ChatwootAgent | undefined> {
  const res = await cw(`/agents`, {
    method: "POST",
    body: JSON.stringify({ name: name || email, email, role }),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.warn({ status: res.status, body, email }, "Chatwoot: create agent failed");
    return undefined;
  }
  return (await res.json()) as ChatwootAgent;
}

/** Assign a conversation to an agent. Idempotent in effect: assigning the same
 *  agent twice leaves the conversation in the same state. */
export async function assignConversation(
  conversationId: number,
  agentId: number,
): Promise<boolean> {
  const res = await cw(`/conversations/${conversationId}/assignments`, {
    method: "POST",
    body: JSON.stringify({ assignee_id: agentId, assignee_type: "User" }),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.warn(
      { status: res.status, body, conversationId, agentId },
      "Chatwoot: assign conversation failed",
    );
    return false;
  }
  return true;
}

/** Merge custom attributes onto a conversation. `merge:true` is essential — the
 *  default REPLACES the whole attribute set, so a second call would wipe the
 *  request number written by the first. */
export async function setConversationCustomAttributes(
  conversationId: number,
  attributes: Record<string, string>,
): Promise<boolean> {
  if (Object.keys(attributes).length === 0) return true;
  const res = await cw(`/conversations/${conversationId}/custom_attributes`, {
    method: "POST",
    body: JSON.stringify({ custom_attributes: attributes, merge: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.warn(
      { status: res.status, body, conversationId },
      "Chatwoot: set custom attributes failed",
    );
    return false;
  }
  return true;
}

/** Add labels to a conversation. Chatwoot merges labels, so this is additive. */
export async function addConversationLabels(
  conversationId: number,
  labels: string[],
): Promise<boolean> {
  if (labels.length === 0) return true;
  const res = await cw(`/conversations/${conversationId}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels }),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.warn({ status: res.status, body, conversationId }, "Chatwoot: add labels failed");
    return false;
  }
  return true;
}

/** Move a conversation between open/pending/resolved. */
export async function setConversationStatus(
  conversationId: number,
  status: ConversationStatus,
): Promise<boolean> {
  const res = await cw(`/conversations/${conversationId}/toggle_status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.warn({ status: res.status, body, conversationId }, "Chatwoot: set status failed");
    return false;
  }
  return true;
}

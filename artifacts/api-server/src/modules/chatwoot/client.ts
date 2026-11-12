/**
 * Chatwoot REST client.
 *
 * Every call here is best-effort: Chatwoot is an agent console layered on top of
 * our WhatsApp plumbing, so a Chatwoot outage must never block sending an RFQ or
 * receiving a supplier reply. Callers wrap these in try/catch and log.
 */
import { logger } from "../../shared/logger";

export const CHATWOOT_URL = (process.env.CHATWOOT_URL || "").replace(/\/$/, "");
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
): Promise<ChatwootMessage | undefined> {
  const res = await cw(`/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      message_type: direction,
      private: false,
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

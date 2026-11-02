/**
 * Read-only Gmail access to a Workspace mailbox, via domain-wide delegation.
 *
 * The service account impersonates the mailbox itself. Only the domain's own
 * mailboxes are accepted (callers validate the address). Nothing here sends,
 * modifies, labels, or deletes mail.
 */
import { google, type gmail_v1 } from "googleapis";
import { loadServiceAccount } from "./directory";

const MAIL_SCOPE = "https://mail.google.com/";

export class MailReadNotConfiguredError extends Error {}

export interface MessageSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface MessageDetail extends MessageSummary {
  to: string;
  body: string;
}

function gmailFor(mailbox: string): gmail_v1.Gmail {
  const creds = loadServiceAccount();
  if (!creds?.client_email || !creds.private_key) {
    throw new MailReadNotConfiguredError("Service account credential is not configured");
  }
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [MAIL_SCOPE],
    subject: mailbox,
  });
  return google.gmail({ version: "v1", auth });
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function summarize(m: gmail_v1.Schema$Message): MessageSummary {
  const headers = m.payload?.headers;
  return {
    id: m.id ?? "",
    threadId: m.threadId ?? "",
    subject: header(headers, "Subject") || "(بدون موضوع)",
    from: header(headers, "From"),
    date: header(headers, "Date"),
    snippet: m.snippet ?? "",
    unread: (m.labelIds ?? []).includes("UNREAD"),
  };
}

export async function listMessages(
  mailbox: string,
  opts: { query?: string; max: number },
): Promise<MessageSummary[]> {
  const gmail = gmailFor(mailbox);
  const list = await gmail.users.messages.list({
    userId: mailbox,
    maxResults: opts.max,
    q: opts.query || undefined,
  });
  const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);
  const metas = await Promise.all(
    ids.map((id) =>
      gmail.users.messages.get({
        userId: mailbox,
        id,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      }),
    ),
  );
  return metas.map((r) => summarize(r.data));
}

export async function getMessage(mailbox: string, id: string): Promise<MessageDetail> {
  const gmail = gmailFor(mailbox);
  const res = await gmail.users.messages.get({ userId: mailbox, id, format: "full" });
  const summary = summarize(res.data);
  return {
    ...summary,
    to: header(res.data.payload?.headers, "To"),
    body: extractBody(res.data.payload),
  };
}

/** Gmail's base64url → UTF-8 text. */
export function decodeBase64Url(data?: string | null): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findPart(
  part: gmail_v1.Schema$MessagePart,
  mime: string,
): gmail_v1.Schema$MessagePart | undefined {
  if (part.mimeType === mime && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mime);
    if (found) return found;
  }
  return undefined;
}

/** Plain text if present, otherwise the HTML body with tags stripped. */
export function extractBody(payload?: gmail_v1.Schema$MessagePart | null): string {
  if (!payload) return "";
  const plain = findPart(payload, "text/plain");
  if (plain) return decodeBase64Url(plain.body?.data);
  const html = findPart(payload, "text/html");
  if (html) return stripHtml(decodeBase64Url(html.body?.data));
  return "";
}

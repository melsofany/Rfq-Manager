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

export interface AttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MessageDetail extends MessageSummary {
  to: string;
  body: string;
  attachments: AttachmentInfo[];
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

export interface LabelInfo {
  id: string;
  name: string;
  type: "system" | "user";
}

/** System folders shown in the viewer, in display order. */
const SYSTEM_FOLDERS = ["INBOX", "STARRED", "IMPORTANT", "SENT", "DRAFT", "SPAM", "TRASH"];

/** Folders and user labels of a mailbox. Gmail's category tabs are not shown. */
export async function listLabels(mailbox: string): Promise<LabelInfo[]> {
  const gmail = gmailFor(mailbox);
  const res = await gmail.users.labels.list({ userId: mailbox });
  const labels: LabelInfo[] = (res.data.labels ?? [])
    .filter((l) => !!l.id && (l.type === "user" || SYSTEM_FOLDERS.includes(l.id)))
    .map((l) => ({
      id: l.id as string,
      name: l.name ?? (l.id as string),
      type: l.type === "user" ? "user" : "system",
    }));
  const order = (l: LabelInfo) =>
    l.type === "system" ? SYSTEM_FOLDERS.indexOf(l.id) : SYSTEM_FOLDERS.length;
  return labels.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
}

export interface MessagePage {
  messages: MessageSummary[];
  nextPageToken?: string;
}

export async function listMessages(
  mailbox: string,
  opts: { query?: string; max: number; labelId?: string; pageToken?: string },
): Promise<MessagePage> {
  const gmail = gmailFor(mailbox);
  const list = await gmail.users.messages.list({
    userId: mailbox,
    maxResults: opts.max,
    q: opts.query || undefined,
    labelIds: opts.labelId ? [opts.labelId] : undefined,
    pageToken: opts.pageToken || undefined,
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
  return {
    messages: metas.map((r) => summarize(r.data)),
    nextPageToken: list.data.nextPageToken ?? undefined,
  };
}

export async function getMessage(mailbox: string, id: string): Promise<MessageDetail> {
  const gmail = gmailFor(mailbox);
  const res = await gmail.users.messages.get({ userId: mailbox, id, format: "full" });
  const summary = summarize(res.data);
  return {
    ...summary,
    to: header(res.data.payload?.headers, "To"),
    body: extractBody(res.data.payload),
    attachments: collectAttachments(res.data.payload),
  };
}

/**
 * Download one attachment's bytes, by its position in the message.
 *
 * Gmail attachment ids are not stable between requests, so the attachment is
 * located by its index in a fresh read of the message, and the current id is
 * used for the download.
 */
export async function getAttachment(
  mailbox: string,
  messageId: string,
  index: number,
): Promise<{ filename: string; mimeType: string; data: Buffer } | null> {
  const gmail = gmailFor(mailbox);
  const msg = await gmail.users.messages.get({ userId: mailbox, id: messageId, format: "full" });
  const info = collectAttachments(msg.data.payload)[index];
  if (!info) return null;
  const res = await gmail.users.messages.attachments.get({
    userId: mailbox,
    messageId,
    id: info.attachmentId,
  });
  return {
    filename: info.filename,
    mimeType: info.mimeType,
    data: Buffer.from(res.data.data ?? "", "base64url"),
  };
}

/** Every named, downloadable part of a message (nested parts included). */
export function collectAttachments(
  part?: gmail_v1.Schema$MessagePart | null,
  out: AttachmentInfo[] = [],
): AttachmentInfo[] {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) {
    out.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType || "application/octet-stream",
      size: part.body.size ?? 0,
    });
  }
  for (const child of part.parts ?? []) collectAttachments(child, out);
  return out;
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

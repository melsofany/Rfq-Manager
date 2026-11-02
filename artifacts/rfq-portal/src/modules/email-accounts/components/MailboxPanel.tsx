import { useState } from "react";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { Inbox, ArrowLeft, Paperclip } from "lucide-react";
import { getJson } from "../lib/api";

export interface MessageSummary {
  id: string;
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

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const FOLDER_LABELS: Record<string, string> = {
  INBOX: "الوارد",
  STARRED: "المميزة بنجمة",
  IMPORTANT: "المهمة",
  SENT: "المرسلة",
  DRAFT: "المسودات",
  SPAM: "البريد العشوائي",
  TRASH: "سلة المهملات",
};

interface LabelInfo {
  id: string;
  name: string;
  type: "system" | "user";
}

interface MessagePageResponse {
  messages: MessageSummary[];
  nextPageToken?: string;
}

export function MailboxPanel({ mailbox, onClose }: { mailbox: string; onClose: () => void }) {
  const [folder, setFolder] = useState<string>("INBOX");
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const labels = useQuery({
    queryKey: ["email-labels", mailbox],
    queryFn: () => getJson<{ labels: LabelInfo[] }>(
      `/api/email-accounts/${encodeURIComponent(mailbox)}/labels`,
    ),
    retry: false,
  });

  const messages = useInfiniteQuery({
    queryKey: ["email-messages", mailbox, folder, submitted],
    initialPageParam: "" as string,
    queryFn: ({ pageParam }) =>
      getJson<MessagePageResponse>(
        `/api/email-accounts/${encodeURIComponent(mailbox)}/messages?max=25` +
          (folder ? `&label=${encodeURIComponent(folder)}` : "") +
          (submitted ? `&q=${encodeURIComponent(submitted)}` : "") +
          (pageParam ? `&pageToken=${encodeURIComponent(pageParam)}` : ""),
      ),
    getNextPageParam: (last) => last.nextPageToken ?? undefined,
    retry: false,
  });

  const detail = useQuery({
    queryKey: ["email-message", mailbox, openId],
    queryFn: () =>
      getJson<MessageDetail>(
        `/api/email-accounts/${encodeURIComponent(mailbox)}/messages/${openId}`,
      ),
    enabled: !!openId,
    retry: false,
  });

  const folderName = (l: LabelInfo) => (l.type === "system" ? FOLDER_LABELS[l.id] ?? l.name : l.name);
  const allMessages = messages.data?.pages.flatMap((p) => p.messages) ?? [];

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Inbox size={15} /> {mailbox}
        </h2>
        <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">
          إغلاق
        </button>
      </div>

      {openId ? (
        <div className="space-y-2">
          <button
            onClick={() => setOpenId(null)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={12} /> رجوع للقائمة
          </button>
          {detail.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
          {detail.error && (
            <p className="text-sm text-destructive">{(detail.error as Error).message}</p>
          )}
          {detail.data && (
            <div className="space-y-1">
              <p className="font-semibold text-foreground">{detail.data.subject}</p>
              <p className="text-xs text-muted-foreground">
                من: {detail.data.from} · إلى: {detail.data.to} · {detail.data.date}
              </p>
              <pre className="whitespace-pre-wrap text-sm text-foreground bg-muted/20 rounded p-3 font-sans">
                {detail.data.body || "(لا يوجد نص)"}
              </pre>
              {detail.data.attachments.length > 0 && (
                <div className="space-y-1 pt-2">
                  <p className="text-xs font-semibold text-foreground">
                    المرفقات ({detail.data.attachments.length})
                  </p>
                  <ul className="space-y-1">
                    {detail.data.attachments.map((a, idx) => (
                      <li key={`${idx}-${a.filename}`}>
                        <a
                          href={`/api/email-accounts/${encodeURIComponent(mailbox)}/messages/${openId}/attachments/${idx}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded border border-border text-xs text-foreground hover:bg-muted/30"
                        >
                          <Paperclip size={13} />
                          <span>{a.filename}</span>
                          <span className="text-muted-foreground">({formatSize(a.size)})</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-4">
          <nav className="space-y-0.5">
            <button
              onClick={() => setFolder("")}
              className={`w-full text-start px-2.5 py-1.5 rounded text-sm ${
                folder === ""
                  ? "bg-primary text-primary-foreground"
                  : "text-foreground hover:bg-muted/40"
              }`}
            >
              كل الرسايل
            </button>
            {labels.isLoading && <p className="text-xs text-muted-foreground">Loading...</p>}
            {labels.error && (
              <p className="text-xs text-destructive">{(labels.error as Error).message}</p>
            )}
            {labels.data?.labels.map((l) => (
              <button
                key={l.id}
                onClick={() => setFolder(l.id)}
                className={`w-full text-start px-2.5 py-1.5 rounded text-sm ${
                  folder === l.id
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-muted/40"
                }`}
              >
                {folderName(l)}
              </button>
            ))}
            {labels.data && labels.data.labels.some((l) => l.type === "user") && (
              <p className="text-[11px] text-muted-foreground px-2.5 pt-3">التصنيفات</p>
            )}
          </nav>

          <div className="space-y-3 min-w-0">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSubmitted(q.trim());
              }}
              className="flex gap-2"
            >
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="بحث في كل الرسايل (مثل: from:supplier أو subject:فاتورة)"
                className="flex-1 h-8 px-2 text-sm rounded border border-border bg-background"
              />
              <button type="submit" className="h-8 px-3 text-xs rounded bg-primary text-primary-foreground">
                بحث
              </button>
            </form>

            {messages.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
            {messages.error && (
              <p className="text-sm text-destructive">{(messages.error as Error).message}</p>
            )}
            {!messages.isLoading && !messages.error && allMessages.length === 0 && (
              <p className="text-sm text-muted-foreground">لا توجد رسائل</p>
            )}
            {allMessages.length > 0 && (
              <ul className="divide-y divide-border">
                {allMessages.map((m) => (
                  <li key={m.id}>
                    <button
                      onClick={() => setOpenId(m.id)}
                      className="w-full text-start py-2 hover:bg-muted/20 px-2 rounded"
                    >
                      <div className="flex justify-between gap-2">
                        <span className={`text-sm truncate ${m.unread ? "font-semibold" : ""} text-foreground`}>
                          {m.subject}
                        </span>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">{m.date}</span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{m.from}</p>
                      <p className="text-xs text-muted-foreground truncate">{m.snippet}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {messages.hasNextPage && (
              <button
                onClick={() => messages.fetchNextPage()}
                disabled={messages.isFetchingNextPage}
                className="w-full py-2 text-xs rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {messages.isFetchingNextPage ? "جاري التحميل..." : "تحميل المزيد"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}



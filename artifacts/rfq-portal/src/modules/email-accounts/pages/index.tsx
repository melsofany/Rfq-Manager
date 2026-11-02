import { useState } from "react";
import { useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Mail, AlertCircle, Inbox, ArrowLeft, Paperclip } from "lucide-react";

interface AccountRow {
  email: string;
  displayName: string;
  suspended: boolean;
  isAdmin: boolean;
  aliases: string[];
  addressCount: number;
  employee: {
    id: number;
    name: string;
    role: string;
    isActive: boolean;
    permissions: Record<string, boolean> | null;
  } | null;
}

interface EmailAccountsView {
  domain: string;
  accounts: AccountRow[];
  employeesWithoutAccount: Array<{ id: number; name: string; email: string; role: string }>;
}

async function fetchEmailAccounts(): Promise<EmailAccountsView> {
  const res = await fetch("/api/email-accounts", { credentials: "include" });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body as EmailAccountsView;
}

interface MessageSummary {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  unread: boolean;
}

interface AttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface MessageDetail extends MessageSummary {
  to: string;
  body: string;
  attachments: AttachmentInfo[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body as T;
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

function MailboxPanel({ mailbox, onClose }: { mailbox: string; onClose: () => void }) {
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


interface Grant {
  id: number;
  mailbox: string;
  employeeId: number;
  employeeName: string;
  employeeEmail: string;
}

interface GrantsResponse {
  grants: Grant[];
  employees: Array<{ id: number; name: string; email: string }>;
}

/** Admin: who may read which mailbox in the app. Read-only grants. */
function GrantsPanel({ mailboxes }: { mailboxes: string[] }) {
  const qc = useQueryClient();
  const grants = useQuery({
    queryKey: ["mailbox-access"],
    queryFn: () => getJson<GrantsResponse>("/api/mailbox-access"),
    retry: false,
  });
  const [mailbox, setMailbox] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["mailbox-access"] });
    qc.invalidateQueries({ queryKey: ["my-mailboxes"] });
  };

  const grant = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setErr(null);
    const res = await fetch("/api/mailbox-access", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mailbox, employeeId: Number(employeeId) }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(body.error || `HTTP ${res.status}`);
      return;
    }
    setEmployeeId("");
    refresh();
  };

  const revoke = async (id: number) => {
    await fetch(`/api/mailbox-access/${id}`, { method: "DELETE", credentials: "include" });
    refresh();
  };

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <h2 className="text-sm font-semibold text-foreground">صلاحيات القراءة للموظفين</h2>
      <p className="text-xs text-muted-foreground">
        الموظف اللي له صلاحية يقدر يقرأ الصندوق من صفحة "الصناديق المشتركة". مفيش إرسال ولا تعديل.
      </p>

      <form onSubmit={grant} className="flex flex-col sm:flex-row gap-2">
        <select
          value={mailbox}
          onChange={(e) => setMailbox(e.target.value)}
          className="h-8 px-2 text-sm rounded border border-border bg-background"
        >
          <option value="">اختر الصندوق</option>
          {mailboxes.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <select
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          className="h-8 px-2 text-sm rounded border border-border bg-background"
        >
          <option value="">اختر الموظف</option>
          {grants.data?.employees.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!mailbox || !employeeId}
          className="h-8 px-3 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50"
        >
          منح الصلاحية
        </button>
      </form>
      {err && <p className="text-xs text-destructive">{err}</p>}

      {grants.data && grants.data.grants.length === 0 && (
        <p className="text-xs text-muted-foreground">لا توجد صلاحيات ممنوحة بعد</p>
      )}
      {grants.data && grants.data.grants.length > 0 && (
        <ul className="divide-y divide-border">
          {grants.data.grants.map((g) => (
            <li key={g.id} className="flex items-center justify-between py-2 text-sm">
              <span>
                <span className="font-medium text-foreground">{g.mailbox}</span>
                <span className="text-muted-foreground"> ← {g.employeeName}</span>
              </span>
              <button
                onClick={() => revoke(g.id)}
                className="text-xs text-destructive hover:underline"
              >
                سحب
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Any employee: the shared mailboxes an admin granted them. */
export function SharedMailboxesPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const mine = useQuery({
    queryKey: ["my-mailboxes"],
    queryFn: () => getJson<{ mailboxes: string[] }>("/api/my-mailboxes"),
    retry: false,
  });

  return (
    <Layout>
      <div className="space-y-4 px-4 sm:px-6 pt-4 sm:pt-6 pb-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">الصناديق المشتركة</h1>
          <p className="text-muted-foreground text-sm">صناديق البريد اللي اتفتحتلك للقراءة</p>
        </div>

        {mine.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {mine.error && <p className="text-sm text-destructive">{(mine.error as Error).message}</p>}
        {mine.data && mine.data.mailboxes.length === 0 && (
          <p className="text-sm text-muted-foreground">
            مفيش صناديق مشتركة مفتوحة لك. اطلب من الأدمن يمنحك صلاحية.
          </p>
        )}

        {mine.data && mine.data.mailboxes.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {mine.data.mailboxes.map((m) => (
              <button
                key={m}
                onClick={() => setSelected(m)}
                className={`px-3 py-1.5 rounded-full text-sm border ${
                  selected === m
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted text-foreground border-border hover:bg-muted/70"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        )}

        {selected && <MailboxPanel mailbox={selected} onClose={() => setSelected(null)} />}
      </div>
    </Layout>
  );
}

function permissionCount(perms: Record<string, boolean> | null): number {
  return perms ? Object.values(perms).filter(Boolean).length : 0;
}

export default function EmailAccountsPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["email-accounts"],
    queryFn: fetchEmailAccounts,
    retry: false,
  });

  return (
    <Layout>
      <div className="space-y-4 px-4 sm:px-6 pt-4 sm:pt-6 pb-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">Email accounts</h1>
          <p className="text-muted-foreground text-sm">
            {data ? `Domain: ${data.domain}` : "Workspace mailboxes per employee (read-only)"}
          </p>
        </div>

        {isLoading && <p className="text-muted-foreground text-sm">Loading...</p>}

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
            <AlertCircle size={14} />
            <span>{(error as Error).message}</span>
          </div>
        )}

        {data && (
          <>
            <div className="bg-card border border-border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-left">
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Mailbox</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Employee</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Role</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">Addresses</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">Permissions</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">Status</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">Mail</th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((a) => (
                    <tr key={a.email} className="border-b border-border last:border-0">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Mail size={14} className="text-muted-foreground" />
                          <div>
                            <p className="font-medium text-foreground">{a.email}</p>
                            {a.aliases.length > 0 && (
                              <p className="text-muted-foreground text-xs">
                                Aliases: {a.aliases.join(", ")}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-foreground">
                        {a.employee ? a.employee.name : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {a.employee?.role ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-center">{a.addressCount}</td>
                      <td className="px-4 py-3 text-center text-muted-foreground text-xs">
                        {a.employee ? permissionCount(a.employee.permissions) : "—"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            a.suspended
                              ? "bg-muted text-muted-foreground"
                              : "bg-green-50 text-green-700"
                          }`}
                        >
                          {a.suspended ? "Suspended" : "Active"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => setSelected(a.email)}
                          className="px-2.5 py-1 rounded text-xs font-medium bg-muted text-foreground hover:bg-muted/70"
                        >
                          قراءة
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <GrantsPanel mailboxes={data.accounts.map((a) => a.email)} />

            {selected && <MailboxPanel mailbox={selected} onClose={() => setSelected(null)} />}

            {data.employeesWithoutAccount.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-sm font-semibold text-foreground">
                  Employees without a mailbox ({data.employeesWithoutAccount.length})
                </h2>
                <ul className="text-sm text-muted-foreground space-y-1">
                  {data.employeesWithoutAccount.map((e) => (
                    <li key={e.id}>
                      {e.name} — {e.email}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}

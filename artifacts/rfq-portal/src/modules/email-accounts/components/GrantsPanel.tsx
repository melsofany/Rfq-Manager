import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJson } from "../lib/api";

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
export function GrantsPanel({ mailboxes }: { mailboxes: string[] }) {
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

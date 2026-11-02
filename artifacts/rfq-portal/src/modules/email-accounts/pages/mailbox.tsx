import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { useAuth } from "@/contexts/AuthContext";
import { MailboxPanel } from "../components/MailboxPanel";
import { getJson } from "../lib/api";

/**
 * صندوق البريد — read-only viewer for the mailboxes this employee may open.
 * Admins see every company mailbox; other employees see only the ones granted
 * to them in the email settings page.
 */
export default function MailboxPage() {
  const { employee } = useAuth();
  const isAdmin = employee?.role === "admin";
  const [selected, setSelected] = useState<string | null>(null);

  const granted = useQuery({
    queryKey: ["my-mailboxes"],
    queryFn: () => getJson<{ mailboxes: string[] }>("/api/my-mailboxes"),
    retry: false,
  });

  const domain = useQuery({
    queryKey: ["email-accounts"],
    queryFn: () => getJson<{ accounts: Array<{ email: string }> }>("/api/email-accounts"),
    enabled: isAdmin,
    retry: false,
  });

  const mailboxes = Array.from(
    new Set([
      ...(granted.data?.mailboxes ?? []),
      ...(isAdmin ? (domain.data?.accounts.map((a) => a.email) ?? []) : []),
    ]),
  );

  return (
    <Layout>
      <div className="space-y-4 px-4 sm:px-6 pt-4 sm:pt-6 pb-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">صندوق البريد</h1>
          <p className="text-muted-foreground text-sm">قراءة فقط</p>
        </div>

        {(granted.isLoading || domain.isLoading) && (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}
        {granted.error && (
          <p className="text-sm text-destructive">{(granted.error as Error).message}</p>
        )}

        {!granted.isLoading && mailboxes.length === 0 && (
          <p className="text-sm text-muted-foreground">
            مفيش صناديق متاحة ليك. اطلب من الأدمن يمنحك صلاحية.
          </p>
        )}

        {mailboxes.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {mailboxes.map((m) => (
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

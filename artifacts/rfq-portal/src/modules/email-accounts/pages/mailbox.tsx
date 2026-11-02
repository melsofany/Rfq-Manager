import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { MailboxPanel } from "../components/MailboxPanel";
import { getJson } from "../lib/api";

/**
 * صندوق البريد — read-only viewer. Shows only the employee's own company
 * mailbox and the mailboxes an admin granted them. The server enforces the same.
 */
export default function MailboxPage() {
  const [selected, setSelected] = useState<string | null>(null);

  const granted = useQuery({
    queryKey: ["my-mailboxes"],
    queryFn: () => getJson<{ mailboxes: string[] }>("/api/my-mailboxes"),
    retry: false,
  });

  const mailboxes = granted.data?.mailboxes ?? [];

  return (
    <Layout>
      <div className="space-y-4 px-4 sm:px-6 pt-4 sm:pt-6 pb-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">صندوق البريد</h1>
          <p className="text-muted-foreground text-sm">قراءة فقط</p>
        </div>

        {granted.isLoading && (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}
        {granted.error && (
          <p className="text-sm text-destructive">{(granted.error as Error).message}</p>
        )}

        {!granted.isLoading && mailboxes.length === 0 && (
          <p className="text-sm text-muted-foreground">
            مفيش صناديق متاحة ليك. بريدك على الدومين أو الصناديق اللي الأدمن منحهالك هتظهر هنا.
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

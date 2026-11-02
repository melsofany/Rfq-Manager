import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Mail, AlertCircle } from "lucide-react";
import { GrantsPanel } from "../components/GrantsPanel";

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


function permissionCount(perms: Record<string, boolean> | null): number {
  return perms ? Object.values(perms).filter(Boolean).length : 0;
}


export default function EmailSettingsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["email-accounts"],
    queryFn: fetchEmailAccounts,
    retry: false,
  });

  return (
    <Layout>
      <div className="space-y-4 px-4 sm:px-6 pt-4 sm:pt-6 pb-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">إعدادات البريد</h1>
          <p className="text-muted-foreground text-sm">
            {data ? `الدومين: ${data.domain}` : "حسابات البريد وربطها بالموظفين"}
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <GrantsPanel mailboxes={data.accounts.map((a) => a.email)} />

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


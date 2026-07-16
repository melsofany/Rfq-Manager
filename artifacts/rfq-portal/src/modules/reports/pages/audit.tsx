import { useListAuditLogs, getListAuditLogsQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { useAuth } from "@/contexts/AuthContext";
import { ClipboardList } from "lucide-react";

export default function AuditPage() {
  const { employee: me } = useAuth();

  const { data: logs, isLoading } = useListAuditLogs(
    { limit: 200 },
    { query: { queryKey: getListAuditLogsQueryKey({ limit: 200 }) } }
  );

  if (me?.role !== "admin") {
    return (
      <Layout>
        <div className="p-6 text-muted-foreground text-sm">Access denied. Admin only.</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-foreground">Audit Log</h1>
          <p className="text-muted-foreground text-sm">System activity trail</p>
        </div>

        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading...</div>
          ) : !logs?.length ? (
            <div className="p-12 text-center">
              <ClipboardList size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground text-sm">No audit entries yet</p>
            </div>
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/30 border-b border-border text-left">
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Timestamp</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Action</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Employee</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Description</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">IP Address</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-border last:border-0 hover:bg-muted/10">
                    <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded text-foreground">
                        {log.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{log.employeeName ?? "System"}</td>
                    <td className="px-4 py-3 text-foreground text-xs">{log.description}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs font-mono">{log.ipAddress ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      </div>
    </Layout>
  );
}

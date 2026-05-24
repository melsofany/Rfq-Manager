import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useListRfqs, getListRfqsQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, FileText } from "lucide-react";

const STATUSES = ["all", "draft", "sent", "partial", "completed", "closed"];

export default function RfqListPage() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");

  const { data: rfqs, isLoading } = useListRfqs(
    { status: status !== "all" ? status : undefined, search: search || undefined },
    { query: { queryKey: getListRfqsQueryKey({ status: status !== "all" ? status : undefined, search: search || undefined }) } }
  );

  return (
    <Layout>
      <div className="p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-foreground">RFQ Management</h1>
            <p className="text-muted-foreground text-sm">Request for Quotation workflow</p>
          </div>
          <Button onClick={() => navigate("/rfq/new")} size="sm" className="gap-1.5">
            <Plus size={15} />
            New RFQ
          </Button>
        </div>

        {/* Filters */}
        <div className="flex gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search RFQ number..."
              className="pl-8 h-8 text-sm"
            />
          </div>
          <div className="flex gap-1">
            {STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors capitalize ${
                  status === s
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading...</div>
          ) : rfqs?.length === 0 ? (
            <div className="p-12 text-center">
              <FileText size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground text-sm">No RFQs found</p>
              <Button onClick={() => navigate("/rfq/new")} size="sm" className="mt-3 gap-1.5">
                <Plus size={14} /> Create first RFQ
              </Button>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">Internal No.</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">Customer RFQ</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">Employee</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">Status</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">Items</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">Suppliers</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">Offers</th>
                  <th className="px-4 py-3 text-muted-foreground text-xs font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {rfqs?.map((rfq) => (
                  <tr
                    key={rfq.id}
                    className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                    onClick={() => navigate(`/rfq/${rfq.id}`)}
                  >
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-primary font-medium">{rfq.internalRfqNo}</span>
                    </td>
                    <td className="px-4 py-3 text-foreground font-mono text-xs">{rfq.customerRfqNo}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{rfq.employeeName ?? "-"}</td>
                    <td className="px-4 py-3"><StatusBadge status={rfq.status} /></td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center justify-center w-6 h-6 bg-muted rounded text-xs font-medium text-foreground">
                        {rfq.itemCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center justify-center w-6 h-6 bg-blue-50 text-blue-700 rounded text-xs font-medium">
                        {rfq.supplierCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center justify-center w-6 h-6 bg-green-50 text-green-700 rounded text-xs font-medium">
                        {rfq.offerCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {new Date(rfq.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  );
}

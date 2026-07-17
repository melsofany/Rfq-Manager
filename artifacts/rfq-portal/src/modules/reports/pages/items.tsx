import { useState, useRef } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/Layout";
import { useSearchItems, getSearchItemsQueryKey } from "@workspace/api-client-react";
import type { ItemHistory, ItemSupplierResponse } from "@workspace/api-client-react";
import {
  Search,
  Package,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Clock,
  TrendingDown,
  TrendingUp,
  Minus,
  Eye,
  EyeOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmtPrice(v: number | null | undefined) {
  if (v == null) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    draft: "bg-slate-100 text-slate-600",
    sent: "bg-blue-50 text-blue-700",
    received: "bg-amber-50 text-amber-700",
    closed: "bg-green-50 text-green-700",
    cancelled: "bg-red-50 text-red-600",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium capitalize",
        map[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

// ─── Supplier Row ─────────────────────────────────────────────────────────────

function SupplierRow({
  supplier,
  minPrice,
}: {
  supplier: ItemSupplierResponse;
  minPrice: number | null;
}) {
  const isLowest = minPrice !== null && supplier.price !== null && supplier.price === minPrice;

  return (
    <tr className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors">
      <td className="py-2.5 px-3 text-sm font-medium text-foreground">{supplier.supplierName}</td>
      <td className="py-2.5 px-3 text-center">
        {supplier.offerSubmitted ? (
          <span className="inline-flex items-center gap-1 text-green-600 text-xs font-medium">
            <CheckCircle2 size={13} /> Responded
          </span>
        ) : supplier.linkOpened ? (
          <span className="inline-flex items-center gap-1 text-amber-600 text-xs font-medium">
            <Eye size={13} /> Opened
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
            <XCircle size={13} /> No response
          </span>
        )}
      </td>
      <td className="py-2.5 px-3 text-right">
        {supplier.price != null ? (
          <span
            className={cn(
              "font-mono text-sm font-semibold",
              isLowest ? "text-green-600" : "text-foreground",
            )}
          >
            {fmtPrice(supplier.price)}
            {isLowest && (
              <span className="ml-1 text-[10px] font-normal text-green-600 bg-green-50 rounded px-1">
                lowest
              </span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </td>
      <td className="py-2.5 px-3 text-center text-xs text-muted-foreground">
        {supplier.taxIncluded ? "Inc." : supplier.price != null ? "Excl." : "—"}
      </td>
      <td className="py-2.5 px-3 text-center text-xs text-muted-foreground">
        {supplier.deliveryDays != null ? `${supplier.deliveryDays}d` : "—"}
      </td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground max-w-[180px] truncate">
        {supplier.notes || "—"}
      </td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground whitespace-nowrap">
        {fmtDate(supplier.offerDate)}
      </td>
    </tr>
  );
}

// ─── Item Card ────────────────────────────────────────────────────────────────

function ItemCard({ item }: { item: ItemHistory }) {
  const [expanded, setExpanded] = useState(false);

  const responded = item.suppliers.filter((s) => s.offerSubmitted);
  const notResponded = item.suppliers.filter((s) => !s.offerSubmitted);
  const responseRate =
    item.sentCount > 0 ? Math.round((item.respondedCount / item.sentCount) * 100) : 0;

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      {/* Header row */}
      <div className="flex items-start gap-4 p-4">
        {/* Item identity */}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            {item.lineItem && (
              <span className="text-xs font-mono bg-muted text-muted-foreground rounded px-1.5 py-0.5">
                Line {item.lineItem}
              </span>
            )}
            {item.partNo && (
              <span className="text-xs font-mono bg-primary/10 text-primary rounded px-1.5 py-0.5">
                {item.partNo}
              </span>
            )}
          </div>
          <p className="text-sm font-semibold text-foreground leading-snug">{item.description}</p>
          <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs text-muted-foreground">
            {item.qty && (
              <span>
                Qty: <span className="font-medium text-foreground">{item.qty}</span>
                {item.uom && ` ${item.uom}`}
              </span>
            )}
            {item.referencePrice && (
              <span>
                Ref:{" "}
                <span className="font-medium text-foreground">{fmtPrice(item.referencePrice)}</span>
              </span>
            )}
          </div>
        </div>

        {/* RFQ link */}
        <div className="flex-shrink-0 text-right">
          <Link href={`/rfq/${item.rfqId}`}>
            <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline font-medium">
              {item.internalRfqNo}
              <ExternalLink size={11} />
            </a>
          </Link>
          <div className="text-xs text-muted-foreground mt-0.5">{fmtDate(item.rfqDate)}</div>
          <div className="mt-1">{statusBadge(item.rfqStatus)}</div>
          {item.employeeName && (
            <div className="text-xs text-muted-foreground mt-0.5">{item.employeeName}</div>
          )}
        </div>
      </div>

      {/* Stats bar */}
      <div className="border-t border-border/60 bg-muted/20 px-4 py-2.5 flex flex-wrap gap-4 items-center text-xs">
        {/* Supplier stats */}
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground">Sent to:</span>
          <span className="font-semibold text-foreground">{item.sentCount}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <CheckCircle2 size={12} className="text-green-500" />
          <span className="font-semibold text-green-600">{item.respondedCount}</span>
          <span className="text-muted-foreground">responded</span>
        </div>
        {item.notRespondedCount > 0 && (
          <div className="flex items-center gap-1.5">
            <XCircle size={12} className="text-red-400" />
            <span className="font-semibold text-red-500">{item.notRespondedCount}</span>
            <span className="text-muted-foreground">no reply</span>
          </div>
        )}
        {item.sentCount > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-16 bg-muted rounded-full h-1.5">
              <div
                className={cn(
                  "h-1.5 rounded-full",
                  responseRate >= 70
                    ? "bg-green-500"
                    : responseRate >= 40
                      ? "bg-amber-500"
                      : "bg-red-400",
                )}
                style={{ width: `${responseRate}%` }}
              />
            </div>
            <span className="text-muted-foreground">{responseRate}%</span>
          </div>
        )}

        {/* Price analysis */}
        {item.minPrice != null && (
          <>
            <div className="h-3 w-px bg-border mx-1" />
            <div className="flex items-center gap-1 text-green-600">
              <TrendingDown size={12} />
              <span className="font-mono font-semibold">{fmtPrice(item.minPrice)}</span>
              <span className="text-muted-foreground">min</span>
            </div>
            {item.maxPrice != null && item.maxPrice !== item.minPrice && (
              <div className="flex items-center gap-1 text-red-500">
                <TrendingUp size={12} />
                <span className="font-mono font-semibold">{fmtPrice(item.maxPrice)}</span>
                <span className="text-muted-foreground">max</span>
              </div>
            )}
            {item.avgPrice != null && (
              <div className="flex items-center gap-1 text-blue-600">
                <Minus size={12} />
                <span className="font-mono font-semibold">{fmtPrice(item.avgPrice)}</span>
                <span className="text-muted-foreground">avg</span>
              </div>
            )}
          </>
        )}

        {/* Expand toggle */}
        {item.suppliers.length > 0 && (
          <button
            onClick={() => setExpanded((x) => !x)}
            className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? (
              <>
                <ChevronUp size={13} /> Hide details
              </>
            ) : (
              <>
                <ChevronDown size={13} /> Show {item.suppliers.length} supplier
                {item.suppliers.length !== 1 ? "s" : ""}
              </>
            )}
          </button>
        )}
      </div>

      {/* Expanded supplier table */}
      {expanded && item.suppliers.length > 0 && (
        <div className="border-t border-border/60 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="bg-muted/30 text-left">
                <th className="py-2 px-3 text-xs font-medium text-muted-foreground">Supplier</th>
                <th className="py-2 px-3 text-xs font-medium text-muted-foreground text-center">
                  Status
                </th>
                <th className="py-2 px-3 text-xs font-medium text-muted-foreground text-right">
                  Price
                </th>
                <th className="py-2 px-3 text-xs font-medium text-muted-foreground text-center">
                  Tax
                </th>
                <th className="py-2 px-3 text-xs font-medium text-muted-foreground text-center">
                  Delivery
                </th>
                <th className="py-2 px-3 text-xs font-medium text-muted-foreground">Notes</th>
                <th className="py-2 px-3 text-xs font-medium text-muted-foreground">Offer Date</th>
              </tr>
            </thead>
            <tbody>
              {item.suppliers.map((s) => (
                <SupplierRow key={s.supplierId} supplier={s} minPrice={item.minPrice ?? null} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ItemsPage() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    data: results,
    isLoading,
    isFetching,
    isError,
  } = useSearchItems(
    { q: submitted },
    {
      query: {
        queryKey: getSearchItemsQueryKey({ q: submitted }),
        enabled: submitted.length >= 2,
      },
    },
  );

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q.length >= 2) setSubmitted(q);
  };

  const noResults =
    submitted.length >= 2 && !isLoading && !isError && (!results || results.length === 0);

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5 max-w-5xl mx-auto">
        {/* Page header */}
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Package size={20} className="text-primary" />
            Items
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Search for any item by description, part number, or line item — see the full RFQ history
            and all supplier responses.
          </p>
        </div>

        {/* Search form */}
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="relative flex-1">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by description, part no, or line item…"
              className="pl-9"
            />
          </div>
          <Button type="submit" disabled={query.trim().length < 2 || isFetching}>
            {isFetching ? "Searching…" : "Search"}
          </Button>
        </form>

        {/* Results */}
        {submitted.length >= 2 && (
          <div className="space-y-3">
            {/* Summary */}
            {results && results.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Found <span className="font-semibold text-foreground">{results.length}</span> result
                {results.length !== 1 ? "s" : ""} for{" "}
                <span className="font-semibold text-foreground">"{submitted}"</span>
              </p>
            )}

            {/* Loading skeleton */}
            {isLoading && (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />
                ))}
              </div>
            )}

            {/* Error state */}
            {isError && (
              <div className="py-10 text-center text-muted-foreground">
                <XCircle size={28} className="mx-auto mb-2 text-red-400" />
                <p className="text-sm font-medium text-red-600">Search failed</p>
                <p className="text-xs mt-1">Please try again or check your connection.</p>
              </div>
            )}

            {/* No results */}
            {noResults && (
              <div className="py-12 text-center text-muted-foreground">
                <Package size={32} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium">No items found for "{submitted}"</p>
                <p className="text-xs mt-1">
                  Try searching with a different description, part number, or line item.
                </p>
              </div>
            )}

            {/* Item cards */}
            {!isLoading &&
              results?.map((item) => <ItemCard key={`${item.rfqItemId}`} item={item} />)}
          </div>
        )}

        {/* Empty state (no search yet) */}
        {!submitted && (
          <div className="py-16 text-center text-muted-foreground">
            <Search size={36} className="mx-auto mb-3 opacity-20" />
            <p className="text-sm font-medium">Enter at least 2 characters to search</p>
            <p className="text-xs mt-1">
              You can search by item description, part number, or line item number.
            </p>
          </div>
        )}
      </div>
    </Layout>
  );
}

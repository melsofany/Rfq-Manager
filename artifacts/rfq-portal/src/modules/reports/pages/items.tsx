import { useState, useRef, useEffect, useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import {
  useSearchItems,
  getSearchItemsQueryKey,
} from "@workspace/api-client-react";
import type {
  ItemHistory,
  ItemSupplierResponse,
  CustomerRfqSheetRow,
  CustomerRfqSheetFacetValue,
} from "@workspace/api-client-react";
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
  Table,
  ListFilter,
  Filter,
  X,
  Search as SearchIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { filterTabs } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";

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

// ─── Sheet View Tab ────────────────────────────────────────────────────────────
// A flat, read-only mirror of the legacy single Google Sheet ("DATA" tab):
// one row per customer RFQ line item, with the matched customer PO columns
// joined in the same row. New data entered anywhere in the system shows up
// here automatically. Columns match the old sheet layout exactly.

const SHEET_PAGE_SIZE = 100;

function cell(v: string | null | undefined) {
  if (v == null || v === "") return <span className="text-muted-foreground/50">—</span>;
  return v;
}

const MAX_FACET_ROWS = 500;

// Filter state for one column. `mode: "all"` = show everything (no filter);
// `mode: "only"` = show only `set` (possibly empty = show none).
type ColumnFilter = { mode: "all" } | { mode: "only"; set: Set<string> };

function emptyFilter(): ColumnFilter {
  return { mode: "all" };
}

// Build the query-string fragment for the active include filters.
// A column in "only" mode sends `<col>Include=v1,v2` (empty list → `=`).
function buildIncludeParams(
  filters: Record<string, ColumnFilter>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [col, f] of Object.entries(filters)) {
    if (f.mode === "only") out[`${col}Include`] = [...f.set].join(",");
  }
  return out;
}

type SheetViewResponse = {
  total: number;
  limit: number;
  offset: number;
  rows: CustomerRfqSheetRow[];
};
type FacetsResponse = { column: string; values: CustomerRfqSheetFacetValue[] };

async function fetchSheetView(
  params: Record<string, string | number | undefined>,
): Promise<SheetViewResponse> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) sp.set(k, String(v));
  }
  const res = await fetch(`/api/customer-rfq/sheet-view?${sp.toString()}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`sheet-view ${res.status}`);
  return res.json();
}

async function fetchFacets(
  params: Record<string, string | undefined>,
): Promise<FacetsResponse> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.set(k, v);
  }
  const res = await fetch(`/api/customer-rfq/sheet-view/facets?${sp.toString()}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`facets ${res.status}`);
  return res.json();
}

// A column header with an autofilter dropdown. The dropdown lists the distinct
// values that could still appear in this column given the OTHER columns' filters.
// Selection uses an INCLUDE model: a value's checkbox means "show this value".
//  - «تحديد الكل»      → show all (no filter)
//  - «إلغاء تحديد الكل» → show none (empty include set), then check the wanted few
//  - «تطبيق الفلتر»    → commit the selection and reload the table once
// While the popover is open, toggling checkboxes updates a local draft only
// (no table reload, no facets reload) so picking many items stays fast. The
// in-dropdown search is client-side over the already-loaded values.
function FilterHeader({
  col,
  label,
  applied,
  facetParams,
  onApply,
  onClearColumn,
}: {
  col: string;
  label: string;
  applied: ColumnFilter;
  facetParams: Record<string, string | undefined>;
  onApply: (filter: ColumnFilter) => void;
  onClearColumn: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [facetSearch, setFacetSearch] = useState("");
  // Local draft selection, committed only on «تطبيق الفلتر».
  const [draft, setDraft] = useState<ColumnFilter>(applied);
  const [loadedValues, setLoadedValues] = useState<string[]>([]);

  const facetsQueryKey = useMemo(
    () => ["sheet-facets", col, facetParams] as const,
    [col, facetParams],
  );

  const { data, isLoading } = useQuery<FacetsResponse>({
    queryKey: facetsQueryKey,
    queryFn: () => fetchFacets({ column: col, ...facetParams }),
    enabled: open,
    staleTime: 30_000,
  });

  const values: CustomerRfqSheetFacetValue[] = data?.values ?? [];
  useEffect(() => {
    if (values.length) setLoadedValues(values.map((v) => v.value));
  }, [values]);

  const filteredValues = facetSearch
    ? values.filter((v) => v.value.toLowerCase().includes(facetSearch.toLowerCase()))
    : values;
  const shown = filteredValues.slice(0, MAX_FACET_ROWS);

  const isChecked = (val: string) =>
    draft.mode === "all" ? true : draft.set.has(val);
  const visibleAllChecked =
    draft.mode === "all" || shown.every((v) => isChecked(v.value));
  const visibleNoneChecked =
    shown.length > 0 && shown.every((v) => !isChecked(v.value));

  const handleOpen = (o: boolean) => {
    setOpen(o);
    if (o) {
      // Reset the draft to the currently-applied filter each time we open.
      setDraft(applied);
      setFacetSearch("");
    }
  };

  const selectAll = () => setDraft({ mode: "all" });
  const deselectAll = () => setDraft({ mode: "only", set: new Set<string>() });

  const toggle = (val: string) => {
    setDraft((prev) => {
      if (prev.mode === "all") {
        // Narrowing from "all": keep the loaded values minus the one just
        // unchecked. (Values beyond the loaded cap are uncommon for the
        // typical "select a few" workflow, which uses deselect-all first.)
        const next = new Set(loadedValues);
        next.delete(val);
        return { mode: "only", set: next };
      }
      const next = new Set(prev.set);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return { mode: "only", set: next };
    });
  };

  const apply = () => {
    onApply(draft);
    setOpen(false);
  };

  const isActive = applied.mode === "only";

  return (
    <div className="inline-flex items-center gap-1">
      <span className="truncate">{label}</span>
      <Popover open={open} onOpenChange={handleOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`فلتر ${label}`}
            className={cn(
              "inline-flex items-center justify-center rounded p-0.5 hover:bg-accent",
              isActive && "text-primary",
            )}
          >
            <Filter size={12} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          sideOffset={4}
          align="start"
          side="bottom"
          avoidCollisions={false}
          className="w-64 p-0 max-h-[min(70vh,460px)] overflow-y-auto"
        >
          <div className="border-b border-border p-2">
            <div className="relative">
              <SearchIcon
                size={12}
                className="absolute top-1/2 -translate-y-1/2 left-2 text-muted-foreground pointer-events-none"
              />
              <input
                value={facetSearch}
                onChange={(e) => setFacetSearch(e.target.value)}
                placeholder="بحث في القيم…"
                className="w-full bg-background border border-border rounded pl-6 pr-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={selectAll}
                  className="text-[11px] text-primary hover:underline"
                  disabled={visibleAllChecked}
                >
                  تحديد الكل
                </button>
                <button
                  type="button"
                  onClick={deselectAll}
                  className="text-[11px] text-primary hover:underline"
                  disabled={visibleNoneChecked}
                >
                  إلغاء تحديد الكل
                </button>
              </div>
              {isActive && (
                <button
                  type="button"
                  onClick={onClearColumn}
                  className="text-[11px] text-muted-foreground hover:underline"
                >
                  مسح الفلتر
                </button>
              )}
            </div>
            <p className="mt-1.5 text-[10px] text-muted-foreground/80 leading-relaxed">
              اختر البنود المطلوبة ثم اضغط «تطبيق الفلتر». للعرض بند/بضعة بنود فقط:
              اضغط «إلغاء تحديد الكل» ثم ضع ✓ على المطلوب.
            </p>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {isLoading ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                جارٍ التحميل…
              </div>
            ) : shown.length === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                لا توجد قيم
              </div>
            ) : (
              shown.map((v) => {
                const checked = isChecked(v.value);
                const display =
                  v.value === "" ? <span className="text-muted-foreground">(فارغ)</span> : v.value;
                return (
                  <div
                    key={v.value || "__blank__"}
                    role="checkbox"
                    aria-checked={checked}
                    tabIndex={0}
                    onClick={() => toggle(v.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle(v.value);
                      }
                    }}
                    className="flex items-center gap-2 px-2 py-1 hover:bg-accent cursor-pointer text-xs select-none"
                  >
                    <Checkbox checked={checked} className="pointer-events-none" tabIndex={-1} />
                    <span className="flex-1 truncate" title={v.value}>{display}</span>
                    <span className="text-[10px] text-muted-foreground/70">{v.count}</span>
                  </div>
                );
              })
            )}
            {filteredValues.length > MAX_FACET_ROWS && (
              <div className="px-2 py-1 text-[10px] text-muted-foreground/70 border-t border-border">
                تُعرض أول {MAX_FACET_ROWS} من {filteredValues.length} — استخدم البحث للوصول للباقي
              </div>
            )}
          </div>
          <div className="border-t border-border p-2 flex justify-between gap-2">
            <button
              type="button"
              onClick={onClearColumn}
              className="text-[11px] text-destructive hover:underline"
            >
              مسح العمود
            </button>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-[11px] text-muted-foreground hover:underline"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={apply}
                className="text-[11px] font-medium text-primary hover:underline"
              >
                تطبيق الفلتر
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SheetViewTab() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  // Per-column INCLUDE filter. Absent key = show all; present key with
  // mode "only" = show only its set (empty set = show none).
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({});

  const includeParams = buildIncludeParams(filters);
  const hasColFilters = Object.keys(includeParams).length > 0;

  const params = {
    search: search || undefined,
    limit: SHEET_PAGE_SIZE,
    offset,
    ...includeParams,
  };

  const queryKey = useMemo(
    () => ["sheet-view", params] as const,
    [params],
  );

  const { data, isLoading, isFetching, isError } = useQuery<SheetViewResponse>({
    queryKey,
    queryFn: () => fetchSheetView(params),
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const hasNext = offset + SHEET_PAGE_SIZE < total;
  const hasPrev = offset > 0;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setOffset(0);
    setSearch(searchInput.trim());
  };

  const resetSearch = () => {
    setSearchInput("");
    setSearch("");
    setOffset(0);
  };

  const applyColumnFilter = (col: string, filter: ColumnFilter) => {
    setOffset(0);
    setFilters((prev) => ({ ...prev, [col]: filter }));
  };

  const clearColumn = (col: string) => {
    setOffset(0);
    setFilters((prev) => {
      const next = { ...prev };
      delete next[col];
      return next;
    });
  };

  const clearColFilters = () => {
    setFilters({});
    setOffset(0);
  };

  return (
    <div className="space-y-4">
      {/* Search + count */}
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={handleSearch} className="flex gap-2 flex-1 min-w-[240px]">
          <div className="relative flex-1">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="ابحث برقم البند، Part No، التوصيف، رقم طلب التسعير، العميل، أو رقم أمر الشراء…"
              className="pl-9"
            />
          </div>
          <Button type="submit" disabled={isFetching}>
            {isFetching ? "جارٍ البحث…" : "بحث"}
          </Button>
          {search && (
            <Button type="button" variant="ghost" onClick={resetSearch}>
              مسح
            </Button>
          )}
        </form>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {total.toLocaleString("en-US")} صف
        </span>
        {hasColFilters && (
          <Button type="button" variant="ghost" size="sm" onClick={clearColFilters}>
            <Filter size={13} />
            مسح الفلاتر
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-auto max-h-[calc(100vh-200px)]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10">
              <tr className="bg-muted/60 border-b border-border text-right">
                {([
                  ["lineItem", "Line Item"],
                  ["partNo", "Part No"],
                  ["description", "التوصيف"],
                  ["uom", "UOM"],
                  ["customerRfqNo", "طلب التسعير"],
                  ["entryDate", "تاريخ الطلب"],
                  ["rfqQty", "الكمية"],
                  ["rfqUnitPrice", "السعر للعميل"],
                  ["expiryDate", "انتهاء الطلب"],
                  ["customerName", "العميل"],
                  ["buyerName", "المشتري"],
                  ["poNo", "رقم أمر الشراء"],
                  ["poDate", "تاريخ أمر الشراء"],
                  ["poQty", "الكمية"],
                  ["poUnitPrice", "السعر"],
                  ["flagReason", "السبب"],
                ] as const).map(([col, label]) => (
                  <th
                    key={col}
                    className={cn(
                      "px-2 py-2 text-muted-foreground font-medium whitespace-nowrap bg-muted/60",
                      col === "poNo" && "border-r border-border/60",
                    )}
                  >
                    <FilterHeader
                      col={col}
                      label={label}
                      applied={filters[col] ?? emptyFilter()}
                      facetParams={includeParams}
                      onApply={(filter) => applyColumnFilter(col, filter)}
                      onClearColumn={() => clearColumn(col)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={16} className="px-4 py-10 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-2">
                      <div className="h-5 w-5 border-2 border-muted border-t-primary rounded-full animate-spin" />
                      <span>جارٍ التحميل…</span>
                    </div>
                  </td>
                </tr>
              )}
              {isError && (
                <tr>
                  <td colSpan={16} className="px-4 py-10 text-center text-destructive">
                    فشل تحميل البيانات. حاول مرة أخرى.
                  </td>
                </tr>
              )}
              {!isLoading && !isError && rows.length === 0 && (
                <tr>
                  <td colSpan={16} className="px-4 py-10 text-center text-muted-foreground">
                    {search ? `لا توجد نتائج لـ «${search}»` : "لا توجد بيانات بعد"}
                  </td>
                </tr>
              )}
              {!isLoading &&
                !isError &&
                rows.map((r: CustomerRfqSheetRow) => (
                  <tr
                    key={`${r.rfqItemId}-${r.poItemId ?? "nopo"}`}
                    className={cn(
                      "border-b border-border/40 last:border-0 hover:bg-muted/20",
                      r.flagged && "bg-red-50 dark:bg-red-950/30",
                    )}
                  >
                    <td className="px-2 py-1.5 font-mono whitespace-nowrap" dir="ltr">
                      {cell(r.lineItem)}
                    </td>
                    <td className="px-2 py-1.5 font-mono whitespace-nowrap" dir="ltr">
                      {cell(r.partNo)}
                    </td>
                    <td className="px-2 py-1.5">{cell(r.description)}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-center">{cell(r.uom)}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <Link href={`/customer-rfq/${r.customerRfqId}`}>
                        <a className="text-primary hover:underline font-mono" dir="ltr">
                          {r.customerRfqNo}
                        </a>
                      </Link>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-center" dir="ltr">
                      {cell(r.entryDate)}
                    </td>
                    <td className="px-2 py-1.5 text-center font-mono" dir="ltr">
                      {cell(r.rfqQty)}
                    </td>
                    <td className="px-2 py-1.5 text-center font-mono" dir="ltr">
                      {cell(r.rfqUnitPrice)}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-center" dir="ltr">
                      {cell(r.expiryDate)}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{cell(r.customerName)}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{cell(r.buyerName)}</td>
                    {/* PO columns — separated by a subtle divider to mirror the sheet split */}
                    <td className="px-2 py-1.5 whitespace-nowrap border-r border-border/60">
                      {r.poNo ? (
                        <span className="font-mono" dir="ltr">
                          {r.poNo}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-center" dir="ltr">
                      {cell(r.poDate)}
                    </td>
                    <td className="px-2 py-1.5 text-center font-mono" dir="ltr">
                      {cell(r.poQty)}
                    </td>
                    <td className="px-2 py-1.5 text-center font-mono" dir="ltr">
                      {cell(r.poUnitPrice)}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-red-600 dark:text-red-400 font-medium max-w-[220px]">
                      {r.flagReason ?? ""}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {total > SHEET_PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {offset + 1}–{Math.min(offset + SHEET_PAGE_SIZE, total)} من {total.toLocaleString("en-US")}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!hasPrev || isFetching}
              onClick={() => setOffset((o) => Math.max(0, o - SHEET_PAGE_SIZE))}
            >
              السابق
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNext || isFetching}
              onClick={() => setOffset((o) => o + SHEET_PAGE_SIZE)}
            >
              التالي
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ItemsPage() {
  const { employee } = useAuth();
  const allowedTabs = filterTabs(employee?.role, employee?.permissions, "items", ["search", "sheet"] as const);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<"search" | "sheet">(allowedTabs[0] ?? "search");

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
      <div className={cn("p-4 sm:p-6 space-y-5 mx-auto", tab === "sheet" ? "max-w-[1400px]" : "max-w-5xl")}>
        {/* Page header */}
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Package size={20} className="text-primary" />
            Items
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {tab === "search"
              ? "Search for any item by description, part number, or line item — see the full RFQ history and all supplier responses."
              : "سجل مسطّح يعرض كل بند طلب تسعير في صف واحد مع أعمدة أمر الشراء المقابل إن وُجد. أي بيانات مستقبليه تُضاف تظهر هنا تلقائيًا."}
          </p>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 border-b border-border">
          {allowedTabs.includes("search") && (
            <button
              onClick={() => setTab("search")}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                tab === "search"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Search size={15} />
              بحث البنود
            </button>
          )}
          {allowedTabs.includes("sheet") && (
            <button
              onClick={() => setTab("sheet")}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                tab === "sheet"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Table size={15} />
              سجل البنود والطلبات
            </button>
          )}
        </div>

        {tab === "sheet" ? (
          <SheetViewTab />
        ) : (
          <>
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
          </>
        )}
      </div>
    </Layout>
  );
}

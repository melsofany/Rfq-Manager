import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useCreateRfq, getListRfqsQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft,
  Search,
  Plus,
  Trash2,
  ChevronDown,
  CheckSquare,
  Square,
  ListChecks,
} from "lucide-react";
import { Link } from "wouter";

interface ItemRow {
  lineItem: string;
  partNo: string;
  description: string;
  uom: string;
  qty: string;
  referencePrice: string;
}

interface PendingItem extends ItemRow {
  id: string;
  rfqNo: string;
  rfqDate: string;
  requiredResponseDate: string;
}

function useSheetRfqNumbers() {
  return useQuery<{ rfqNumbers: string[] }>({
    queryKey: ["sheet-rfq-numbers"],
    queryFn: async () => {
      const res = await fetch("/api/rfq/sheets/rfq-numbers", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch RFQ numbers");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

function RfqNumberCombobox({
  value,
  onChange,
  suggestions,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = filter
    ? suggestions.filter((s) => s.toLowerCase().includes(filter.toLowerCase())).slice(0, 50)
    : suggestions.slice(0, 50);

  useEffect(() => {
    setFilter(value);
  }, [value]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="flex">
        <Input
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="e.g. 26R005452"
          required
          className="rounded-r-none"
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="border border-l-0 border-border rounded-r-md px-2 bg-muted hover:bg-muted/80 text-muted-foreground"
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {open && filtered.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full max-h-52 overflow-y-auto bg-popover border border-border rounded-md shadow-md text-sm">
          {filtered.map((num) => (
            <li
              key={num}
              className="px-3 py-1.5 cursor-pointer hover:bg-accent hover:text-accent-foreground"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(num);
                setFilter(num);
                setOpen(false);
              }}
            >
              {num}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function NewRfqPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const [customerRfqNo, setCustomerRfqNo] = useState("");
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupSheet, setLookupSheet] = useState("");
  const [notes, setNotes] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [items, setItems] = useState<ItemRow[]>([
    { lineItem: "", partNo: "", description: "", uom: "", qty: "", referencePrice: "" },
  ]);

  const [isLookingUp, setIsLookingUp] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const [pendingItems, setPendingItems] = useState<PendingItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showPicker, setShowPicker] = useState(false);

  const { data: rfqNumbersData } = useSheetRfqNumbers();
  const suggestions = rfqNumbersData?.rfqNumbers ?? [];

  const createMutation = useCreateRfq({
    mutation: {
      onSuccess: (rfq) => {
        queryClient.invalidateQueries({ queryKey: getListRfqsQueryKey() });
        navigate(`/rfq/${rfq.id}`);
      },
    },
  });

  const handleLookup = async () => {
    if (!lookupQuery) return;
    setImportError(null);
    setIsLookingUp(true);
    try {
      const params = new URLSearchParams();
      if (lookupSheet) params.set("sheet", lookupSheet);
      const url = `/api/rfq/lookup/${encodeURIComponent(lookupQuery)}${params.size ? `?${params}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setImportError(err.details ?? err.error ?? "Lookup failed");
        return;
      }
      const data: Record<string, unknown>[] = await res.json();
      if (data.length > 0) {
        const mapped: PendingItem[] = data.map((item, idx) => ({
          id: `${idx}`,
          lineItem: String(item.lineItem ?? ""),
          partNo: String(item.partNo ?? ""),
          description: String(item.description ?? ""),
          uom: String(item.uom ?? ""),
          qty: item.qty != null ? String(item.qty) : "",
          referencePrice: item.referencePrice != null ? String(item.referencePrice) : "",
          rfqNo: String(item.rfqNo ?? ""),
          rfqDate: String(item.rfqDate ?? ""),
          requiredResponseDate: String(item.requiredResponseDate ?? ""),
        }));
        setPendingItems(mapped);
        setSelectedIds(new Set(mapped.map((m) => m.id)));
        setShowPicker(true);
      } else {
        setImportError(`No items found for "${lookupQuery}".`);
      }
    } catch {
      setImportError("Network error — could not reach the server.");
    } finally {
      setIsLookingUp(false);
    }
  };

  const toggleAll = () => {
    if (selectedIds.size === pendingItems.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pendingItems.map((p) => p.id)));
    }
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirmSelection = () => {
    const chosen = pendingItems.filter((p) => selectedIds.has(p.id));
    if (chosen.length === 0) return;
    const newRows: ItemRow[] = chosen.map((p) => ({
      lineItem: p.lineItem,
      partNo: p.partNo,
      description: p.description,
      uom: p.uom,
      qty: p.qty,
      referencePrice: p.referencePrice,
    }));
    const hasOnlyBlank = items.length === 1 && !items[0].description && !items[0].partNo;
    setItems(hasOnlyBlank ? newRows : [...items, ...newRows]);
    if (!customerRfqNo) setCustomerRfqNo(lookupQuery);
    setShowPicker(false);
    setPendingItems([]);
  };

  const addItem = () =>
    setItems((prev) => [
      ...prev,
      { lineItem: "", partNo: "", description: "", uom: "", qty: "", referencePrice: "" },
    ]);

  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));

  const updateItem = (i: number, field: keyof ItemRow, value: string) =>
    setItems((prev) => prev.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerRfqNo) return;
    const validItems = items.filter((it) => it.description.trim());
    createMutation.mutate({
      data: {
        customerRfqNo,
        notes,
        // Send expiresAt as end-of-day UTC so the full chosen day stays valid
        // regardless of the user's timezone (avoids midnight-UTC bug).
        expiresAt: expiresAt ? `${expiresAt}T23:59:59.999Z` : undefined,
        items: validItems.map((it) => ({
          lineItem: it.lineItem || undefined,
          partNo: it.partNo || undefined,
          description: it.description,
          uom: it.uom || undefined,
          qty: it.qty ? it.qty : undefined,
          referencePrice: it.referencePrice ? it.referencePrice : undefined,
        })),
      } as Parameters<typeof createMutation.mutate>[0]["data"],
    });
  };

  const allSelected = pendingItems.length > 0 && selectedIds.size === pendingItems.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < pendingItems.length;

  return (
    <Layout>
      <div className="p-6 max-w-5xl space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/rfq">
            <a className="text-muted-foreground hover:text-foreground">
              <ArrowLeft size={18} />
            </a>
          </Link>
          <div>
            <h1 className="text-xl font-bold text-foreground">New RFQ</h1>
            <p className="text-muted-foreground text-sm">Create a new request for quotation</p>
          </div>
        </div>

        {/* Import from Google Sheets */}
        <div className="bg-card border border-border rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-sm text-foreground">Import from Google Sheets</h2>
            <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
              {suggestions.length > 0 ? `${suggestions.length} RFQs available` : "Loading..."}
            </span>
          </div>
          <div className="flex gap-2 flex-wrap items-end">
            <div className="flex-1 min-w-[200px] space-y-1">
              <Label className="text-xs text-muted-foreground">Customer RFQ No.</Label>
              <RfqNumberCombobox
                value={lookupQuery}
                onChange={setLookupQuery}
                suggestions={suggestions}
              />
            </div>
            <div className="w-32 space-y-1">
              <Label className="text-xs text-muted-foreground">Sheet tab (optional)</Label>
              <Input
                value={lookupSheet}
                onChange={(e) => setLookupSheet(e.target.value)}
                placeholder="DATA"
                className="h-9 text-xs"
              />
            </div>
            <Button
              type="button"
              onClick={handleLookup}
              variant="secondary"
              size="sm"
              className="gap-1.5 h-9"
              disabled={isLookingUp || !lookupQuery}
            >
              <Search size={14} />
              {isLookingUp ? "Fetching..." : "Import Items"}
            </Button>
          </div>

          {importError && <p className="text-xs text-destructive">Error: {importError}</p>}

          {/* Item Selection Panel */}
          {showPicker && pendingItems.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden mt-2">
              <div className="flex items-center justify-between px-4 py-2.5 bg-muted/40 border-b border-border">
                <div className="flex items-center gap-2">
                  <ListChecks size={15} className="text-primary" />
                  <span className="text-sm font-medium text-foreground">
                    Select Items to Import
                  </span>
                  <span className="text-xs text-muted-foreground">
                    ({selectedIds.size} / {pendingItems.length} selected)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 font-medium"
                  >
                    {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                    {allSelected ? "Deselect All" : "Select All"}
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/60 border-b border-border z-10">
                    <tr>
                      <th className="px-3 py-2 w-8">
                        <button
                          type="button"
                          onClick={toggleAll}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {allSelected ? (
                            <CheckSquare size={14} className="text-primary" />
                          ) : someSelected ? (
                            <CheckSquare size={14} className="text-primary/50" />
                          ) : (
                            <Square size={14} />
                          )}
                        </button>
                      </th>
                      <th className="px-3 py-2 text-left text-muted-foreground font-medium">#</th>
                      <th className="px-3 py-2 text-left text-muted-foreground font-medium">
                        Line Item
                      </th>
                      <th className="px-3 py-2 text-left text-muted-foreground font-medium">
                        Part No
                      </th>
                      <th className="px-3 py-2 text-left text-muted-foreground font-medium min-w-[180px]">
                        Description
                      </th>
                      <th className="px-3 py-2 text-left text-muted-foreground font-medium">UOM</th>
                      <th className="px-3 py-2 text-left text-muted-foreground font-medium">QTY</th>
                      <th className="px-3 py-2 text-left text-muted-foreground font-medium">
                        Ref. Price
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingItems.map((item, idx) => {
                      const checked = selectedIds.has(item.id);
                      return (
                        <tr
                          key={item.id}
                          onClick={() => toggleOne(item.id)}
                          className={`border-b border-border last:border-0 cursor-pointer transition-colors ${
                            checked ? "bg-primary/5 hover:bg-primary/10" : "hover:bg-muted/30"
                          }`}
                        >
                          <td className="px-3 py-2 text-center">
                            {checked ? (
                              <CheckSquare size={14} className="text-primary mx-auto" />
                            ) : (
                              <Square size={14} className="text-muted-foreground mx-auto" />
                            )}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{idx + 1}</td>
                          <td className="px-3 py-2 font-mono">{item.lineItem || "-"}</td>
                          <td className="px-3 py-2 font-mono">{item.partNo || "-"}</td>
                          <td className="px-3 py-2 text-foreground">{item.description}</td>
                          <td className="px-3 py-2 text-muted-foreground">{item.uom || "-"}</td>
                          <td className="px-3 py-2 text-right">{item.qty || "-"}</td>
                          <td className="px-3 py-2 text-right">{item.referencePrice || "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between px-4 py-2.5 bg-muted/20 border-t border-border">
                <button
                  type="button"
                  onClick={() => {
                    setShowPicker(false);
                    setPendingItems([]);
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
                <Button
                  type="button"
                  size="sm"
                  onClick={confirmSelection}
                  disabled={selectedIds.size === 0}
                  className="gap-1.5"
                >
                  <Plus size={13} />
                  Add {selectedIds.size} Item{selectedIds.size !== 1 ? "s" : ""}
                </Button>
              </div>
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* RFQ Info */}
          <div className="bg-card border border-border rounded-lg p-5 space-y-4">
            <h2 className="font-semibold text-sm text-foreground">RFQ Details</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Customer RFQ Number *</Label>
                <Input
                  value={customerRfqNo}
                  onChange={(e) => setCustomerRfqNo(e.target.value)}
                  placeholder="e.g. 26R005452"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label>Notes</Label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Internal notes..."
                />
              </div>
              <div className="space-y-1.5">
                <Label>
                  Expiry Date{" "}
                  <span className="text-muted-foreground font-normal text-xs">
                    (blocks supplier pricing after this date)
                  </span>
                </Label>
                <Input
                  type="date"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Items */}
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <h2 className="font-semibold text-sm text-foreground">
                Items <span className="text-muted-foreground font-normal">({items.length})</span>
              </h2>
              <Button
                type="button"
                onClick={addItem}
                variant="ghost"
                size="sm"
                className="gap-1.5 h-7 text-xs"
              >
                <Plus size={13} /> Add Item
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-left">
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-8">#</th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-36">
                      Line Item
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-28">
                      Part No
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium min-w-[200px]">
                      Description *
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-20">
                      UOM
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-20">
                      QTY
                    </th>
                    <th className="px-3 py-2 text-muted-foreground text-xs font-medium w-28">
                      Ref. Price
                    </th>
                    <th className="px-3 py-2 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row, i) => (
                    <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/20">
                      <td className="px-3 py-2 text-muted-foreground text-xs text-center">
                        {i + 1}
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.lineItem}
                          onChange={(e) => updateItem(i, "lineItem", e.target.value)}
                          className="h-7 text-xs"
                          placeholder="Line item"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.partNo}
                          onChange={(e) => updateItem(i, "partNo", e.target.value)}
                          className="h-7 text-xs"
                          placeholder="Part number"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.description}
                          onChange={(e) => updateItem(i, "description", e.target.value)}
                          className="h-7 text-xs"
                          placeholder="Item description"
                          required
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.uom}
                          onChange={(e) => updateItem(i, "uom", e.target.value)}
                          className="h-7 text-xs"
                          placeholder="pc"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.qty}
                          onChange={(e) => updateItem(i, "qty", e.target.value)}
                          className="h-7 text-xs"
                          type="number"
                          placeholder="0"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.referencePrice}
                          onChange={(e) => updateItem(i, "referencePrice", e.target.value)}
                          className="h-7 text-xs"
                          type="number"
                          placeholder="0.00"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeItem(i)}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-col-reverse sm:flex-row gap-3 sm:justify-end">
            <Link href="/rfq">
              <a className="inline-flex items-center px-4 py-2 text-sm rounded border border-border text-muted-foreground hover:text-foreground">
                Cancel
              </a>
            </Link>
            <Button type="submit" disabled={createMutation.isPending || !customerRfqNo}>
              {createMutation.isPending ? "Creating..." : "Create RFQ"}
            </Button>
          </div>
        </form>
      </div>
    </Layout>
  );
}

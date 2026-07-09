import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
  useCreatePurchaseOrder,
  useListSuppliers,
  getListPurchaseOrdersQueryKey,
  getListSuppliersQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, ChevronDown, Loader2, Trash2 } from "lucide-react";

interface SheetItem {
  itemId: string | null;
  lineItem: string | null;
  partNo: string | null;
  description: string;
  uom: string | null;
  qty: number | null;
  referencePrice: number | null;
  poNo: string;
}

interface PoItemRow {
  id: string;
  itemId: string | null;
  lineItem: string | null;
  partNo: string | null;
  description: string;
  uom: string | null;
  qty: string;
  unitPrice: string;
  supplierId: string;
}

function useSheetPoNumbers() {
  return useQuery<{ poNumbers: string[] }>({
    queryKey: ["sheet-po-numbers"],
    queryFn: async () => {
      const res = await fetch("/api/po/sheets/po-numbers", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch PO numbers");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

async function fetchSupplierPrice(
  supplierId: number,
  description: string,
  partNo: string | null
): Promise<number | null> {
  const params = new URLSearchParams({ supplierId: String(supplierId), description });
  if (partNo) params.append("partNo", partNo);
  try {
    const res = await fetch(`/api/po/supplier-price?${params}`, { credentials: "include" });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.price === "number" ? data.price : null;
  } catch {
    return null;
  }
}

function PoNumberCombobox({
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

  useEffect(() => { setFilter(value); }, [value]);

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
          onChange={(e) => { setFilter(e.target.value); onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="e.g. PO-10023"
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
              onMouseDown={(e) => { e.preventDefault(); onChange(num); setFilter(num); setOpen(false); }}
            >
              {num}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function NewPurchaseOrderPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const [sheetPoNo, setSheetPoNo] = useState("");
  const [lookupQuery, setLookupQuery] = useState("");
  const [receiverName, setReceiverName] = useState("");
  const [receiverPhone, setReceiverPhone] = useState("");
  const [notes, setNotes] = useState("");

  const [isLookingUp, setIsLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [items, setItems] = useState<PoItemRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [priceLoadingIds, setPriceLoadingIds] = useState<Set<string>>(new Set());

  const { data: sheetPoNumbers } = useSheetPoNumbers();
  const suggestions = sheetPoNumbers?.poNumbers ?? [];

  const { data: suppliers } = useListSuppliers(
    {},
    { query: { queryKey: getListSuppliersQueryKey({}) } }
  );
  const activeSuppliers = (suppliers ?? []).filter((s) => s.isActive);

  const createMutation = useCreatePurchaseOrder({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
        navigate(`/purchase-orders`);
      },
    },
  });

  const handleLookup = async () => {
    if (!lookupQuery) return;
    setLookupError(null);
    setIsLookingUp(true);
    try {
      const url = `/api/po/lookup/${encodeURIComponent(lookupQuery)}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setLookupError(err.details ?? err.error ?? "Lookup failed");
        return;
      }
      const data: SheetItem[] = await res.json();
      if (data.length > 0) {
        const mapped: PoItemRow[] = data.map((item, idx) => ({
          id: `${idx}`,
          itemId: item.itemId,
          lineItem: item.lineItem,
          partNo: item.partNo,
          description: item.description,
          uom: item.uom,
          qty: item.qty != null ? String(item.qty) : "",
          unitPrice: "",
          supplierId: "",
        }));
        setItems(mapped);
        setSelectedIds(new Set(mapped.map((m) => m.id)));
        setSheetPoNo(lookupQuery);
      } else {
        setItems([]);
        setSelectedIds(new Set());
        setLookupError(`No items found for purchase order "${lookupQuery}".`);
      }
    } catch {
      setLookupError("Network error — could not reach the server.");
    } finally {
      setIsLookingUp(false);
    }
  };

  const toggleAll = () => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((i) => i.id)));
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

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setPriceLoadingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const updateUnitPrice = (id: string, unitPrice: string) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, unitPrice } : i)));

  const updateSupplier = (id: string, supplierId: string) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, supplierId, unitPrice: "" } : i)));

    if (supplierId) {
      const item = items.find((i) => i.id === id);
      if (item) {
        setPriceLoadingIds((prev) => new Set([...prev, id]));
        fetchSupplierPrice(parseInt(supplierId, 10), item.description, item.partNo)
          .then((price) => {
            setItems((prev) =>
              prev.map((i) =>
                i.id === id ? { ...i, unitPrice: price != null ? String(price) : "" } : i
              )
            );
          })
          .finally(() => {
            setPriceLoadingIds((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          });
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sheetPoNo) return;
    const chosen = items.filter((i) => selectedIds.has(i.id));
    if (chosen.length === 0) return;
    createMutation.mutate({
      data: {
        sheetPoNo,
        receiverName: receiverName || undefined,
        receiverPhone: receiverPhone || undefined,
        notes: notes || undefined,
        items: chosen.map((i) => ({
          itemId: i.itemId || undefined,
          lineItem: i.lineItem || undefined,
          partNo: i.partNo || undefined,
          description: i.description,
          uom: i.uom || undefined,
          qty: i.qty ? parseFloat(i.qty) : undefined,
          referencePrice: i.unitPrice ? parseFloat(i.unitPrice) : undefined,
          supplierId: i.supplierId ? parseInt(i.supplierId, 10) : undefined,
        })),
      },
    });
  };

  const allSelected = items.length > 0 && selectedIds.size === items.length;
  const selectedCount = selectedIds.size;

  return (
    <Layout>
      <div className="p-4 sm:p-6 max-w-6xl space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/purchase-orders">
            <a className="text-muted-foreground hover:text-foreground">
              <ArrowLeft size={18} />
            </a>
          </Link>
          <div>
            <h1 className="text-xl font-bold text-foreground">New Purchase Order</h1>
            <p className="text-muted-foreground text-sm">Create a purchase order from a PO number</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="bg-card border border-border rounded-lg p-4 space-y-3">
            <Label>Purchase order number (sheet column K)</Label>
            <div className="flex gap-2">
              <div className="flex-1">
                <PoNumberCombobox value={lookupQuery} onChange={setLookupQuery} suggestions={suggestions} />
              </div>
              <Button type="button" onClick={handleLookup} disabled={isLookingUp || !lookupQuery}>
                {isLookingUp ? "Searching..." : "Fetch items"}
              </Button>
            </div>
            {lookupError && <p className="text-sm text-red-600">{lookupError}</p>}
          </div>

          {items.length > 0 && (
            <>
              <div className="bg-card border border-border rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/30 border-b border-border text-left">
                        <th className="px-3 py-2.5">
                          <button type="button" onClick={toggleAll} className="text-muted-foreground">
                            <input type="checkbox" checked={allSelected} readOnly className="cursor-pointer" onClick={toggleAll} />
                          </button>
                        </th>
                        <th className="px-2 py-2.5 text-muted-foreground text-xs font-medium">Line item</th>
                        <th className="px-2 py-2.5 text-muted-foreground text-xs font-medium">Part no.</th>
                        <th className="px-2 py-2.5 text-muted-foreground text-xs font-medium">Description</th>
                        <th className="px-2 py-2.5 text-muted-foreground text-xs font-medium">UOM</th>
                        <th className="px-2 py-2.5 text-muted-foreground text-xs font-medium">Qty (PO)</th>
                        <th className="px-2 py-2.5 text-muted-foreground text-xs font-medium min-w-[160px]">Supplier</th>
                        <th className="px-2 py-2.5 text-muted-foreground text-xs font-medium min-w-[120px]">Unit price</th>
                        <th className="px-2 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((row) => (
                        <tr key={row.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                          <td className="px-3 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(row.id)}
                              onChange={() => toggleOne(row.id)}
                              className="cursor-pointer"
                            />
                          </td>
                          <td className="px-2 py-1.5 text-xs">{row.lineItem || "—"}</td>
                          <td className="px-2 py-1.5 text-xs">{row.partNo || "—"}</td>
                          <td className="px-2 py-1.5 text-xs max-w-[220px]">{row.description}</td>
                          <td className="px-2 py-1.5 text-xs">{row.uom || "—"}</td>
                          <td className="px-2 py-1.5 text-xs font-medium">{row.qty || "—"}</td>
                          <td className="px-2 py-1.5">
                            <select
                              value={row.supplierId}
                              onChange={(e) => updateSupplier(row.id, e.target.value)}
                              disabled={!selectedIds.has(row.id)}
                              className="h-7 w-full text-xs rounded border border-border bg-background px-1.5 disabled:opacity-50"
                            >
                              <option value="">Select supplier...</option>
                              {activeSuppliers.map((s) => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2 py-1.5">
                            {priceLoadingIds.has(row.id) ? (
                              <div className="flex items-center gap-1 text-xs text-muted-foreground h-7 px-1.5">
                                <Loader2 size={11} className="animate-spin" />
                                <span>Loading...</span>
                              </div>
                            ) : (
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={row.unitPrice}
                                onChange={(e) => updateUnitPrice(row.id, e.target.value)}
                                disabled={!selectedIds.has(row.id)}
                                placeholder={row.supplierId ? "No offer found" : "—"}
                                className="h-7 text-xs w-28 disabled:opacity-50"
                              />
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <button type="button" onClick={() => removeItem(row.id)} className="text-muted-foreground hover:text-destructive">
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="px-4 py-2.5 border-t border-border bg-muted/10 text-xs text-muted-foreground">
                  Unit prices are auto-filled from the supplier's most recent offer. You can edit them manually if needed.
                </div>
              </div>

              <div className="bg-card border border-border rounded-lg p-4 grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Receiver representative name</Label>
                  <Input value={receiverName} onChange={(e) => setReceiverName(e.target.value)} placeholder="Name of the receiving representative" />
                </div>
                <div className="space-y-1.5">
                  <Label>Receiver representative phone</Label>
                  <Input value={receiverPhone} onChange={(e) => setReceiverPhone(e.target.value)} placeholder="Phone number" />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Notes</Label>
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" />
                </div>
              </div>

              <div className="flex flex-col-reverse sm:flex-row gap-3 sm:justify-end sm:items-center">
                <p className="text-sm text-muted-foreground sm:mr-auto">
                  {selectedCount} item{selectedCount !== 1 ? "s" : ""} selected
                </p>
                <Link href="/purchase-orders">
                  <a className="inline-flex items-center px-4 py-2 text-sm rounded border border-border text-muted-foreground hover:text-foreground">
                    Cancel
                  </a>
                </Link>
                <Button type="submit" disabled={createMutation.isPending || !sheetPoNo || selectedCount === 0}>
                  {createMutation.isPending ? "Creating..." : "Create purchase order"}
                </Button>
              </div>

              {createMutation.isError && (
                <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
                  Something went wrong while creating the purchase order. Please try again.
                </div>
              )}
            </>
          )}
        </form>
      </div>
    </Layout>
  );
}

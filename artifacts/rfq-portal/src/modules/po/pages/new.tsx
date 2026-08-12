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
import {
  SupplierCombobox,
  RepresentativeNameInput,
  useRepresentatives,
  fetchSupplierPrice,
  type PoItemRow,
} from "../components/fields";

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

interface CustomerPoSuggestion {
  value: string;
  label: string;
  internalNo: string;
  customerName: string | null;
  status: string;
}

function useCustomerPoNumbers() {
  return useQuery<{ poNumbers: CustomerPoSuggestion[] }>({
    queryKey: ["customer-po-numbers"],
    queryFn: async () => {
      const res = await fetch("/api/po/customer-po-numbers", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch customer PO numbers");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

// Merge sheet PO numbers and customer PO numbers into one deduped list. Items
// present in both (a PO both in the sheet and entered on /customer-po) keep
// the richer customer-PO entry so its internalNo/customerName show in the
// dropdown.
function useMergedPoSuggestions(): CustomerPoSuggestion[] {
  const { data: sheetPoNumbers } = useSheetPoNumbers();
  const { data: customerPoNumbers } = useCustomerPoNumbers();
  const customer = customerPoNumbers?.poNumbers ?? [];
  const byValue = new Map<string, CustomerPoSuggestion>();
  for (const s of customer) byValue.set(s.value.toLowerCase(), s);
  for (const num of sheetPoNumbers?.poNumbers ?? []) {
    const key = num.toLowerCase();
    if (!byValue.has(key)) {
      byValue.set(key, {
        value: num,
        label: num,
        internalNo: "",
        customerName: null,
        status: "",
      });
    }
  }
  return Array.from(byValue.values());
}

function PoNumberCombobox({
  value,
  onChange,
  suggestions,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: CustomerPoSuggestion[];
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = filter
    ? suggestions.filter((s) => s.value.toLowerCase().includes(filter.toLowerCase())).slice(0, 50)
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
        <ul className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto bg-popover border border-border rounded-md shadow-md text-sm">
          {filtered.map((s) => (
            <li
              key={s.value + s.internalNo}
              className="px-3 py-1.5 cursor-pointer hover:bg-accent hover:text-accent-foreground"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(s.value);
                setFilter(s.value);
                setOpen(false);
              }}
            >
              <div className="font-medium" dir="ltr">{s.value}</div>
              {s.internalNo || s.customerName ? (
                <div className="text-xs text-muted-foreground">
                  {s.internalNo}
                  {s.customerName ? ` · ${s.customerName}` : ""}
                  {s.status ? ` · ${s.status}` : ""}
                </div>
              ) : null}
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

  const suggestions = useMergedPoSuggestions();
  const { data: representativesData } = useRepresentatives();
  const representatives = representativesData ?? [];

  const { data: suppliers } = useListSuppliers(
    {},
    { query: { queryKey: getListSuppliersQueryKey({}) } },
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
          unitPrice: item.referencePrice != null ? String(item.referencePrice) : "",
          supplierId: "",
          taxIncluded: false,
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
    if (selectedIds.size === items.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(items.map((i) => i.id)));
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

  const updateTaxIncluded = (id: string, taxIncluded: boolean) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, taxIncluded } : i)));

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
                i.id === id ? { ...i, unitPrice: price != null ? String(price) : "" } : i,
              ),
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

  // Live totals summary
  const selectedItems = items.filter((i) => selectedIds.has(i.id));
  const grandTotal = selectedItems.reduce((sum, i) => {
    const qty = parseFloat(i.qty) || 0;
    const price = parseFloat(i.unitPrice) || 0;
    return sum + qty * price;
  }, 0);
  const vatTotal = selectedItems.reduce((sum, i) => {
    if (!i.taxIncluded) return sum;
    const qty = parseFloat(i.qty) || 0;
    const price = parseFloat(i.unitPrice) || 0;
    const lineTotal = qty * price;
    return sum + (lineTotal - lineTotal / 1.14);
  }, 0);
  const preTaxTotal = grandTotal - vatTotal;
  const hasAnyPrice = selectedItems.some((i) => parseFloat(i.unitPrice) > 0);
  const hasTaxItems = selectedItems.some((i) => i.taxIncluded && parseFloat(i.unitPrice) > 0);

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
          taxIncluded: i.taxIncluded,
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
            <p className="text-muted-foreground text-sm">
              Create a purchase order from a PO number
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="bg-card border border-border rounded-lg p-4 space-y-3">
            <Label>رقم أمر الشراء</Label>
            <div className="flex gap-2">
              <div className="flex-1">
                <PoNumberCombobox
                  value={lookupQuery}
                  onChange={setLookupQuery}
                  suggestions={suggestions}
                />
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
                          <input
                            type="checkbox"
                            checked={allSelected}
                            readOnly
                            className="cursor-pointer"
                            onClick={toggleAll}
                          />
                        </th>
                        <th className="px-2 py-2.5 text-muted-foreground text-xs font-medium">
                          Line item
                        </th>
                        <th className="px-2 py-2.5 text-muted-foreground text-xs font-medium">
                          Part no.
                        </th>
                        <th className="px-2 py-2.5 text-muted-foreground text-xs font-medium">
                          Description
                        </th>
                        <th className="px-2 py-2.5 text-muted-foreground text-xs font-medium">
                          UOM
                        </th>
                        <th className="px-2 py-2.5 text-muted-foreground text-xs font-medium">
                          Qty (PO)
                        </th>
                        <th className="px-2 py-2.5 text-muted-foreground text-xs font-medium min-w-[160px]">
                          Supplier
                        </th>
                        <th className="px-2 py-2.5 text-muted-foreground text-xs font-medium min-w-[120px]">
                          Unit price
                        </th>
                        <th
                          className="px-2 py-2.5 text-muted-foreground text-xs font-medium text-center"
                          title="السعر شامل ضريبة القيمة المضافة 14%"
                        >
                          شامل ض.ق.م
                        </th>
                        <th className="px-2 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((row) => (
                        <tr
                          key={row.id}
                          className={`border-b border-border last:border-0 hover:bg-muted/20 ${row.taxIncluded && selectedIds.has(row.id) ? "bg-green-50/40 dark:bg-green-950/20" : ""}`}
                        >
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
                            <SupplierCombobox
                              value={row.supplierId}
                              onChange={(id) => updateSupplier(row.id, id)}
                              suppliers={activeSuppliers}
                              disabled={!selectedIds.has(row.id)}
                            />
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
                          {/* Tax included checkbox */}
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={row.taxIncluded}
                              onChange={(e) => updateTaxIncluded(row.id, e.target.checked)}
                              disabled={!selectedIds.has(row.id)}
                              className="cursor-pointer h-4 w-4 accent-green-600 disabled:opacity-40"
                              title="السعر شامل ضريبة القيمة المضافة 14%"
                            />
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <button
                              type="button"
                              onClick={() => removeItem(row.id)}
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Totals summary */}
                {hasAnyPrice && (
                  <div className="border-t border-border bg-muted/10 px-4 py-3 flex flex-col items-end gap-1 text-sm">
                    {hasTaxItems && (
                      <>
                        <div className="flex gap-6 text-muted-foreground text-xs">
                          <span>الإجمالي قبل الضريبة</span>
                          <span className="font-medium text-foreground tabular-nums">
                            {preTaxTotal.toLocaleString("en-US", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </span>
                        </div>
                        <div className="flex gap-6 text-muted-foreground text-xs">
                          <span>ضريبة القيمة المضافة (14%)</span>
                          <span className="font-medium text-green-700 tabular-nums">
                            +{" "}
                            {vatTotal.toLocaleString("en-US", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </span>
                        </div>
                      </>
                    )}
                    <div className="flex gap-6 text-sm font-semibold">
                      <span>{hasTaxItems ? "الإجمالي الكلي" : "الإجمالي"}</span>
                      <span className="tabular-nums">
                        {grandTotal.toLocaleString("en-US", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </div>
                  </div>
                )}

                <div className="px-4 py-2 border-t border-border bg-muted/5 text-xs text-muted-foreground">
                  Unit prices auto-filled from supplier's latest offer. Check{" "}
                  <strong>شامل ض.ق.م</strong> if the price already includes 14% VAT.
                </div>
              </div>

              <div className="bg-card border border-border rounded-lg p-4 grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Receiver representative name <span className="text-xs text-muted-foreground">(select or type manually)</span></Label>
                  <RepresentativeNameInput
                    value={receiverName}
                    onChange={setReceiverName}
                    onSelect={(representative) => setReceiverPhone(representative.phone)}
                    representatives={representatives}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Receiver representative phone</Label>
                  <Input
                    value={receiverPhone}
                    onChange={(e) => setReceiverPhone(e.target.value)}
                    placeholder="Phone number"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Notes</Label>
                  <Input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Optional notes"
                  />
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
                <Button
                  type="submit"
                  disabled={createMutation.isPending || !sheetPoNo || selectedCount === 0}
                >
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

import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { ChevronDown } from "lucide-react";

export type RepresentativeOption = {
  id: number;
  name: string;
  phone: string;
  isActive: boolean;
};

export interface PoItemRow {
  id: string;
  itemId: string | null;
  customerPoItemId: number | null;
  lineItem: string | null;
  partNo: string | null;
  description: string;
  uom: string | null;
  qty: string;
  unitPrice: string;
  supplierId: string;
  taxIncluded: boolean;
}

export function useRepresentatives() {
  return useQuery<RepresentativeOption[]>({
    queryKey: ["representatives"],
    queryFn: async () => {
      const res = await fetch("/api/representatives", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch representatives");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function RepresentativeNameInput({
  value,
  onChange,
  onSelect,
  representatives,
}: {
  value: string;
  onChange: (value: string) => void;
  onSelect: (representative: RepresentativeOption) => void;
  representatives: RepresentativeOption[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRepresentatives = representatives.filter((rep) => rep.isActive);
  const filtered = (query.trim()
    ? activeRepresentatives.filter((rep) =>
        `${rep.name} ${rep.phone}`.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : activeRepresentatives
  ).slice(0, 50);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  const selectRepresentative = (representative: RepresentativeOption) => {
    onChange(representative.name);
    onSelect(representative);
    setQuery(representative.name);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex">
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Select or type the receiving representative name"
          className="rounded-r-none"
        />
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-label="Show representatives"
          className="border border-l-0 border-border rounded-r-md px-3 bg-muted hover:bg-muted/80 text-muted-foreground"
        >
          <ChevronDown size={16} />
        </button>
      </div>
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto bg-popover border border-border rounded-md shadow-lg">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              No saved representatives. You can keep typing manually.
            </div>
          ) : (
            filtered.map((representative) => (
              <button
                key={representative.id}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectRepresentative(representative)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground border-b border-border/50 last:border-0"
              >
                <span className="block font-medium">{representative.name}</span>
                <span className="block text-xs text-muted-foreground">{representative.phone}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function SupplierCombobox({
  value,
  onChange,
  suppliers,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  suppliers: { id: number; name: string }[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = suppliers.find((s) => String(s.id) === value);
  const displayValue = open ? query : (selected?.name ?? "");

  const filtered = query
    ? suppliers.filter((s) => s.name.toLowerCase().includes(query.toLowerCase())).slice(0, 50)
    : suppliers.slice(0, 50);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const handleSelect = (id: number) => {
    onChange(String(id));
    setQuery("");
    setOpen(false);
  };
  const handleClear = () => {
    onChange("");
    setQuery("");
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex">
        <input
          type="text"
          value={displayValue}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setQuery("");
            setOpen(true);
          }}
          disabled={disabled}
          placeholder="Type to search..."
          className="h-7 w-full flex-1 min-w-0 text-xs rounded-l border border-border bg-background px-1.5 disabled:opacity-50 outline-none focus:ring-1 focus:ring-ring"
        />
        {value ? (
          <button
            type="button"
            disabled={disabled}
            onClick={handleClear}
            className="border border-l-0 border-border rounded-r-md px-1.5 bg-muted hover:bg-muted/80 text-muted-foreground disabled:opacity-50"
            title="Clear"
          >
            ×
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setOpen((o) => !o)}
            className="border border-l-0 border-border rounded-r-md px-1.5 bg-muted hover:bg-muted/80 text-muted-foreground disabled:opacity-50"
          >
            <ChevronDown size={12} />
          </button>
        )}
      </div>
      {open && (
        <ul className="absolute z-50 mt-1 w-full min-w-[180px] max-h-48 overflow-y-auto bg-popover border border-border rounded-md shadow-lg text-xs">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">No suppliers found</li>
          ) : (
            filtered.map((s) => (
              <li
                key={s.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSelect(s.id);
                }}
                className={`px-3 py-1.5 cursor-pointer hover:bg-accent hover:text-accent-foreground ${String(s.id) === value ? "font-medium bg-accent/50" : ""}`}
              >
                {s.name}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** Fetch a supplier's most recent quoted price for an item (by description / partNo). */
export async function fetchSupplierPrice(
  supplierId: number,
  description: string,
  partNo: string | null,
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

export interface RfqOption {
  id: number;
  internalRfqNo: string;
  customerRfqNo: string;
  status: string;
}

/** RFQs eligible for linking to a PO — SENT, QUOTED, and SUCCESS (so one RFQ
 *  can be linked to more than one purchase order). */
export function useRfqOptions() {
  return useQuery<RfqOption[]>({
    queryKey: ["rfq-options-for-po"],
    queryFn: async () => {
      const res = await fetch("/api/rfq", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch RFQs");
      const all: RfqOption[] = await res.json();
      return all.filter((r) => r.status === "SENT" || r.status === "QUOTED" || r.status === "SUCCESS");
    },
    staleTime: 60 * 1000,
  });
}

/** Searchable type-ahead combobox for picking a linked RFQ. Typing filters by
 *  internal RFQ number or customer RFQ number. */
export function RfqCombobox({
  value,
  onChange,
  rfqs,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  rfqs: RfqOption[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = rfqs.find((r) => String(r.id) === value);
  const selectedLabel = selected
    ? `${selected.internalRfqNo} (${selected.customerRfqNo})`
    : "";
  const displayValue = open ? query : selectedLabel;

  const filtered = query
    ? rfqs
        .filter((r) =>
          `${r.internalRfqNo} ${r.customerRfqNo}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        )
        .slice(0, 50)
    : rfqs.slice(0, 50);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const handleSelect = (id: number) => {
    onChange(String(id));
    setQuery("");
    setOpen(false);
  };
  const handleClear = () => {
    onChange("");
    setQuery("");
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative flex-1">
      <div className="flex">
        <input
          type="text"
          value={displayValue}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setQuery("");
            setOpen(true);
          }}
          disabled={disabled}
          placeholder="اكتب للبحث عن طلب تسعير..."
          className="flex-1 min-w-0 text-sm border border-border rounded-r-md bg-background px-3 py-1.5 disabled:opacity-50 outline-none focus:ring-2 focus:ring-ring"
        />
        {value ? (
          <button
            type="button"
            disabled={disabled}
            onClick={handleClear}
            className="border border-r-0 border-border rounded-l-md px-3 bg-muted hover:bg-muted/80 text-muted-foreground disabled:opacity-50"
            title="مسح"
          >
            ×
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setOpen((o) => !o)}
            className="border border-r-0 border-border rounded-l-md px-3 bg-muted hover:bg-muted/80 text-muted-foreground disabled:opacity-50"
            aria-label="عرض طلبات التسعير"
          >
            <ChevronDown size={16} />
          </button>
        )}
      </div>
      {open && (
        <ul className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto bg-popover border border-border rounded-md shadow-lg text-sm">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">لا توجد طلبات تسعير مطابقة</li>
          ) : (
            filtered.map((r) => (
              <li
                key={r.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSelect(r.id);
                }}
                className={`px-3 py-2 cursor-pointer hover:bg-accent hover:text-accent-foreground border-b border-border/50 last:border-0 ${String(r.id) === value ? "font-medium bg-accent/50" : ""}`}
              >
                <span className="block font-mono">{r.internalRfqNo}</span>
                <span className="block text-xs text-muted-foreground">
                  {r.customerRfqNo} — {r.status}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

import { useState, useRef, useEffect } from "react";
import { useListCustomers, getListCustomersQueryKey, type Customer } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { ChevronDown } from "lucide-react";

// Combobox: type to filter, or pick from existing customers. Free text allowed so
// a customer name can be entered even if not yet registered.
export function CustomerCombobox({
  value,
  onChange,
  onPick,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (c: Customer) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: customers, isLoading } = useListCustomers(undefined, {
    query: { queryKey: getListCustomersQueryKey() },
  });

  const filtered = filter
    ? (customers ?? [])
        .filter(
          (c) =>
            c.name.toLowerCase().includes(filter.toLowerCase()) ||
            (c.nickname ?? "").toLowerCase().includes(filter.toLowerCase()) ||
            (c.customerId ?? "").toLowerCase().includes(filter.toLowerCase()),
        )
        .slice(0, 50)
    : (customers ?? []).slice(0, 50);

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
          placeholder="اختر العميل أو اكتب اسمه"
          className="rounded-l-none"
          dir="rtl"
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="border border-r-0 border-border rounded-r-md px-2 bg-muted hover:bg-muted/80 text-muted-foreground"
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {open && (
        <ul className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto bg-popover border border-border rounded-md shadow-md text-sm">
          {isLoading ? (
            <li className="px-3 py-2 text-muted-foreground">جارٍ التحميل...</li>
          ) : filtered.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">
              لا يوجد عملاء مطابقون — سيُسجّل الاسم كما هو.
            </li>
          ) : (
            filtered.map((c) => (
              <li
                key={c.id}
                className="px-3 py-1.5 cursor-pointer hover:bg-accent hover:text-accent-foreground"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(c);
                  setFilter(c.name);
                  setOpen(false);
                }}
              >
                <div className="font-medium">{c.name}</div>
                {c.nickname && (
                  <div className="text-xs text-muted-foreground">{c.nickname}</div>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

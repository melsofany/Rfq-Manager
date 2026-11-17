import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { orderCategoryTree } from "@/lib/category-tree";
import { cn } from "@/lib/utils";

interface CategoryOption {
  id: number;
  name: string;
  parentId?: number | null;
}

/**
 * A compact, searchable single-select for a category catalogue.
 *
 * The list screen used to render the whole catalogue as a wall of chips —
 * fifty-plus buttons per dimension, which the operator described as «مشوّهة
 * وتشتت النظر». A dropdown keeps the same data reachable while occupying one
 * line, and a filter box makes a long tree usable.
 *
 * `onPick` receives the option (the trade filter matches by NAME, the item
 * filter by ID), so the caller decides the value it needs.
 */
export function CategoryFilterSelect({
  label,
  icon,
  options,
  selectedLabel,
  onPick,
  onClear,
  emptyText = "لا توجد تصنيفات",
  tone = "primary",
}: {
  label: string;
  icon?: React.ReactNode;
  options: CategoryOption[];
  selectedLabel: string | null;
  onPick: (option: CategoryOption) => void;
  onClear: () => void;
  emptyText?: string;
  tone?: "primary" | "emerald";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const ordered = useMemo(() => orderCategoryTree(options), [options]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((c) => c.name.toLowerCase().includes(q));
  }, [ordered, query]);

  const toneRing =
    tone === "emerald"
      ? "border-emerald-500/60 bg-emerald-50 dark:bg-emerald-950/30"
      : "border-primary/60 bg-primary/5";

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs font-medium transition-colors",
          selectedLabel
            ? toneRing + " text-foreground"
            : "border-border bg-background text-muted-foreground hover:text-foreground",
        )}
      >
        {icon}
        <span className="text-muted-foreground">{label}</span>
        {selectedLabel ? (
          <>
            <span className="font-semibold text-foreground">{selectedLabel}</span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
              className="text-muted-foreground hover:text-destructive"
            >
              <X size={12} />
            </span>
          </>
        ) : (
          <span className="text-foreground">الكل</span>
        )}
        <ChevronDown size={13} className="text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute z-40 mt-1 w-64 rounded-md border border-border bg-popover shadow-lg">
          <div className="relative border-b border-border">
            <Search
              size={13}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="بحث..."
              className="h-8 w-full bg-transparent pr-7 pl-2 text-xs text-foreground outline-none"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {ordered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">{emptyText}</p>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">لا نتائج مطابقة</p>
            ) : (
              filtered.map((c) => {
                const active = selectedLabel === c.name;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      onPick(c);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-right text-xs transition-colors hover:bg-muted/60",
                      active ? "font-semibold text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {active ? (
                      <Check size={12} className="shrink-0 text-primary" />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <span className={cn("flex-1", c.depth > 0 && "pr-3")}>
                      {c.depth > 0 ? "↳ " : ""}
                      {c.name}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import { useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { orderCategoryTree, type CategoryNode } from "@/lib/category-tree";
import { cn } from "@/lib/utils";

/**
 * Picks SEVERAL trade categories for one supplier.
 *
 * A supplier can belong to more than one category, so the selection is always
 * visible as a count and as removable chips, and the full list is searchable
 * and shows the parent/child hierarchy.
 */
export function TradeCategoryPicker({
  options,
  selected,
  onToggle,
}: {
  options: CategoryNode[];
  selected: string[];
  onToggle: (name: string) => void;
}) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");

  const ordered = useMemo(() => orderCategoryTree(options), [options]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const q = query.trim().toLowerCase();
  const shown = q ? ordered.filter((c) => c.name.toLowerCase().includes(q)) : ordered;
  const selectedSorted = useMemo(
    () => [...selected].sort((a, b) => a.localeCompare(b)),
    [selected],
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="space-y-2 border-b border-border bg-muted/20 px-3 py-2.5">
        <p className="text-xs font-semibold text-foreground">
          {t("sup.pick.selected", { n: selected.length })}
        </p>
        {selectedSorted.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("sup.pick.none")}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {selectedSorted.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 ps-2.5 pe-1 text-xs font-medium text-primary"
              >
                {name}
                <button
                  type="button"
                  onClick={() => onToggle(name)}
                  aria-label={name}
                  className="flex size-4 items-center justify-center rounded-full hover:bg-primary/20"
                >
                  <X size={11} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="relative border-b border-border">
        <Search
          size={13}
          aria-hidden
          className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("sup.filter.search")}
          aria-label={t("sup.filter.search")}
          className="h-9 w-full bg-transparent ps-8 pe-3 text-sm text-foreground outline-none"
        />
      </div>

      <ul role="listbox" aria-multiselectable="true" className="max-h-64 overflow-y-auto py-1">
        {shown.map((c) => {
          const on = selectedSet.has(c.name);
          return (
            <li key={c.id}>
              <button
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => onToggle(c.name)}
                className={cn(
                  "flex w-full items-center gap-2.5 py-2 pe-3 text-start text-sm transition-colors hover:bg-muted/50",
                  on && "bg-primary/5",
                )}
                style={{ paddingInlineStart: 12 + c.depth * 20 }}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    on ? "border-primary bg-primary text-primary-foreground" : "border-border",
                  )}
                >
                  {on && <Check size={11} />}
                </span>
                <span
                  className={c.depth > 0 ? "text-muted-foreground" : "font-medium text-foreground"}
                >
                  {c.name}
                </span>
              </button>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="px-3 py-4 text-center text-xs text-muted-foreground">
            {t("sup.filter.noResults")}
          </li>
        )}
      </ul>
    </div>
  );
}

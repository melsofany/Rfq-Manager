import { Boxes, Search, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CategoryFilterSelect } from "../CategoryFilterSelect";
import type { CategoryNodeLite, Translate } from "./supplier-display";

export interface SupplierListToolbarProps {
  t: Translate;
  search: string;
  onSearch: (value: string) => void;
  tradeOptions: CategoryNodeLite[];
  tradeLabel: string | null;
  onPickTrade: (name: string) => void;
  onClearTrade: () => void;
  itemOptions: CategoryNodeLite[];
  itemLabel: string | null;
  onPickItem: (id: number) => void;
  onClearItem: () => void;
  hasFilter: boolean;
  onClearAll: () => void;
  countLabel: string;
  isLoading: boolean;
  stats: { active: number; inactive: number; noVat: number };
}

/**
 * Filter bar: one search box and two category filters on a single line, with
 * a summary strip underneath so the operator can read the result at a glance.
 */
export function SupplierListToolbar({
  t,
  search,
  onSearch,
  tradeOptions,
  tradeLabel,
  onPickTrade,
  onClearTrade,
  itemOptions,
  itemLabel,
  onPickItem,
  onClearItem,
  hasFilter,
  onClearAll,
  countLabel,
  isLoading,
  stats,
}: SupplierListToolbarProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 md:max-w-xs">
          <Search
            size={14}
            aria-hidden
            className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={t("sup.searchPlaceholder")}
            aria-label={t("sup.searchPlaceholder")}
            className="h-8 pr-8 text-sm"
          />
        </div>
        <CategoryFilterSelect
          label={t("sup.filter.trade")}
          icon={<Tag size={12} className="text-muted-foreground" />}
          options={tradeOptions}
          selectedLabel={tradeLabel}
          onPick={(c) => onPickTrade(c.name)}
          onClear={onClearTrade}
          emptyText={t("sup.filter.noTrade")}
        />
        <CategoryFilterSelect
          label={t("sup.filter.item")}
          icon={<Boxes size={12} className="text-emerald-600" />}
          options={itemOptions}
          selectedLabel={itemLabel}
          onPick={(c) => onPickItem(c.id)}
          onClear={onClearItem}
          emptyText={t("sup.filter.noItem")}
          tone="emerald"
        />
        {hasFilter && (
          <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={onClearAll}>
            <X size={14} /> {t("sup.clearFilters")}
          </Button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{countLabel}</span>
        {!isLoading && (
          <>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1.5 rounded-full bg-green-500" />
              {t("sup.active")} {stats.active}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" />
              {t("sup.inactive")} {stats.inactive}
            </span>
            {stats.noVat > 0 && (
              <span className="font-medium text-amber-700 dark:text-amber-400">
                {t("sup.noVat")} {stats.noVat}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

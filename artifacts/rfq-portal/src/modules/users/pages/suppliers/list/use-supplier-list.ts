import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useListCategories, getListCategoriesQueryKey } from "@workspace/api-client-react";
import { useDebounced } from "@/hooks/use-debounced";
import type { CategoryNodeLite, SupplierRow } from "./supplier-display";

export type TradeFilter = string | "all";
export type ItemFilter = number | "all";

/**
 * Data and filter state for the suppliers list. The trade filter matches by
 * NAME (the API takes a name), the item filter by ID.
 */
export function useSupplierList() {
  const [search, setSearch] = useState("");
  const [tradeCategory, setTradeCategory] = useState<TradeFilter>("all");
  const [itemCategoryId, setItemCategoryId] = useState<ItemFilter>("all");
  const debouncedSearch = useDebounced(search);

  const { data: tradeCategories = [] } = useListCategories({
    query: { queryKey: getListCategoriesQueryKey() },
  });

  // The ITEM-category catalogue is a different list from the trade one. The
  // item-category filter is not in the OpenAPI spec, so it is fetched directly.
  const { data: itemCategories = [] } = useQuery<CategoryNodeLite[]>({
    queryKey: ["item-categories"],
    queryFn: async () => {
      const res = await fetch("/api/item-categories", { credentials: "include" });
      if (!res.ok) throw new Error("failed");
      return (await res.json()) as CategoryNodeLite[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: suppliersRaw, isLoading } = useQuery<SupplierRow[]>({
    queryKey: ["suppliers", tradeCategory, itemCategoryId, debouncedSearch],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (tradeCategory !== "all") qs.set("category", tradeCategory);
      if (debouncedSearch) qs.set("search", debouncedSearch);
      if (itemCategoryId !== "all") qs.set("itemCategoryId", String(itemCategoryId));
      const res = await fetch(`/api/suppliers${qs.toString() ? `?${qs}` : ""}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("failed");
      return (await res.json()) as SupplierRow[];
    },
  });

  const suppliers = useMemo(() => suppliersRaw ?? [], [suppliersRaw]);

  const stats = useMemo(
    () => ({
      active: suppliers.filter((s) => s.isActive).length,
      inactive: suppliers.filter((s) => !s.isActive).length,
      noVat: suppliers.filter((s) => s.invoiceHasVat === false).length,
    }),
    [suppliers],
  );

  const hasFilter = tradeCategory !== "all" || itemCategoryId !== "all" || Boolean(search);

  const clearFilters = () => {
    setSearch("");
    setTradeCategory("all");
    setItemCategoryId("all");
  };

  return {
    search,
    setSearch,
    tradeCategory,
    setTradeCategory,
    itemCategoryId,
    setItemCategoryId,
    tradeCategories,
    itemCategories,
    suppliers,
    stats,
    isLoading,
    hasFilter,
    clearFilters,
  };
}

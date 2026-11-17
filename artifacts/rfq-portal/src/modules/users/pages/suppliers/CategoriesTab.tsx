import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useListCategories, getListCategoriesQueryKey } from "@workspace/api-client-react";
import { Boxes, Search, Tag } from "lucide-react";
import { Input } from "@/components/ui/input";
import { orderCategoryTree } from "@/lib/category-tree";
import { CategoryManagerDialog } from "./CategoryManagerDialog";
import { useLanguage } from "@/contexts/LanguageContext";

interface ItemCategoryRow {
  id: number;
  name: string;
  parentId?: number | null;
  code?: string | null;
}

function CatalogueList({
  rows,
  emptyText,
}: {
  rows: { id: number; name: string; depth: number }[];
  emptyText: string;
}) {
  if (rows.length === 0)
    return <p className="px-4 py-6 text-center text-xs text-muted-foreground">{emptyText}</p>;
  return (
    <ul className="divide-y divide-border">
      {rows.map((c) => (
        <li
          key={c.id}
          className="flex items-center gap-2 px-4 py-2 text-sm text-foreground"
          style={{ paddingRight: 16 + c.depth * 20 }}
        >
          <span className={c.depth > 0 ? "text-muted-foreground" : "font-medium"}>
            {c.depth > 0 ? "↳ " : ""}
            {c.name}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * «التصنيفات» — a tab of its own.
 *
 * The list screen used to carry the whole catalogue as two walls of chips
 * (fifty-plus buttons each), which the operator rejected as «مشوّهة وتشتت
 * النظر». The catalogue now lives here, where there is room to read it, and the
 * list screen keeps a compact searchable filter instead.
 *
 * Two catalogues, deliberately side by side because they answer different
 * questions:
 *   • التصنيفات التجارية — how we GROUP suppliers (what a supplier trades in).
 *   • تصنيفات البنود — what a supplier can SUPPLY (item level).
 */
export function CategoriesTab({ canManage }: { canManage: boolean }) {
  const { t } = useLanguage();
  const [search, setSearch] = useState("");

  const { data: tradeCategories = [] } = useListCategories({
    query: { queryKey: getListCategoriesQueryKey() },
  });

  const { data: itemCategories = [], isLoading } = useQuery<ItemCategoryRow[]>({
    queryKey: ["item-categories"],
    queryFn: async () => {
      const res = await fetch("/api/item-categories", { credentials: "include" });
      if (!res.ok) throw new Error("failed");
      return (await res.json()) as ItemCategoryRow[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const orderedItem = useMemo(() => {
    const tree = orderCategoryTree(itemCategories);
    const q = search.trim().toLowerCase();
    if (!q) return tree;
    return tree.filter((c) => c.name.toLowerCase().includes(q));
  }, [itemCategories, search]);

  const orderedTrade = useMemo(() => orderCategoryTree(tradeCategories), [tradeCategories]);

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6">
      <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
        <Tag size={16} className="mt-0.5 shrink-0 text-primary" />
        <div className="text-xs leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">{t("sup.cat.kind.title")}</p>
          <p>{t("sup.cat.kind.body")}</p>
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">{t("sup.cat.trade.heading")}</h2>
        <p className="text-xs text-muted-foreground">
          {canManage ? t("sup.cat.trade.manage") : t("sup.cat.trade.viewOnly")}
        </p>
        {canManage ? (
          <CategoryManagerDialog variant="panel" />
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <CatalogueList rows={orderedTrade} emptyText={t("sup.cat.empty")} />
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Boxes size={15} className="text-emerald-600" />
            {t("sup.cat.item.heading")}
          </h2>
          <div className="relative w-56">
            <Search
              size={14}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("sup.cat.item.search")}
              className="h-8 pr-7 text-sm"
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">{t("sup.cat.learnHint")}</p>

        <div className="rounded-lg border border-border bg-card">
          {isLoading ? (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">
              {t("sup.loading")}
            </p>
          ) : (
            <CatalogueList rows={orderedItem} emptyText={t("sup.cat.empty")} />
          )}
        </div>
      </section>
    </div>
  );
}

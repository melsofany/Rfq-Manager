import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useListCategories, getListCategoriesQueryKey } from "@workspace/api-client-react";
import { Boxes, Search, Tag } from "lucide-react";
import { Input } from "@/components/ui/input";
import { orderCategoryTree } from "@/lib/category-tree";
import { useLanguage } from "@/contexts/LanguageContext";
import { TradeCategoryManager } from "./TradeCategoryManager";

interface ItemCategoryRow {
  id: number;
  name: string;
  parentId?: number | null;
  code?: string | null;
}

/** One card per catalogue: the same header, body and spacing for both. */
function CatalogueCard({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          {icon}
          {title}
        </h2>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </header>
      {children}
    </section>
  );
}

/** Read-only list (used for the trade catalogue when the viewer cannot manage it, and for the item catalogue). */
function ReadOnlyList({
  rows,
  emptyText,
}: {
  rows: { id: number; name: string; depth: number }[];
  emptyText: string;
}) {
  if (rows.length === 0)
    return <p className="py-10 text-center text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <ul className="py-1">
      {rows.map((c) => (
        <li
          key={c.id}
          className="border-b border-border py-2 pe-4 text-sm last:border-0"
          style={{ paddingInlineStart: 16 + c.depth * 24 }}
        >
          <span className={c.depth > 0 ? "text-muted-foreground" : "font-semibold text-foreground"}>
            {c.name}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * «التصنيفات» — the catalogue screen.
 *
 * Two catalogues with different purposes, shown as two cards with the same
 * structure so the difference is about content, not layout:
 *   • التصنيفات التجارية — how we GROUP suppliers. Managed here (admin/manager).
 *   • تصنيفات البنود — what a supplier can SUPPLY. Learned automatically from
 *     quotes and purchase orders, so it is read-only here.
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
    <div className="space-y-4 px-4 py-4 sm:px-6">
      <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
        <Tag size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
        <div className="text-xs leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">{t("sup.cat.kind.title")}</p>
          <p>{t("sup.cat.kind.body")}</p>
        </div>
      </div>

      <CatalogueCard
        icon={<Tag size={14} className="text-primary" aria-hidden />}
        title={t("sup.cat.trade.heading")}
        description={canManage ? t("sup.cat.trade.manage") : t("sup.cat.trade.viewOnly")}
      >
        {canManage ? (
          <TradeCategoryManager />
        ) : (
          <ReadOnlyList rows={orderedTrade} emptyText={t("sup.cat.empty")} />
        )}
      </CatalogueCard>

      <CatalogueCard
        icon={<Boxes size={14} className="text-emerald-600" aria-hidden />}
        title={t("sup.cat.item.heading")}
        description={t("sup.cat.learnHint")}
      >
        <div className="border-b border-border px-4 py-3">
          <div className="relative max-w-xs">
            <Search
              size={14}
              aria-hidden
              className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("sup.cat.item.search")}
              aria-label={t("sup.cat.item.search")}
              className="h-8 pr-8 text-sm"
            />
          </div>
        </div>
        {isLoading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t("sup.loading")}</p>
        ) : (
          <ReadOnlyList rows={orderedItem} emptyText={t("sup.cat.empty")} />
        )}
      </CatalogueCard>
    </div>
  );
}

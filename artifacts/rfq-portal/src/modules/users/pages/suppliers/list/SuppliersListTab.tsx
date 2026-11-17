import { Plus, Search, Settings, Filter, Users } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLanguage } from "@/contexts/LanguageContext";
import { SupplierListToolbar } from "./supplier-list-toolbar";
import { SupplierTable } from "./supplier-table";
import { SupplierCardList } from "./supplier-cards";
import { EvidenceLegend } from "./supplier-display";
import { useSupplierList } from "./use-supplier-list";

/** The suppliers directory: header, filters, and the list (table on desktop, cards on phones). */
export function SuppliersListTab({ onOpenCategories }: { onOpenCategories: () => void }) {
  const { t } = useLanguage();
  const [, navigate] = useLocation();
  const list = useSupplierList();
  const { suppliers, isLoading, hasFilter, clearFilters } = list;

  const openSupplier = (id: number) => navigate(`/suppliers/${id}`);
  const goNew = () => navigate("/suppliers/new");

  return (
    <div className="space-y-4 px-4 pt-4 pb-6 sm:px-6 sm:pt-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">{t("sup.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("sup.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onOpenCategories}>
            <Settings size={14} /> {t("sup.tab.categories")}
          </Button>
          <Button size="sm" className="gap-1.5" onClick={goNew}>
            <Plus size={15} /> {t("sup.add")}
          </Button>
        </div>
      </header>

      <SupplierListToolbar
        t={t}
        search={list.search}
        onSearch={list.setSearch}
        tradeOptions={list.tradeCategories}
        tradeLabel={list.tradeCategory === "all" ? null : list.tradeCategory}
        onPickTrade={list.setTradeCategory}
        onClearTrade={() => list.setTradeCategory("all")}
        itemOptions={list.itemCategories}
        itemLabel={
          list.itemCategoryId === "all"
            ? null
            : (list.itemCategories.find((c) => c.id === list.itemCategoryId)?.name ?? null)
        }
        onPickItem={list.setItemCategoryId}
        onClearItem={() => list.setItemCategoryId("all")}
        hasFilter={hasFilter}
        onClearAll={clearFilters}
        countLabel={isLoading ? t("sup.loading") : t("sup.count", { n: suppliers.length })}
        isLoading={isLoading}
        stats={list.stats}
      />

      <section className="overflow-hidden rounded-lg border border-border bg-card">
        {isLoading ? (
          <div className="space-y-3 p-4" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : suppliers.length === 0 ? (
          <div className="flex flex-col items-center p-12 text-center">
            <Users size={36} className="mb-3 text-muted-foreground/40" aria-hidden />
            <p className="text-sm text-muted-foreground">
              {hasFilter ? t("sup.emptyFiltered") : t("sup.empty")}
            </p>
            {hasFilter ? (
              <Button variant="outline" size="sm" className="mt-3 gap-1.5" onClick={clearFilters}>
                <Filter size={14} /> {t("sup.clearFilters")}
              </Button>
            ) : (
              <Button size="sm" className="mt-3 gap-1.5" onClick={goNew}>
                <Plus size={14} /> {t("sup.add")}
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <SupplierTable t={t} suppliers={suppliers} onOpen={openSupplier} />
            </div>
            <div className="lg:hidden">
              <SupplierCardList t={t} suppliers={suppliers} onOpen={openSupplier} />
            </div>
            <div className="border-t border-border bg-muted/20 px-4 py-2.5">
              <EvidenceLegend t={t} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
